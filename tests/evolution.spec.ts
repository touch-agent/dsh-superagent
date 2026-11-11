/**
 * The offline evolution loop: aggregation by effective configuration and task family, structured
 * diagnoses with evidence, low-confidence and no-sample downgrades, the pre-registered holdout gate,
 * the "only a proposal" guarantee, the rollback pointer, and deterministic CLI replay.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import * as evolution from '../scripts/evolution/core.ts'
import {
  EVAL_SET_SCHEMA,
  INTENT_SCHEMA,
  SAMPLE_SCHEMA,
  EvolutionInputError,
  parseEvalResults,
  parseEvalSet,
  parseIntents,
  parseSampleSet,
  requiredSampleSize,
  runEvolution,
  samplesFromTickets,
  type EvalResults,
  type EvalSetManifest,
  type EvolutionSample,
  type ProposalIntent,
  type ReplayEvidence,
  type ReplayOutcome,
  type SampleSet,
} from '../scripts/evolution/core.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AT = '2026-11-10T12:00:00.000Z'
const ENVIRONMENT = { dshVersion: '0.2.1-rc.5', policyVersion: 'policy-1' }
const CANDIDATE = { id: 'worker-docs', revision: 2, effectiveHash: 'sha256:candidate', moving: false, fallback: false }
const BASELINE = { id: 'worker-default', revision: 1, effectiveHash: 'sha256:baseline', moving: false, fallback: false }
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

/** One root sample with an explicit configuration; the review and token fields stay honest by default. */
function sample(id: string, profile: EvolutionSample['profile'], overrides: Partial<EvolutionSample> = {}): EvolutionSample {
  return {
    id,
    profile,
    taskFamily: 'docs/tracked',
    kind: 'root',
    form: 'tracked',
    ended: { outcome: 'completed', at: AT },
    childAccepted: null,
    reworked: false,
    review: { reviewed: true, accepted: true, comments: 2 },
    failure: { state: null, reasonCode: null },
    latency: { decisionToDispatchSeconds: 1, dispatchToReadySeconds: 100, readyToEndSeconds: 2 },
    tokens: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 10 },
    notifications: 1,
    environment: { ...ENVIRONMENT, source: 'github' },
    ...overrides,
  }
}

/** A group of samples with a fixed success count; the remainder close without a merge. */
function group(prefix: string, profile: EvolutionSample['profile'], total: number, successes: number): EvolutionSample[] {
  return Array.from({ length: total }, (_, index) => sample(`${prefix}-${index}`, profile, {
    ended: { outcome: index < successes ? 'completed' : 'closed', at: AT },
  }))
}

/** A sample set with a fixed window, so two runs are byte-identical. */
function sampleSet(records: EvolutionSample[]): SampleSet {
  return { schema: SAMPLE_SCHEMA, generatedAt: AT, source: 'test', window: { from: AT, to: AT }, records }
}

/** A 360-entry holdout set: enough for the 60% baseline and a 10pp MDE. */
function evalSet(overrides: Partial<EvalSetManifest> = {}): EvalSetManifest {
  return {
    schema: EVAL_SET_SCHEMA,
    id: 'docs-v1',
    revision: 1,
    createdAt: AT,
    environment: { ...ENVIRONMENT, repoBaseline: 'abc123' },
    privacy: { containsPrivate: false, location: 'repo-fixture', retentionDays: 30 },
    sideEffects: { externalWrites: false, push: false, send: false, merge: false },
    entries: Array.from({ length: 360 }, (_, index) => ({
      id: `eval-${index}`, taskFamily: 'docs/tracked', form: 'tracked' as const, holdout: true,
      replay: 'dry' as const, rubric: 'rule' as const, timeoutSeconds: 60,
    })),
    ...overrides,
  }
}

/** The pre-registered candidate experience used by the gate tests. */
function intent(overrides: Partial<ProposalIntent> = {}): ProposalIntent {
  return {
    id: 'exp-docs',
    profileId: 'worker-docs',
    baseRevision: 1,
    proposedRevision: 2,
    taskFamily: 'docs/tracked',
    form: 'tracked',
    baseline: { kind: 'profile', profileId: 'worker-default', revision: 1 },
    hypothesis: 'A read-only tool list lowers docs rework without lowering root success.',
    diff: { tools: { mode: 'list', names: ['read', 'grep', 'bash'] } },
    experiment: {
      mde: 0.1,
      alpha: 0.05,
      power: 0.8,
      allocation: 'paired-replay',
      evalSet: { id: 'docs-v1', revision: 1 },
      guardrails: { reworkRate: 0.05, blockedRate: 0.05, p90DispatchToReadySeconds: 600, reviewRejectionRate: 0.05, tokenGrowthRate: 0.25 },
      stopping: { afterSamples: 360, rule: 'Stop after the pre-registered sample and read the single primary metric once.' },
    },
    ...overrides,
  }
}

/** One replay outcome; null tokens mean the harness could not report usage. */
function outcome(success: boolean, overrides: Partial<ReplayOutcome> = {}): ReplayOutcome {
  return { success, reworked: false, blocked: false, failed: false, reviewRejected: false, dispatchToReadySeconds: 100, tokens: null, ...overrides }
}

/** A paired replay where the candidate wins 258 of 360 against a 216 baseline. */
function passEvidence(): ReplayEvidence {
  return {
    id: 'exp-docs',
    baseline: 'sha256:baseline',
    candidate: 'sha256:candidate',
    environment: { ...ENVIRONMENT, repoBaseline: 'abc123' },
    allocation: 'paired-replay',
    pairs: Array.from({ length: 360 }, (_, index) => ({
      entryId: `eval-${index}`,
      baseline: outcome(index < 216),
      candidate: outcome(index < 114 || index >= 216),
    })),
  }
}

/** The evidence document around one experiment. */
function evidence(experiment: ReplayEvidence): EvalResults {
  return { schema: 'evolution.eval-results.v1' as EvalResults['schema'], generatedAt: AT, experiments: [experiment] }
}

/** The observation plus the experiment input. */
function input(records: EvolutionSample[] = [...group('candidate', CANDIDATE, 40, 40), ...group('baseline', BASELINE, 40, 24)],
  overrides: { evalSet?: EvalSetManifest; intents?: ProposalIntent[]; evidence?: EvalResults } = {}) {
  return {
    samples: sampleSet(records),
    evalSet: overrides.evalSet ?? evalSet(),
    intents: overrides.intents ?? [intent()],
    evidence: overrides.evidence,
    generatedAt: AT,
  }
}

it('requires the baseline and the MDE to compute the sample size', () => {
  expect(requiredSampleSize(0.5, 0.1, 0.05, 0.8)).toBeGreaterThanOrEqual(380)
  expect(requiredSampleSize(0.5, 0.1, 0.05, 0.8)).toBeLessThanOrEqual(400)
  expect(requiredSampleSize(0.8, 0.05, 0.05, 0.8)).toBeGreaterThanOrEqual(880)
  expect(requiredSampleSize(0.8, 0.05, 0.05, 0.8)).toBeLessThanOrEqual(940)
  expect(requiredSampleSize(0.5, 0.05, 0.05, 0.8)).toBeGreaterThan(requiredSampleSize(0.5, 0.1, 0.05, 0.8))
  expect(() => requiredSampleSize(0, 0, 0.05, 0.8)).toThrow(EvolutionInputError)
  expect(() => requiredSampleSize(1, 0.1, 0.05, 0.8)).toThrow(/baselineAtCeiling/)
})

it('aggregates by effective configuration and task family, keeps legacy separate and reports unknown tokens', () => {
  const groups = runEvolution(input([
    ...group('legacy', null, 10, 5),
    ...group('candidate', CANDIDATE, 10, 8),
    sample('unknown-tokens', CANDIDATE, { tokens: null }),
  ])).observation.groups
  const legacy = groups.find(item => item.key === 'legacy|docs/tracked|tracked')!
  const candidate = groups.find(item => item.key === 'frozen:sha256:candidate|docs/tracked|tracked')!
  expect(legacy.baseline).toBe('legacy')
  expect(candidate.baseline).toBe('worker-docs@2')
  expect(candidate.rootSuccess).toEqual({ n: 11, successes: 9, rate: 9 / 11 })
  // One silent ticket makes the total unknown instead of zero.
  expect(candidate.tokens.state).toBe('unknown')
  expect(candidate.tokens.input).toBeNull()
})

it('records a high-confidence diagnosis with evidence samples, scope and no private text', () => {
  const report = runEvolution(input())
  const diagnosis = report.observation.diagnoses.find(item => item.candidateKey === 'frozen:sha256:candidate|docs/tracked|tracked')!
  expect(diagnosis.confidence).toBe('high')
  expect(diagnosis.withheld).toBeNull()
  expect(diagnosis.evidence.sampleIds.length).toBeGreaterThan(0)
  expect(diagnosis.evidence.window).toEqual({ from: AT, to: AT })
  expect(JSON.stringify(report)).not.toContain('private ticket title')
})

it('downgrades a low-confidence observation instead of proposing it', () => {
  const report = runEvolution(input(
    [...group('candidate', CANDIDATE, 3, 3), ...group('baseline', BASELINE, 3, 1)],
    { intents: [intent()], evidence: { schema: 'evolution.eval-results.v1' as EvalResults['schema'], generatedAt: AT, experiments: [] } },
  ))
  expect(report.proposals).toEqual([])
  expect(report.observation.withheld).toEqual(expect.arrayContaining([{ id: 'exp-docs', reason: 'lowConfidence' }]))
  expect(report.conclusion.kind).toBe('insufficient-evidence')
})

it('downgrades a candidate with no successful root sample instead of treating it as zero', () => {
  const censored = group('candidate', CANDIDATE, 10, 0).map(record => ({ ...record, ended: null }))
  const report = runEvolution(input([...censored, ...group('baseline', BASELINE, 40, 24)], { intents: [intent()] }))
  expect(report.observation.diagnoses.find(entry => entry.candidateKey.includes('candidate'))?.withheld).toBe('noSuccessSample')
  expect(report.proposals).toHaveLength(0)
  expect(report.conclusion.kind).toBe('insufficient-evidence')
})

it('records no-samples as a conclusion rather than a zero or a proposal', () => {
  const report = runEvolution({ samples: sampleSet([]), generatedAt: AT })
  expect(report.proposals).toEqual([])
  expect(report.observation.totals.samples).toBe(0)
  expect(report.conclusion).toMatchObject({ kind: 'insufficient-evidence', reasons: ['noSamples'] })
})

it('refuses private fields and prose-shaped references in a sample set', () => {
  const privateRecord = { ...sample('s1', CANDIDATE), title: 'a private ticket title' }
  expect(() => parseSampleSet(sampleSet([privateRecord as EvolutionSample]))).toThrow(/unexpectedField/)
  const prose = { ...sample('s 1', CANDIDATE) }
  expect(() => parseSampleSet(sampleSet([prose]))).toThrow(/invalidString/)
  expect(() => parseSampleSet({ ...sampleSet([]), records: [{ ...sample('s1', CANDIDATE), summary: 'body' }] })).toThrow(/unexpectedField/)
})

it('refuses a diff that touches authorization, permissions or credentials', () => {
  const body = JSON.parse(JSON.stringify({ schema: INTENT_SCHEMA, intents: [intent()] }))
  body.intents[0].diff = { maxActionLevel: 'send' }
  expect(() => parseIntents(body)).toThrow(/forbiddenDiffField/)
  body.intents[0].diff = { tools: { mode: 'list', names: ['read'] }, approval: { mode: 'always' } }
  expect(() => parseIntents(body)).toThrow(/forbiddenDiffField/)
})

it('builds a proposal with evidence, scope, rollback and a pre-registered experiment, and never applies it', () => {
  const report = runEvolution(input())
  const proposal = report.proposals[0]!
  expect(proposal.status).toBe('pending-evidence')
  expect(proposal.recommendation).toBe('observe-more')
  expect(proposal.diff).toEqual({ tools: { mode: 'list', names: ['read', 'grep', 'bash'] } })
  expect(proposal.expected.requiredPerGroup).toBeGreaterThanOrEqual(356)
  expect(proposal.experiment).toMatchObject({ primaryMetric: 'root-success', mde: 0.1, alpha: 0.05, power: 0.8, allocation: 'paired-replay' })
  expect(proposal.experiment.holdout).toHaveLength(360)
  expect(proposal.rollback).toMatchObject({ baseRevision: 1, proposedRevision: 2, activeRevision: 1,
    operation: 'set-active-pointer-to-baseRevision', preservesBoundTickets: true })
  expect(proposal.applied).toBe(false)
  expect(proposal.liveConfigChange).toBe(false)
  expect(proposal.approval).toEqual({ required: true, status: 'blocked', decidedBy: null, decidedAt: null })
})

it('passes the gate only when the holdout effect reaches the MDE with a positive interval', () => {
  const replay = passEvidence()
  const report = runEvolution(input(undefined, { evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('pass')
  expect(report.proposals[0]?.status).toBe('ready-for-human-approval')
  expect(report.proposals[0]?.recommendation).toBe('adopt')
  expect(report.approvalQueue.items).toHaveLength(1)
  expect(report.approvalQueue.items[0]).toMatchObject({ evidenceRef: 'docs-v1@1#holdout=360',
    candidateEffectiveHash: 'sha256:candidate', baselineEffectiveHash: 'sha256:baseline' })
  expect(report.conclusion.kind).toBe('propose')
})

it('rejects an undersized holdout before it can recommend adoption', () => {
  const replay: ReplayEvidence = {
    ...passEvidence(),
    pairs: Array.from({ length: 30 }, (_, index) => ({ entryId: `eval-${index}`, baseline: outcome(index < 18), candidate: outcome(index < 21) })),
  }
  const smallSet = evalSet({ entries: evalSet().entries.slice(0, 30) })
  const report = runEvolution(input(undefined, { evalSet: smallSet, evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('sampleSize')
  expect(report.proposals[0]?.status).toBe('pending-evidence')
  expect(report.approvalQueue.items).toEqual([])
})

it('rejects a guardrail regression even when the primary metric improves', () => {
  const replay = passEvidence()
  for (const pair of replay.pairs!.slice(0, 100)) pair.candidate.reworked = true
  const report = runEvolution(input(undefined, { evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('reject')
  expect(report.gates[0]?.reasons).toContain('guardrailRegression')
  expect(report.proposals[0]?.status).toBe('not-adopted')
  expect(report.conclusion.kind).toBe('reject')
})

it('refuses an observation window captured under a different environment fingerprint', () => {
  const stale = (records: EvolutionSample[]) => records.map(record => ({ ...record,
    environment: { dshVersion: '0.2.0-old', policyVersion: 'policy-0', source: 'github' } }))
  const report = runEvolution(input([
    ...stale(group('candidate', CANDIDATE, 40, 40)),
    ...stale(group('baseline', BASELINE, 40, 24)),
  ], { evidence: evidence(passEvidence()) }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('observationEnvironmentMismatch')
})

it('rejects a token guardrail regression when usage is available on both sides', () => {
  const replay = passEvidence()
  const tokens = (total: number) => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  for (const pair of replay.pairs!) {
    pair.baseline.tokens = tokens(1000)
    pair.candidate.tokens = tokens(2000)
  }
  const report = runEvolution(input(undefined, { evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('reject')
  expect(report.gates[0]?.reasons).toContain('guardrailRegression')
  expect(report.gates[0]?.statistics?.guardrails.tokensPerRun?.status).toBe('fail')
})

it('allows the no-measurable-difference conclusion after the pre-registered sample', () => {
  const replay: ReplayEvidence = {
    ...passEvidence(),
    pairs: Array.from({ length: 360 }, (_, index) => ({ entryId: `eval-${index}`, baseline: outcome(index < 216), candidate: outcome(index < 216) })),
  }
  const report = runEvolution(input(undefined, { evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('no-difference')
  expect(report.proposals[0]?.status).toBe('not-adopted')
  expect(report.conclusion.kind).toBe('no-measurable-difference')
})

it('refuses replay evidence whose candidate digest is not the proposed configuration', () => {
  const replay = passEvidence()
  replay.candidate = 'sha256:different-candidate'
  const report = runEvolution(input(undefined, { evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('evidenceConfigurationMismatch')
})

it('refuses a holdout that overlaps the observation window', () => {
  const contaminated = evalSet({
    entries: evalSet().entries.map((entry, index) => index === 0 ? { ...entry, id: 'candidate-0' } : entry),
  })
  const replay = passEvidence()
  replay.pairs![0]!.entryId = 'candidate-0'
  const report = runEvolution(input(undefined, { evalSet: contaminated, evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('holdoutOverlap')
})

it('refuses a holdout that does not cover every entry exactly once', () => {
  const replay = passEvidence()
  replay.pairs![replay.pairs!.length - 1]!.entryId = 'eval-0'
  const report = runEvolution(input(undefined, { evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('holdoutCoverage')
})

it('refuses a moving profile or a mismatched baseline as a causal comparison', () => {
  const moving = { ...CANDIDATE, moving: true }
  const movingReport = runEvolution(input([...group('candidate', moving, 40, 40), ...group('baseline', BASELINE, 40, 24)]))
  expect(movingReport.proposals).toEqual([])
  expect(movingReport.observation.withheld).toEqual(expect.arrayContaining([{ id: 'exp-docs', reason: 'notComparable' }]))
  const legacyIntent = intent({ baseline: { kind: 'legacy' } })
  const mismatch = runEvolution(input(undefined, { intents: [legacyIntent] }))
  expect(mismatch.proposals).toEqual([])
  expect(mismatch.observation.withheld).toEqual(expect.arrayContaining([{ id: 'exp-docs', reason: 'baselineMismatch' }]))
})

it('maps raw Ticket records to sanitized samples with rework, review, failure and latency evidence', () => {
  const mapped = samplesFromTickets([
    {
      id: 'hashed-1', form: 'tracked', channels: [{ source: 'github' }], decisionAt: '2026-11-10T11:59:00.000Z',
      ended: { outcome: 'completed', at: '2026-11-10T12:02:00.000Z' },
      assignments: [
        { startedAt: '2026-11-10T11:59:05.000Z', endedReason: 'returned' },
        { startedAt: '2026-11-10T12:00:00.000Z', report: { state: 'ready', at: '2026-11-10T12:01:00.000Z', accepted: { by: 'person' },
          review: { deliverable: { artifact: { revision: 'rev-1' } } } } },
      ],
      inputs: [{ kind: 'resumed', at: '2026-11-10T12:02:00.000Z' }],
      profile: { id: 'worker-docs', revision: 2, effective: { hash: 'sha256:candidate' }, selection: { moving: true, fallback: false } },
      usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 10, messages: 2 },
    },
    {
      id: 'hashed-2', form: 'tracked', channels: [{ source: 'conversation' }], ended: { outcome: 'closed', at: AT },
      assignments: [{ startedAt: '2026-11-10T11:59:00.000Z', endedReason: 'blocked', report: { state: 'blocked', at: AT } }],
    },
  ], { generatedAt: AT, source: 'test', environment: ENVIRONMENT })
  expect(mapped.records[0]).toMatchObject({ kind: 'root', taskFamily: 'github/tracked', reworked: true,
    review: { reviewed: true, accepted: true }, profile: { id: 'worker-docs' },
    latency: { decisionToDispatchSeconds: 5, dispatchToReadySeconds: 115, readyToEndSeconds: 60 } })
  expect(mapped.records[1]).toMatchObject({ taskFamily: 'conversation/tracked', failure: { state: 'blocked', reasonCode: 'blocked' },
    tokens: null, profile: null })
  expect(JSON.stringify(mapped)).not.toMatch(/rev-1|person/)
})

it('refuses a proposal whose base revision is not older than the revision it proposes', () => {
  const report = runEvolution(input(undefined, { intents: [intent({ baseRevision: 3 })] }))
  expect(report.proposals).toHaveLength(0)
  expect(report.observation.withheld).toContainEqual({ id: 'exp-docs', reason: 'invalidRevisionOrder' })
})

it('reports the withheld reason in the conclusion when no gate could run', () => {
  const report = runEvolution(input(undefined, { intents: [intent({ proposedRevision: 3 })] }))
  expect(report.gates).toHaveLength(0)
  expect(report.conclusion.kind).toBe('insufficient-evidence')
  expect(report.conclusion.reasons).toContain('noCandidateSamples')
})

it('does not read a result before the pre-registered stopping sample', () => {
  const experiment = intent().experiment
  const report = runEvolution(input(undefined, {
    intents: [intent({ experiment: { ...experiment, stopping: { afterSamples: 1000, rule: 'Wait for 1000 pairs.' } } })],
    evidence: evidence(passEvidence()),
  }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('stoppingNotReached')
})

it('treats an unavailable p90 guardrail as insufficient, while allowing unknown token usage', () => {
  const replay = passEvidence()
  for (const pair of replay.pairs!) pair.candidate.dispatchToReadySeconds = null
  for (const pair of replay.pairs!) pair.baseline.dispatchToReadySeconds = null
  const report = runEvolution(input(undefined, { evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('guardrailUnknown')
})

it('refuses a diff that leaves the prompt, model or tools moving', () => {
  expect(() => parseIntents({ schema: INTENT_SCHEMA, intents: [intent({ diff: { prompt: { mode: 'live' } } })] })).toThrow(/movingDiff/)
  expect(() => parseIntents({ schema: INTENT_SCHEMA, intents: [intent({ diff: { tools: { mode: 'inherit' } } })] })).toThrow(/movingDiff/)
})

it('detects a holdout entry that carries the hashed observation reference of an observed Ticket', () => {
  const set = evalSet()
  set.entries[0] = { ...set.entries[0]!, observationRef: 'candidate-0' }
  const report = runEvolution(input(undefined, { evalSet: set, evidence: evidence(passEvidence()) }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('holdoutOverlap')
})

it('records a moving worker-default baseline as descriptive, not as a causal proposal', () => {
  const movingBaseline = { ...BASELINE, moving: true, runEffectiveHash: 'sha256:run-1' }
  const report = runEvolution(input([...group('candidate', CANDIDATE, 40, 40), ...group('baseline', movingBaseline, 40, 24)],
    { evidence: evidence(passEvidence()) }))
  const diagnosis = report.observation.diagnoses.find(entry => entry.candidateKey.includes('candidate'))
  expect(diagnosis?.baselineKey).toContain('sha256:run-1')
  expect(diagnosis?.withheld).toBe('notComparable')
  expect(report.proposals).toHaveLength(0)
})

it('runs the randomized allocation through the same gate', () => {
  const set = evalSet({ entries: Array.from({ length: 720 }, (_, index) => ({
    id: `eval-${index}`, taskFamily: 'docs/tracked', form: 'tracked' as const, holdout: true,
    replay: 'dry' as const, rubric: 'rule' as const, timeoutSeconds: 60,
  })) })
  const randomized: ReplayEvidence = {
    id: 'exp-docs', baseline: 'sha256:baseline', candidate: 'sha256:candidate',
    environment: { ...ENVIRONMENT, repoBaseline: 'abc123' }, allocation: 'randomized',
    runs: Array.from({ length: 720 }, (_, index) => ({
      entryId: `eval-${index}`,
      group: index < 360 ? 'candidate' as const : 'baseline' as const,
      outcome: outcome(index < 360 ? index < 300 : index < 576),
    })),
  }
  const experiment = intent().experiment
  const report = runEvolution(input(undefined, { evalSet: set, intents: [intent({ experiment: { ...experiment, allocation: 'randomized' } })], evidence: evidence(randomized) }))
  expect(report.gates[0]?.outcome).toBe('pass')
  expect(report.gates[0]?.statistics?.candidate.n).toBe(360)
  expect(report.gates[0]?.statistics?.baseline.n).toBe(360)
})

it('maps a child delegation resolution and reports the ready-to-end latency', () => {
  const mapped = samplesFromTickets([{
    id: 'child-1', form: 'tracked', parentTicketId: 'root-1', channels: [{ source: 'github' }],
    ended: { outcome: 'completed', at: AT }, delegation: { resolution: { kind: 'accepted' } },
    assignments: [{ startedAt: '2026-11-10T11:00:00.000Z', report: { state: 'ready', at: '2026-11-10T11:10:00.000Z' } }],
  }], { generatedAt: AT, source: 'test', environment: ENVIRONMENT })
  expect(mapped.records[0]?.childAccepted).toBe(true)
  const group = runEvolution(input([mapped.records[0]!], { intents: [] })).observation.groups[0]!
  expect(group.childSuccess).toMatchObject({ n: 1, successes: 1 })
  expect(group.latency.readyToEnd).toMatchObject({ samples: 1, p50Seconds: 3000, p90Seconds: 3000 })
})

it('labels proposal prose as author-supplied instead of claiming all text is refused', () => {
  const report = runEvolution(input(undefined, { intents: [intent({ hypothesis: 'PRIVATE TITLE' })], evidence: evidence(passEvidence()) }))
  expect(JSON.stringify(report)).toContain('PRIVATE TITLE')
  expect(report.guarantees.samplePrivateText).toBe('refused')
  expect(report.guarantees.proposalText).toBe('author-supplied')
})

it('uses the pre-registered alpha for the interval instead of a fixed 95 percent', () => {
  const experiment = intent().experiment
  const report = runEvolution(input(undefined, {
    intents: [intent({ experiment: { ...experiment, alpha: 0.1 } })], evidence: evidence(passEvidence()),
  }))
  expect(report.gates[0]?.outcome).toBe('pass')
  expect(report.gates[0]?.statistics?.ci.level).toBeCloseTo(0.9)
})

it('rejects a failed outcome even when the primary success metric improves', () => {
  const replay = passEvidence()
  for (let index = 0; index < 30; index += 1) {
    replay.pairs![index] = { ...replay.pairs![index]!, candidate: { ...replay.pairs![index]!.candidate, failed: true } }
  }
  const report = runEvolution(input(undefined, { evidence: evidence(replay) }))
  expect(report.gates[0]?.outcome).toBe('reject')
  expect(report.gates[0]?.reasons).toContain('guardrailRegression')
})

it('refuses an eval set with no holdout entry', () => {
  const set = evalSet()
  set.entries = set.entries.map(entry => ({ ...entry, holdout: false }))
  const report = runEvolution(input(undefined, { evalSet: set, evidence: evidence(passEvidence()) }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('noHoldout')
})

it('refuses a stopping plan below the required sample size', () => {
  const experiment = intent().experiment
  const report = runEvolution(input(undefined, {
    intents: [intent({ experiment: { ...experiment, stopping: { afterSamples: 100, rule: 'Too early.' } } })],
    evidence: evidence(passEvidence()),
  }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('stoppingBeforePower')
})

it('refuses evidence whose allocation differs from the pre-registered plan', () => {
  const experiment = intent().experiment
  const report = runEvolution(input(undefined, {
    intents: [intent({ experiment: { ...experiment, allocation: 'randomized' } })], evidence: evidence(passEvidence()),
  }))
  expect(report.gates[0]?.outcome).toBe('insufficient')
  expect(report.gates[0]?.reasons).toContain('allocationMismatch')
})

it('is deterministic and exposes no write, apply, save or activate path', () => {
  const first = runEvolution(input(undefined, { evidence: evidence(passEvidence()) }))
  const second = runEvolution(input(undefined, { evidence: evidence(passEvidence()) }))
  expect(second).toEqual(first)
  const source = readFileSync(join(ROOT, 'scripts', 'evolution', 'core.ts'), 'utf8')
  expect(source).not.toMatch(/from ['"](?:node:fs|node:fs\/promises|node:child_process|node:http|node:https|node:net|node:tls|@superagent)/)
  expect(source).not.toMatch(/writeFile|createWriteStream|fetch\(/)
  expect(source).not.toMatch(/function (?:apply|write|save|activate)[A-Z]/)
  expect(Object.keys(evolution).filter(name => /apply|write|save|activate/i.test(name))).toEqual([])
  for (const proposal of first.proposals) {
    expect(proposal.applied).toBe(false)
    expect(proposal.approval.decidedBy).toBeNull()
    expect(proposal.rollback.baseRevision).toBe(1)
  }
})

it('replays the CLI byte-identically into an operator-chosen directory only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'evolution-cli-'))
  directories.push(directory)
  const samplesPath = join(directory, 'samples.json')
  const evalSetPath = join(directory, 'evalset.json')
  const intentsPath = join(directory, 'intents.json')
  const evidencePath = join(directory, 'evidence.json')
  writeFileSync(samplesPath, JSON.stringify(sampleSet([...group('candidate', CANDIDATE, 40, 40), ...group('baseline', BASELINE, 40, 24)])))
  writeFileSync(evalSetPath, JSON.stringify(evalSet()))
  writeFileSync(intentsPath, JSON.stringify({ schema: INTENT_SCHEMA, intents: [intent()] }))
  writeFileSync(evidencePath, JSON.stringify(evidence(passEvidence())))
  const outputs = ['first', 'second'].map(name => join(directory, name))
  for (const out of outputs) {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'evolution', 'run.mjs'), '--samples', samplesPath, '--evalset', evalSetPath,
      '--intents', intentsPath, '--evidence', evidencePath, '--out', out], { cwd: ROOT, stdio: 'pipe' })
  }
  expect(readFileSync(join(outputs[0]!, 'report.json'), 'utf8')).toBe(readFileSync(join(outputs[1]!, 'report.json'), 'utf8'))
  expect(readdirSync(outputs[0]!).sort()).toEqual(['approval-queue.json', 'report.json'])
  const report = JSON.parse(readFileSync(join(outputs[0]!, 'report.json'), 'utf8'))
  expect(report.conclusion.kind).toBe('propose')
  expect(report.guarantees).toEqual({ liveConfiguration: 'unchanged', autoApply: false, authorizationFields: 'refused', samplePrivateText: 'refused', proposalText: 'author-supplied', externalCredentials: false })
})

it('exports the live Ticket shape read-only into hashed, text-free samples', () => {
  const directory = mkdtempSync(join(tmpdir(), 'evolution-export-'))
  directories.push(directory)
  const database = join(directory, 'orchestrator.sqlite')
  const output = join(directory, 'samples.json')
  const store = new DatabaseSync(database)
  store.exec('CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE decision (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const ticket = {
    id: 'raw-ticket-id', title: 'private title', form: 'tracked', channels: [{ source: 'github' }], decisionId: 'd1',
    ended: { at: '2026-11-10T12:02:00.000Z', outcome: 'completed' },
    assignments: [
      { startedAt: '2026-11-10T11:59:05.000Z', endedReason: 'returned' },
      { startedAt: '2026-11-10T12:00:00.000Z', report: { state: 'ready', at: '2026-11-10T12:01:00.000Z', accepted: { by: 'person' },
        review: { deliverable: { artifact: { revision: 'rev-1' } } } } },
    ],
    inputs: [{ kind: 'resumed', at: '2026-11-10T12:02:00.000Z' }],
    profile: { id: 'worker-docs', revision: 2, effective: { hash: 'sha256:candidate' }, selection: { moving: true, fallback: false } },
  }
  store.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(ticket.id, JSON.stringify(ticket))
  store.prepare('INSERT INTO decision (id, value) VALUES (?, ?)').run('d1', JSON.stringify({ id: 'd1', at: '2026-11-10T11:59:00.000Z' }))
  store.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('session-usage:worker-raw-ticket-id',
    JSON.stringify({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 10, messages: 2 }))
  store.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('session-effective:worker-raw-ticket-id',
    JSON.stringify({ hash: 'sha256:run-1' }))
  store.close()
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'evolution', 'export.mjs'), '--db', database, '--out', output,
    '--limit', '10', '--at', AT, '--dsh-version', ENVIRONMENT.dshVersion, '--policy-version', ENVIRONMENT.policyVersion], { cwd: ROOT, stdio: 'pipe' })
  const parsed = parseSampleSet(JSON.parse(readFileSync(output, 'utf8')))
  expect(parsed.records).toHaveLength(1)
  const record = parsed.records[0]!
  expect(record.id).toMatch(/^[0-9a-f]{16}$/)
  expect(record.id).not.toBe('raw-ticket-id')
  expect(record).toMatchObject({ taskFamily: 'github/tracked', reworked: true, review: { reviewed: true, accepted: true },
    profile: { id: 'worker-docs', revision: 2, runEffectiveHash: 'sha256:run-1', moving: true }, latency: { decisionToDispatchSeconds: 5, dispatchToReadySeconds: 115, readyToEndSeconds: 60 },
    tokens: { input: 1000, output: 200 } })
  expect(JSON.stringify(parsed)).not.toMatch(/private title|rev-1|raw-ticket-id|person/)
})

it('parses the eval set and evidence without inventing a cost gate', () => {
  const manifest = parseEvalSet(evalSet())
  expect(manifest.privacy.containsPrivate).toBe(false)
  expect(manifest.sideEffects).toEqual({ externalWrites: false, push: false, send: false, merge: false })
  const results = parseEvalResults(evidence(passEvidence()))
  expect(results.experiments[0]?.pairs).toHaveLength(360)
  expect(() => parseEvalSet({ ...evalSet(), privacy: { containsPrivate: true, location: 'x', retentionDays: 1 } })).toThrow(/privateEvalSet/)
  expect(() => parseEvalSet({ ...evalSet(), sideEffects: { externalWrites: true, push: false, send: false, merge: false } })).toThrow(/sideEffectEvalSet/)
})