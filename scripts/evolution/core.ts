/**
 * The offline evolution loop's pure core: observe sanitized run samples, aggregate them by effective
 * configuration and task family, record structured diagnoses, validate versioned proposals, and judge a
 * pre-registered holdout replay at the regression gate.
 *
 * This module has no filesystem, network, Store or profile-registry dependency. Every function returns
 * data; nothing here can save a profile, activate a revision, write a decision or reach a live
 * configuration. `scripts/evolution/run.mjs` writes the returned report into an operator-chosen
 * directory, and only a person can turn an approved proposal into a new immutable profile revision with
 * the existing panel/registry path.
 */

export const SAMPLE_SCHEMA = 'evolution.samples.v1'
export const EVAL_SET_SCHEMA = 'evolution.evalset.v1'
export const INTENT_SCHEMA = 'evolution.intents.v1'
export const EVIDENCE_SCHEMA = 'evolution.eval-results.v1'
export const REPORT_SCHEMA = 'evolution.report.v1'
export const QUEUE_SCHEMA = 'evolution.approval-queue.v1'

/** A malformed, private or unsupported input; the code is stable enough for a test and a CLI message. */
export class EvolutionInputError extends Error {
  /** `code` names the violated rule without quoting the rejected value. */
  code: string
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'EvolutionInputError'
    this.code = code
  }
}

export type SampleKind = 'root' | 'child' | 'lightweight'
export type SampleForm = 'tracked' | 'lightweight'
export type SampleOutcome = 'completed' | 'merged' | 'closed' | 'stopped' | 'dropped'
export type FailureState = 'blocked' | 'failed' | 'stopped' | 'dropped' | null
export type Confidence = 'low' | 'medium' | 'high'
export type Allocation = 'paired-replay' | 'randomized'

/** One sanitized historical run. It carries counts, codes and opaque references, never message text. */
export interface EvolutionSample {
  id: string
  profile: { id: string; revision: number; effectiveHash: string; moving: boolean; fallback: boolean } | null
  taskFamily: string
  kind: SampleKind
  form: SampleForm
  ended: { outcome: SampleOutcome; at: string } | null
  reworked: boolean
  review: { reviewed: boolean; accepted: boolean; comments: number | null }
  failure: { state: FailureState; reasonCode: string | null }
  latency: { decisionToDispatchSeconds: number | null; dispatchToReadySeconds: number | null; readyToEndSeconds: number | null }
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number } | null
  notifications: number | null
  environment: { dshVersion: string; policyVersion: string; source: string }
}

/** The read-only observation set an operator exports before analysis. */
export interface SampleSet {
  schema: typeof SAMPLE_SCHEMA
  generatedAt: string
  source: string
  window: { from: string; to: string }
  records: EvolutionSample[]
}

/** One eval-set entry; only a holdout entry may judge a proposal. */
export interface EvalSetEntry {
  id: string
  taskFamily: string
  form: SampleForm
  holdout: boolean
  replay: 'dry' | 'sandbox' | 'human'
  rubric: 'rule' | 'human'
  timeoutSeconds: number
}

/** A versioned eval-set manifest. It must be safe to replay offline and must not contain private text. */
export interface EvalSetManifest {
  schema: typeof EVAL_SET_SCHEMA
  id: string
  revision: number
  createdAt: string
  environment: { dshVersion: string; policyVersion: string; repoBaseline: string | null }
  privacy: { containsPrivate: false; location: string; retentionDays: number }
  sideEffects: { externalWrites: false; push: false; send: false; merge: false }
  entries: EvalSetEntry[]
}

/** The only profile content a proposal may change. Authorization, credentials and lifecycle fields are refused. */
export interface ProfileDiff {
  title?: string
  description?: string
  model?: { mode: 'inherit' } | { mode: 'pinned'; provider: string; model: string; reasoningEffort?: string }
  tools?: { mode: 'inherit' } | { mode: 'list'; names: string[] }
  prompt?: { mode: 'live' } | { mode: 'pinned'; revision: number }
  evalBaseline?: { evalSet: string; revision: number }
}

/** A structured candidate experience. A person or analysis author supplies the diff; this loop never writes prompt text. */
export interface ProposalIntent {
  id: string
  profileId: string
  baseRevision: number
  proposedRevision: number
  taskFamily: string
  form: SampleForm
  baseline: { kind: 'legacy' } | { kind: 'profile'; profileId: string; revision: number }
  hypothesis: string
  diff: ProfileDiff
  experiment: {
    mde: number
    alpha: number
    power: number
    allocation: Allocation
    evalSet: { id: string; revision: number }
    guardrails: { reworkRate: number; blockedRate: number; p90DispatchToReadySeconds: number; reviewRejectionRate: number; tokenGrowthRate: number }
    stopping: { afterSamples: number; rule: string }
  }
}

/** The pre-registered verification plan stored beside every proposal. */
export interface ExperimentPlan {
  id: string
  taskFamily: string
  form: SampleForm
  candidate: { profileId: string; revision: number; effectiveHash: string }
  baseline: { kind: 'legacy' } | { kind: 'profile'; profileId: string; revision: number; effectiveHash: string }
  primaryMetric: 'root-success'
  mde: number
  alpha: number
  power: number
  allocation: Allocation
  evalSet: { id: string; revision: number }
  holdout: string[]
  requiredPerGroup: number
  guardrails: ProposalIntent['experiment']['guardrails']
  stopping: { afterSamples: number; rule: string }
}

/** One outcome a replay produced for one entry. `tokens` is null when the host could not report usage. */
export interface ReplayOutcome {
  success: boolean
  reworked: boolean
  blocked: boolean
  failed: boolean
  reviewRejected: boolean
  dispatchToReadySeconds: number | null
  tokens: EvolutionSample['tokens']
}

/** One experiment's replay results: paired for a paired replay, runs for a randomized allocation. */
export interface ReplayEvidence {
  id: string
  baseline: string
  candidate: string
  environment: { dshVersion: string; policyVersion: string; repoBaseline: string | null }
  allocation: Allocation
  pairs?: { entryId: string; baseline: ReplayOutcome; candidate: ReplayOutcome }[]
  runs?: { entryId: string; group: 'baseline' | 'candidate'; outcome: ReplayOutcome }[]
}

/** The replay evidence document; it is data from a harness, never a live execution path. */
export interface EvalResults {
  schema: typeof EVIDENCE_SCHEMA
  generatedAt: string
  experiments: ReplayEvidence[]
}

/** A rate with its denominator; a missing sample is null rather than a zero. */
export interface Rate {
  n: number
  successes: number
  rate: number | null
}

/** One comparable execution configuration and task family. */
export interface EvolutionGroup {
  key: string
  profile: EvolutionSample['profile']
  baseline: 'legacy' | 'worker-default@1' | string
  taskFamily: string
  form: SampleForm
  moving: boolean
  comparable: boolean
  environments: string[]
  n: number
  roots: number
  children: number
  lightweight: number
  fallback: number
  censored: number
  rootSuccess: Rate
  childSuccess: Rate
  lightweightSuccess: Rate
  closed: number
  blocked: number
  failed: number
  stopped: number
  dropped: number
  failureReasons: Record<string, number>
  rework: Rate
  review: { reviewed: number; accepted: number; unaccepted: number; acceptedRate: number | null; comments: { state: 'available' | 'unknown'; total: number | null } }
  latency: { samples: number; p50Seconds: number | null; p90Seconds: number | null }
  tokens: { state: 'available' | 'unknown'; samples: number; input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null; reasoning: number | null }
  notifications: { state: 'available' | 'unknown'; total: number | null; perResult: number | null }
  sampleIds: string[]
}

/** One candidate-versus-baseline observation, with the evidence and the downgrade reason when withheld. */
export interface EvolutionDiagnosis {
  id: string
  taskFamily: string
  form: SampleForm
  candidateKey: string
  baselineKey: string
  hypothesis: string
  confidence: Confidence
  comparable: boolean
  reasons: string[]
  evidence: {
    candidate: { profile: string; effectiveHash: string; n: number; rate: number | null; reworkRate: number | null; blockedRate: number | null }
    baseline: { profile: string; effectiveHash: string; n: number; rate: number | null; reworkRate: number | null; blockedRate: number | null }
    delta: number | null
    ci: { lower: number; upper: number; level: number } | null
    sampleIds: string[]
    window: { from: string; to: string }
  }
  withheld: string | null
}

/** The gate's verdict. `no-difference` is an informative result, not a failure of the loop. */
export type GateOutcome = 'pass' | 'reject' | 'insufficient' | 'no-difference'

/** The numeric result of one gate, with every check that was available. */
export interface GateResult {
  proposalId: string
  outcome: GateOutcome
  reasons: string[]
  checks: { check: string; status: 'pass' | 'fail' | 'unknown'; detail: string }[]
  requiredPerGroup: number | null
  statistics: {
    method: 'paired-mcnemar' | 'unpaired-z'
    baseline: Rate
    candidate: Rate
    difference: number
    ci: { lower: number; upper: number; level: number }
    pValue: number | null
    guardrails: GuardrailComparison
  } | null
}

/** One guardrail's two group values, its pre-registered threshold and whether it passed. */
export type GuardrailComparison = Record<string, { baseline: number | null; candidate: number | null; threshold: number | null; status: 'pass' | 'fail' | 'unknown' }>

/** A versioned proposal. It is a document; `applied` is always false and `decidedBy` always null here. */
export interface EvolutionProposal {
  schema: 'evolution.proposal.v1'
  id: string
  status: 'pending-evidence' | 'ready-for-human-approval' | 'not-adopted'
  recommendation: 'adopt' | 'do-not-adopt' | 'observe-more'
  hypothesis: string
  confidence: Confidence
  evidence: EvolutionDiagnosis['evidence'] & { evalSet: { id: string; revision: number }; holdout: string[] }
  scope: { taskFamily: string; form: SampleForm; profileId: string; appliesTo: 'new-tickets-only' }
  expected: { primaryMetric: 'root-success'; baselineRate: number | null; candidateRate: number | null; absoluteDelta: number | null; mde: number; requiredPerGroup: number }
  risks: string[]
  rollback: { baseRevision: number; proposedRevision: number; activeRevision: number; operation: 'set-active-pointer-to-baseRevision'; preservesBoundTickets: true; condition: string }
  baseRevision: number
  proposedRevision: number
  diff: ProfileDiff
  experiment: ExperimentPlan
  gate: GateResult
  approval: { required: true; status: 'pending' | 'blocked' | 'not-requested'; decidedBy: null; decidedAt: null }
  applied: false
  liveConfigChange: false
}

/** The human approval queue is a document; it has no write endpoint and no auto-apply path. */
export interface ApprovalQueue {
  schema: typeof QUEUE_SCHEMA
  storage: 'document'
  generatedAt: string
  status: 'pending-human-approval'
  items: { proposalId: string; profileId: string; baseRevision: number; proposedRevision: number; evidenceRef: string; requestedAt: string }[]
  note: string
}

/** The complete offline run; it is JSON-serializable and deterministic for fixed input. */
export interface EvolutionReport {
  schema: typeof REPORT_SCHEMA
  generatedAt: string
  inputs: { samples: number; evalSet: string | null; intents: number; experiments: number }
  observation: {
    totals: { groups: number; samples: number; roots: number; censored: number; legacy: number; profiles: number; moving: number }
    groups: EvolutionGroup[]
    diagnoses: EvolutionDiagnosis[]
    withheld: { id: string; reason: string }[]
  }
  proposals: EvolutionProposal[]
  gates: GateResult[]
  approvalQueue: ApprovalQueue
  conclusion: { kind: 'propose' | 'no-measurable-difference' | 'reject' | 'insufficient-evidence'; summary: string; reasons: string[] }
  guarantees: { liveConfiguration: 'unchanged'; autoApply: false; authorizationFields: 'refused'; privateText: 'refused'; externalCredentials: false }
}

/** Everything one run needs; every field is already parsed, sanitized data. */
export interface EvolutionInput {
  samples: SampleSet
  evalSet?: EvalSetManifest
  intents?: ProposalIntent[]
  evidence?: EvalResults
  generatedAt?: string
}

const OUTCOMES = new Set<SampleOutcome>(['completed', 'merged', 'closed', 'stopped', 'dropped'])
const KINDS = new Set<SampleKind>(['root', 'child', 'lightweight'])
const FORMS = new Set<SampleForm>(['tracked', 'lightweight'])
const REPLAYS = new Set<EvalSetEntry['replay']>(['dry', 'sandbox', 'human'])
const RUBRICS = new Set<EvalSetEntry['rubric']>(['rule', 'human'])
const ALLOCATIONS = new Set<Allocation>(['paired-replay', 'randomized'])
const FAILURES = new Set<FailureState>(['blocked', 'failed', 'stopped', 'dropped', null])
/** A stable opaque reference: no spaces, prose or punctuation that could smuggle message text. */
const REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
/** A task family is a short category, never a title. */
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/
/** A reason code, not a free-text reason. */
const CODE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
/** Environment strings are versions and identifiers, not prose. */
const ENV = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Refuse an object key the schema does not name; this is the privacy boundary for sample and proposal input. */
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new EvolutionInputError('unexpectedField', `${path}.${key}`)
  }
}

/** A required string matching one safe shape. */
function stringAt(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new EvolutionInputError('invalidString', path)
  return value
}

/** An ISO instant, kept as text so the report is deterministic and comparable. */
function instantAt(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new EvolutionInputError('invalidInstant', path)
  }
  return value
}

/** A finite number inside a closed range; integers are required where the caller asks. */
function numberAt(value: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new EvolutionInputError('invalidNumber', path)
  }
  return value
}

/** A nullable non-negative latency or count. */
function nullableNumber(value: unknown, path: string): number | null {
  if (value === null) return null
  return numberAt(value, path, 0, 1_000_000_000)
}

/** A strict boolean. */
function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new EvolutionInputError('invalidBoolean', path)
  return value
}

/** Parse one sanitized sample and refuse anything else. */
function sampleAt(value: unknown, index: number): EvolutionSample {
  const path = `records[${index}]`
  if (!isRecord(value)) throw new EvolutionInputError('invalidSample', path)
  onlyKeys(value, ['id', 'profile', 'taskFamily', 'kind', 'form', 'ended', 'reworked', 'review', 'failure', 'latency', 'tokens', 'notifications', 'environment'], path)
  const id = stringAt(value.id, `${path}.id`, REF)
  const taskFamily = stringAt(value.taskFamily, `${path}.taskFamily`, FAMILY)
  if (typeof value.kind !== 'string' || !KINDS.has(value.kind as SampleKind)) throw new EvolutionInputError('invalidKind', `${path}.kind`)
  if (typeof value.form !== 'string' || !FORMS.has(value.form as SampleForm)) throw new EvolutionInputError('invalidForm', `${path}.form`)
  const kind = value.kind as SampleKind
  const form = value.form as SampleForm
  if ((kind === 'lightweight') !== (form === 'lightweight')) throw new EvolutionInputError('formKindMismatch', path)
  let profile: EvolutionSample['profile'] = null
  if (value.profile !== null) {
    if (!isRecord(value.profile)) throw new EvolutionInputError('invalidProfile', `${path}.profile`)
    onlyKeys(value.profile, ['id', 'revision', 'effectiveHash', 'moving', 'fallback'], `${path}.profile`)
    profile = {
      id: stringAt(value.profile.id, `${path}.profile.id`, REF),
      revision: numberAt(value.profile.revision, `${path}.profile.revision`, 1, 1_000_000, true),
      effectiveHash: stringAt(value.profile.effectiveHash, `${path}.profile.effectiveHash`, ENV),
      moving: booleanAt(value.profile.moving, `${path}.profile.moving`),
      fallback: booleanAt(value.profile.fallback, `${path}.profile.fallback`),
    }
  }
  let ended: EvolutionSample['ended'] = null
  if (value.ended !== null) {
    if (!isRecord(value.ended)) throw new EvolutionInputError('invalidEnded', `${path}.ended`)
    onlyKeys(value.ended, ['outcome', 'at'], `${path}.ended`)
    if (typeof value.ended.outcome !== 'string' || !OUTCOMES.has(value.ended.outcome as SampleOutcome)) {
      throw new EvolutionInputError('invalidOutcome', `${path}.ended.outcome`)
    }
    ended = { outcome: value.ended.outcome as SampleOutcome, at: instantAt(value.ended.at, `${path}.ended.at`) }
  }
  if (!isRecord(value.review)) throw new EvolutionInputError('invalidReview', `${path}.review`)
  onlyKeys(value.review, ['reviewed', 'accepted', 'comments'], `${path}.review`)
  if (!isRecord(value.failure)) throw new EvolutionInputError('invalidFailure', `${path}.failure`)
  onlyKeys(value.failure, ['state', 'reasonCode'], `${path}.failure`)
  if (!(value.failure.state === null || (typeof value.failure.state === 'string' && FAILURES.has(value.failure.state as FailureState)))) {
    throw new EvolutionInputError('invalidFailureState', `${path}.failure.state`)
  }
  let reasonCode: string | null = null
  if (value.failure.reasonCode !== null) reasonCode = stringAt(value.failure.reasonCode, `${path}.failure.reasonCode`, CODE)
  if (!isRecord(value.latency)) throw new EvolutionInputError('invalidLatency', `${path}.latency`)
  onlyKeys(value.latency, ['decisionToDispatchSeconds', 'dispatchToReadySeconds', 'readyToEndSeconds'], `${path}.latency`)
  let tokens: EvolutionSample['tokens'] = null
  if (value.tokens !== null) {
    if (!isRecord(value.tokens)) throw new EvolutionInputError('invalidTokens', `${path}.tokens`)
    onlyKeys(value.tokens, ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'], `${path}.tokens`)
    tokens = {
      input: numberAt(value.tokens.input, `${path}.tokens.input`, 0, 1_000_000_000, true),
      output: numberAt(value.tokens.output, `${path}.tokens.output`, 0, 1_000_000_000, true),
      cacheRead: numberAt(value.tokens.cacheRead, `${path}.tokens.cacheRead`, 0, 1_000_000_000, true),
      cacheWrite: numberAt(value.tokens.cacheWrite, `${path}.tokens.cacheWrite`, 0, 1_000_000_000, true),
      reasoning: numberAt(value.tokens.reasoning, `${path}.tokens.reasoning`, 0, 1_000_000_000, true),
    }
  }
  if (!isRecord(value.environment)) throw new EvolutionInputError('invalidEnvironment', `${path}.environment`)
  onlyKeys(value.environment, ['dshVersion', 'policyVersion', 'source'], `${path}.environment`)
  return {
    id,
    profile,
    taskFamily,
    kind,
    form,
    ended,
    reworked: booleanAt(value.reworked, `${path}.reworked`),
    review: {
      reviewed: booleanAt(value.review.reviewed, `${path}.review.reviewed`),
      accepted: booleanAt(value.review.accepted, `${path}.review.accepted`),
      comments: nullableNumber(value.review.comments, `${path}.review.comments`),
    },
    failure: { state: value.failure.state as FailureState, reasonCode },
    latency: {
      decisionToDispatchSeconds: nullableNumber(value.latency.decisionToDispatchSeconds, `${path}.latency.decisionToDispatchSeconds`),
      dispatchToReadySeconds: nullableNumber(value.latency.dispatchToReadySeconds, `${path}.latency.dispatchToReadySeconds`),
      readyToEndSeconds: nullableNumber(value.latency.readyToEndSeconds, `${path}.latency.readyToEndSeconds`),
    },
    tokens,
    notifications: nullableNumber(value.notifications, `${path}.notifications`),
    environment: {
      dshVersion: stringAt(value.environment.dshVersion, `${path}.environment.dshVersion`, ENV),
      policyVersion: stringAt(value.environment.policyVersion, `${path}.environment.policyVersion`, ENV),
      source: stringAt(value.environment.source, `${path}.environment.source`, REF),
    },
  }
}

/** Parse an observation set, refusing unknown fields and prose-shaped references. */
export function parseSampleSet(value: unknown): SampleSet {
  if (!isRecord(value)) throw new EvolutionInputError('invalidSampleSet', 'expected an object')
  onlyKeys(value, ['schema', 'generatedAt', 'source', 'window', 'records'], 'sampleSet')
  if (value.schema !== SAMPLE_SCHEMA) throw new EvolutionInputError('unsupportedSchema', 'sampleSet.schema')
  if (!Array.isArray(value.records)) throw new EvolutionInputError('invalidRecords', 'sampleSet.records')
  if (!isRecord(value.window)) throw new EvolutionInputError('invalidWindow', 'sampleSet.window')
  onlyKeys(value.window, ['from', 'to'], 'sampleSet.window')
  const records = value.records.map((record, index) => sampleAt(record, index))
  const ids = new Set<string>()
  for (const record of records) {
    if (ids.has(record.id)) throw new EvolutionInputError('duplicateSample', record.id)
    ids.add(record.id)
  }
  return {
    schema: SAMPLE_SCHEMA,
    generatedAt: instantAt(value.generatedAt, 'sampleSet.generatedAt'),
    source: stringAt(value.source, 'sampleSet.source', REF),
    window: { from: instantAt(value.window.from, 'sampleSet.window.from'), to: instantAt(value.window.to, 'sampleSet.window.to') },
    records,
  }
}

/** Parse an eval-set manifest and refuse a manifest that could smuggle private data or external writes. */
export function parseEvalSet(value: unknown): EvalSetManifest {
  if (!isRecord(value)) throw new EvolutionInputError('invalidEvalSet', 'expected an object')
  onlyKeys(value, ['schema', 'id', 'revision', 'createdAt', 'environment', 'privacy', 'sideEffects', 'entries'], 'evalSet')
  if (value.schema !== EVAL_SET_SCHEMA) throw new EvolutionInputError('unsupportedSchema', 'evalSet.schema')
  if (!isRecord(value.environment)) throw new EvolutionInputError('invalidEnvironment', 'evalSet.environment')
  onlyKeys(value.environment, ['dshVersion', 'policyVersion', 'repoBaseline'], 'evalSet.environment')
  if (!isRecord(value.privacy)) throw new EvolutionInputError('invalidPrivacy', 'evalSet.privacy')
  onlyKeys(value.privacy, ['containsPrivate', 'location', 'retentionDays'], 'evalSet.privacy')
  if (value.privacy.containsPrivate !== false) throw new EvolutionInputError('privateEvalSet', 'evalSet.privacy.containsPrivate')
  if (!isRecord(value.sideEffects)) throw new EvolutionInputError('invalidSideEffects', 'evalSet.sideEffects')
  onlyKeys(value.sideEffects, ['externalWrites', 'push', 'send', 'merge'], 'evalSet.sideEffects')
  for (const key of ['externalWrites', 'push', 'send', 'merge'] as const) {
    if (value.sideEffects[key] !== false) throw new EvolutionInputError('sideEffectEvalSet', `evalSet.sideEffects.${key}`)
  }
  if (!Array.isArray(value.entries)) throw new EvolutionInputError('invalidEntries', 'evalSet.entries')
  const entries = value.entries.map((entry, index): EvalSetEntry => {
    const path = `evalSet.entries[${index}]`
    if (!isRecord(entry)) throw new EvolutionInputError('invalidEntry', path)
    onlyKeys(entry, ['id', 'taskFamily', 'form', 'holdout', 'replay', 'rubric', 'timeoutSeconds'], path)
    if (typeof entry.form !== 'string' || !FORMS.has(entry.form as SampleForm)) throw new EvolutionInputError('invalidForm', `${path}.form`)
    if (typeof entry.replay !== 'string' || !REPLAYS.has(entry.replay as EvalSetEntry['replay'])) throw new EvolutionInputError('invalidReplay', `${path}.replay`)
    if (typeof entry.rubric !== 'string' || !RUBRICS.has(entry.rubric as EvalSetEntry['rubric'])) throw new EvolutionInputError('invalidRubric', `${path}.rubric`)
    return {
      id: stringAt(entry.id, `${path}.id`, REF),
      taskFamily: stringAt(entry.taskFamily, `${path}.taskFamily`, FAMILY),
      form: entry.form as SampleForm,
      holdout: booleanAt(entry.holdout, `${path}.holdout`),
      replay: entry.replay as EvalSetEntry['replay'],
      rubric: entry.rubric as EvalSetEntry['rubric'],
      timeoutSeconds: numberAt(entry.timeoutSeconds, `${path}.timeoutSeconds`, 1, 86_400, true),
    }
  })
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new EvolutionInputError('duplicateEntry', entry.id)
    ids.add(entry.id)
  }
  return {
    schema: EVAL_SET_SCHEMA,
    id: stringAt(value.id, 'evalSet.id', REF),
    revision: numberAt(value.revision, 'evalSet.revision', 1, 1_000_000, true),
    createdAt: instantAt(value.createdAt, 'evalSet.createdAt'),
    environment: {
      dshVersion: stringAt(value.environment.dshVersion, 'evalSet.environment.dshVersion', ENV),
      policyVersion: stringAt(value.environment.policyVersion, 'evalSet.environment.policyVersion', ENV),
      repoBaseline: value.environment.repoBaseline === null ? null : stringAt(value.environment.repoBaseline, 'evalSet.environment.repoBaseline', ENV),
    },
    privacy: {
      containsPrivate: false,
      location: stringAt(value.privacy.location, 'evalSet.privacy.location', REF),
      retentionDays: numberAt(value.privacy.retentionDays, 'evalSet.privacy.retentionDays', 0, 36_500, true),
    },
    sideEffects: { externalWrites: false, push: false, send: false, merge: false },
    entries,
  }
}

const FORBIDDEN_DIFF = ['maxActionLevel', 'approval', 'approvalPolicy', 'permissionPreset', 'permissions', 'mandateMinutes', 'sources', 'credentials', 'role', 'revision', 'contentHash', 'provenance', 'activeRevision', 'retiredRevisions']
const ALLOWED_DIFF = ['title', 'description', 'model', 'tools', 'prompt', 'evalBaseline']

/** Refuse any diff key that would reach authorization, credentials or lifecycle instead of execution content. */
function assertDiff(value: unknown): ProfileDiff {
  if (!isRecord(value)) throw new EvolutionInputError('invalidDiff', 'diff must be an object')
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_DIFF.includes(key)) throw new EvolutionInputError('forbiddenDiffField', key)
    if (!ALLOWED_DIFF.includes(key)) throw new EvolutionInputError('unexpectedDiffField', key)
  }
  const diff: ProfileDiff = {}
  if (value.title !== undefined) diff.title = stringAt(value.title, 'diff.title', /^[^\n\r]{1,200}$/)
  if (value.description !== undefined) diff.description = stringAt(value.description, 'diff.description', /^[^\n\r]{1,1000}$/)
  if (value.model !== undefined) diff.model = parseModel(value.model)
  if (value.tools !== undefined) diff.tools = parseTools(value.tools)
  if (value.prompt !== undefined) diff.prompt = parsePrompt(value.prompt)
  if (value.evalBaseline !== undefined) {
    if (!isRecord(value.evalBaseline)) throw new EvolutionInputError('invalidEvalBaseline', 'diff.evalBaseline')
    onlyKeys(value.evalBaseline, ['evalSet', 'revision'], 'diff.evalBaseline')
    diff.evalBaseline = {
      evalSet: stringAt(value.evalBaseline.evalSet, 'diff.evalBaseline.evalSet', REF),
      revision: numberAt(value.evalBaseline.revision, 'diff.evalBaseline.revision', 1, 1_000_000, true),
    }
  }
  if (Object.keys(diff).length === 0) throw new EvolutionInputError('emptyDiff', 'diff must change at least one field')
  return diff
}

function parseModel(value: unknown): NonNullable<ProfileDiff['model']> {
  if (!isRecord(value)) throw new EvolutionInputError('invalidModel', 'diff.model')
  if (value.mode === 'inherit') {
    onlyKeys(value, ['mode'], 'diff.model')
    return { mode: 'inherit' }
  }
  if (value.mode !== 'pinned') throw new EvolutionInputError('invalidModelMode', 'diff.model.mode')
  onlyKeys(value, ['mode', 'provider', 'model', 'reasoningEffort'], 'diff.model')
  const result: NonNullable<ProfileDiff['model']> = {
    mode: 'pinned',
    provider: stringAt(value.provider, 'diff.model.provider', REF),
    model: stringAt(value.model, 'diff.model.model', REF),
  }
  if (value.reasoningEffort !== undefined) result.reasoningEffort = stringAt(value.reasoningEffort, 'diff.model.reasoningEffort', /^(off|minimal|low|medium|high)$/)
  return result
}

function parseTools(value: unknown): NonNullable<ProfileDiff['tools']> {
  if (!isRecord(value)) throw new EvolutionInputError('invalidTools', 'diff.tools')
  if (value.mode === 'inherit') {
    onlyKeys(value, ['mode'], 'diff.tools')
    return { mode: 'inherit' }
  }
  if (value.mode !== 'list') throw new EvolutionInputError('invalidToolsMode', 'diff.tools.mode')
  onlyKeys(value, ['mode', 'names'], 'diff.tools')
  if (!Array.isArray(value.names) || value.names.length === 0 || value.names.length > 64) throw new EvolutionInputError('invalidToolNames', 'diff.tools.names')
  const names = value.names.map((name, index) => stringAt(name, `diff.tools.names[${index}]`, REF))
  return { mode: 'list', names: [...new Set(names)].sort() }
}

function parsePrompt(value: unknown): NonNullable<ProfileDiff['prompt']> {
  if (!isRecord(value)) throw new EvolutionInputError('invalidPrompt', 'diff.prompt')
  if (value.mode === 'live') {
    onlyKeys(value, ['mode'], 'diff.prompt')
    return { mode: 'live' }
  }
  if (value.mode !== 'pinned') throw new EvolutionInputError('invalidPromptMode', 'diff.prompt.mode')
  onlyKeys(value, ['mode', 'revision'], 'diff.prompt')
  return { mode: 'pinned', revision: numberAt(value.revision, 'diff.prompt.revision', 1, 1_000_000, true) }
}

/** Parse the candidate experiences; each carries the only diff this loop is allowed to describe. */
export function parseIntents(value: unknown): ProposalIntent[] {
  if (!isRecord(value)) throw new EvolutionInputError('invalidIntents', 'expected an object')
  onlyKeys(value, ['schema', 'intents'], 'intents')
  if (value.schema !== INTENT_SCHEMA) throw new EvolutionInputError('unsupportedSchema', 'intents.schema')
  if (!Array.isArray(value.intents)) throw new EvolutionInputError('invalidIntentList', 'intents.intents')
  const intents = value.intents.map((intent, index): ProposalIntent => {
    const path = `intents[${index}]`
    if (!isRecord(intent)) throw new EvolutionInputError('invalidIntent', path)
    onlyKeys(intent, ['id', 'profileId', 'baseRevision', 'proposedRevision', 'taskFamily', 'form', 'baseline', 'hypothesis', 'diff', 'experiment'], path)
    if (typeof intent.form !== 'string' || !FORMS.has(intent.form as SampleForm)) throw new EvolutionInputError('invalidForm', `${path}.form`)
    let baseline: ProposalIntent['baseline']
    if (!isRecord(intent.baseline)) throw new EvolutionInputError('invalidBaseline', `${path}.baseline`)
    if (intent.baseline.kind === 'legacy') {
      onlyKeys(intent.baseline, ['kind'], `${path}.baseline`)
      baseline = { kind: 'legacy' }
    } else if (intent.baseline.kind === 'profile') {
      onlyKeys(intent.baseline, ['kind', 'profileId', 'revision'], `${path}.baseline`)
      baseline = {
        kind: 'profile',
        profileId: stringAt(intent.baseline.profileId, `${path}.baseline.profileId`, REF),
        revision: numberAt(intent.baseline.revision, `${path}.baseline.revision`, 1, 1_000_000, true),
      }
    } else throw new EvolutionInputError('invalidBaselineKind', `${path}.baseline.kind`)
    if (!isRecord(intent.experiment)) throw new EvolutionInputError('invalidExperiment', `${path}.experiment`)
    onlyKeys(intent.experiment, ['mde', 'alpha', 'power', 'allocation', 'evalSet', 'guardrails', 'stopping'], `${path}.experiment`)
    if (typeof intent.experiment.allocation !== 'string' || !ALLOCATIONS.has(intent.experiment.allocation as Allocation)) {
      throw new EvolutionInputError('invalidAllocation', `${path}.experiment.allocation`)
    }
    if (!isRecord(intent.experiment.evalSet)) throw new EvolutionInputError('invalidEvalSetRef', `${path}.experiment.evalSet`)
    onlyKeys(intent.experiment.evalSet, ['id', 'revision'], `${path}.experiment.evalSet`)
    if (!isRecord(intent.experiment.guardrails)) throw new EvolutionInputError('invalidGuardrails', `${path}.experiment.guardrails`)
    onlyKeys(intent.experiment.guardrails, ['reworkRate', 'blockedRate', 'p90DispatchToReadySeconds', 'reviewRejectionRate', 'tokenGrowthRate'], `${path}.experiment.guardrails`)
    if (!isRecord(intent.experiment.stopping)) throw new EvolutionInputError('invalidStopping', `${path}.experiment.stopping`)
    onlyKeys(intent.experiment.stopping, ['afterSamples', 'rule'], `${path}.experiment.stopping`)
    return {
      id: stringAt(intent.id, `${path}.id`, REF),
      profileId: stringAt(intent.profileId, `${path}.profileId`, REF),
      baseRevision: numberAt(intent.baseRevision, `${path}.baseRevision`, 1, 1_000_000, true),
      proposedRevision: numberAt(intent.proposedRevision, `${path}.proposedRevision`, 1, 1_000_000, true),
      taskFamily: stringAt(intent.taskFamily, `${path}.taskFamily`, FAMILY),
      form: intent.form as SampleForm,
      baseline,
      hypothesis: stringAt(intent.hypothesis, `${path}.hypothesis`, /^[^\n\r]{1,300}$/),
      diff: assertDiff(intent.diff),
      experiment: {
        mde: numberAt(intent.experiment.mde, `${path}.experiment.mde`, 0.001, 0.5),
        alpha: numberAt(intent.experiment.alpha, `${path}.experiment.alpha`, 0.001, 0.5),
        power: numberAt(intent.experiment.power, `${path}.experiment.power`, 0.5, 0.999),
        allocation: intent.experiment.allocation as Allocation,
        evalSet: {
          id: stringAt(intent.experiment.evalSet.id, `${path}.experiment.evalSet.id`, REF),
          revision: numberAt(intent.experiment.evalSet.revision, `${path}.experiment.evalSet.revision`, 1, 1_000_000, true),
        },
        guardrails: {
          reworkRate: numberAt(intent.experiment.guardrails.reworkRate, `${path}.experiment.guardrails.reworkRate`, 0, 1),
          blockedRate: numberAt(intent.experiment.guardrails.blockedRate, `${path}.experiment.guardrails.blockedRate`, 0, 1),
          p90DispatchToReadySeconds: numberAt(intent.experiment.guardrails.p90DispatchToReadySeconds, `${path}.experiment.guardrails.p90DispatchToReadySeconds`, 0, 1_000_000),
          reviewRejectionRate: numberAt(intent.experiment.guardrails.reviewRejectionRate, `${path}.experiment.guardrails.reviewRejectionRate`, 0, 1),
          tokenGrowthRate: numberAt(intent.experiment.guardrails.tokenGrowthRate, `${path}.experiment.guardrails.tokenGrowthRate`, 0, 1),
        },
        stopping: {
          afterSamples: numberAt(intent.experiment.stopping.afterSamples, `${path}.experiment.stopping.afterSamples`, 1, 10_000_000, true),
          rule: stringAt(intent.experiment.stopping.rule, `${path}.experiment.stopping.rule`, /^[^\n\r]{1,300}$/),
        },
      },
    }
  })
  const ids = new Set<string>()
  for (const intent of intents) {
    if (ids.has(intent.id)) throw new EvolutionInputError('duplicateIntent', intent.id)
    ids.add(intent.id)
  }
  return intents
}

function parseOutcome(value: unknown, path: string): ReplayOutcome {
  if (!isRecord(value)) throw new EvolutionInputError('invalidReplayOutcome', path)
  onlyKeys(value, ['success', 'reworked', 'blocked', 'failed', 'reviewRejected', 'dispatchToReadySeconds', 'tokens'], path)
  let tokens: ReplayOutcome['tokens'] = null
  if (value.tokens !== null) {
    if (!isRecord(value.tokens)) throw new EvolutionInputError('invalidTokens', `${path}.tokens`)
    onlyKeys(value.tokens, ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'], `${path}.tokens`)
    tokens = {
      input: numberAt(value.tokens.input, `${path}.tokens.input`, 0, 1_000_000_000, true),
      output: numberAt(value.tokens.output, `${path}.tokens.output`, 0, 1_000_000_000, true),
      cacheRead: numberAt(value.tokens.cacheRead, `${path}.tokens.cacheRead`, 0, 1_000_000_000, true),
      cacheWrite: numberAt(value.tokens.cacheWrite, `${path}.tokens.cacheWrite`, 0, 1_000_000_000, true),
      reasoning: numberAt(value.tokens.reasoning, `${path}.tokens.reasoning`, 0, 1_000_000_000, true),
    }
  }
  return {
    success: booleanAt(value.success, `${path}.success`),
    reworked: booleanAt(value.reworked, `${path}.reworked`),
    blocked: booleanAt(value.blocked, `${path}.blocked`),
    failed: booleanAt(value.failed, `${path}.failed`),
    reviewRejected: booleanAt(value.reviewRejected, `${path}.reviewRejected`),
    dispatchToReadySeconds: nullableNumber(value.dispatchToReadySeconds, `${path}.dispatchToReadySeconds`),
    tokens,
  }
}

/** Parse replay evidence; the allocation must name exactly one of pairs or runs. */
export function parseEvalResults(value: unknown): EvalResults {
  if (!isRecord(value)) throw new EvolutionInputError('invalidEvidence', 'expected an object')
  onlyKeys(value, ['schema', 'generatedAt', 'experiments'], 'evidence')
  if (value.schema !== EVIDENCE_SCHEMA) throw new EvolutionInputError('unsupportedSchema', 'evidence.schema')
  if (!Array.isArray(value.experiments)) throw new EvolutionInputError('invalidExperiments', 'evidence.experiments')
  const experiments = value.experiments.map((experiment, index): ReplayEvidence => {
    const path = `evidence.experiments[${index}]`
    if (!isRecord(experiment)) throw new EvolutionInputError('invalidExperiment', path)
    onlyKeys(experiment, ['id', 'baseline', 'candidate', 'environment', 'allocation', 'pairs', 'runs'], path)
    if (typeof experiment.allocation !== 'string' || !ALLOCATIONS.has(experiment.allocation as Allocation)) {
      throw new EvolutionInputError('invalidAllocation', `${path}.allocation`)
    }
    if (!isRecord(experiment.environment)) throw new EvolutionInputError('invalidEnvironment', `${path}.environment`)
    onlyKeys(experiment.environment, ['dshVersion', 'policyVersion', 'repoBaseline'], `${path}.environment`)
    const result: ReplayEvidence = {
      id: stringAt(experiment.id, `${path}.id`, REF),
      baseline: stringAt(experiment.baseline, `${path}.baseline`, ENV),
      candidate: stringAt(experiment.candidate, `${path}.candidate`, ENV),
      environment: {
        dshVersion: stringAt(experiment.environment.dshVersion, `${path}.environment.dshVersion`, ENV),
        policyVersion: stringAt(experiment.environment.policyVersion, `${path}.environment.policyVersion`, ENV),
        repoBaseline: experiment.environment.repoBaseline === null ? null : stringAt(experiment.environment.repoBaseline, `${path}.environment.repoBaseline`, ENV),
      },
      allocation: experiment.allocation as Allocation,
    }
    if (experiment.allocation === 'paired-replay') {
      if (experiment.runs !== undefined) throw new EvolutionInputError('allocationMismatch', `${path}.runs`)
      if (!Array.isArray(experiment.pairs)) throw new EvolutionInputError('invalidPairs', `${path}.pairs`)
      result.pairs = experiment.pairs.map((pair, pairIndex) => {
        const pairPath = `${path}.pairs[${pairIndex}]`
        if (!isRecord(pair)) throw new EvolutionInputError('invalidPair', pairPath)
        onlyKeys(pair, ['entryId', 'baseline', 'candidate'], pairPath)
        return {
          entryId: stringAt(pair.entryId, `${pairPath}.entryId`, REF),
          baseline: parseOutcome(pair.baseline, `${pairPath}.baseline`),
          candidate: parseOutcome(pair.candidate, `${pairPath}.candidate`),
        }
      })
    } else {
      if (experiment.pairs !== undefined) throw new EvolutionInputError('allocationMismatch', `${path}.pairs`)
      if (!Array.isArray(experiment.runs)) throw new EvolutionInputError('invalidRuns', `${path}.runs`)
      result.runs = experiment.runs.map((run, runIndex) => {
        const runPath = `${path}.runs[${runIndex}]`
        if (!isRecord(run)) throw new EvolutionInputError('invalidRun', runPath)
        onlyKeys(run, ['entryId', 'group', 'outcome'], runPath)
        if (run.group !== 'baseline' && run.group !== 'candidate') throw new EvolutionInputError('invalidGroup', `${runPath}.group`)
        return { entryId: stringAt(run.entryId, `${runPath}.entryId`, REF), group: run.group, outcome: parseOutcome(run.outcome, `${runPath}.outcome`) }
      })
    }
    return result
  })
  const ids = new Set<string>()
  for (const experiment of experiments) {
    if (ids.has(experiment.id)) throw new EvolutionInputError('duplicateExperiment', experiment.id)
    ids.add(experiment.id)
  }
  return { schema: EVIDENCE_SCHEMA, generatedAt: instantAt(value.generatedAt, 'evidence.generatedAt'), experiments }
}

/** `successful` over `n`; a zero denominator is null, never a fake zero. */
function rate(successes: number, n: number): Rate {
  return { n, successes, rate: n === 0 ? null : successes / n }
}

/** The nearest-rank quantile; null for no samples. */
function quantile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!
}

/** The baseline label shown in evidence; legacy and an explicit profile never share a label. */
function baselineOf(profile: EvolutionSample['profile']): EvolutionGroup['baseline'] {
  if (!profile) return 'legacy'
  return profile.id === 'worker-default' && profile.revision === 1 ? 'worker-default@1' : `${profile.id}@${profile.revision}`
}

/** The stable grouping key: a moving configuration is its own, explicitly non-comparable, group. */
function groupKeyOf(sample: EvolutionSample): string {
  const profile = sample.profile
  const profileKey = profile === null ? 'legacy' : profile.moving ? `moving:${profile.id}@${profile.revision}` : `frozen:${profile.effectiveHash}`
  return `${profileKey}|${sample.taskFamily}|${sample.form}`
}

const environmentKey = (environment: EvolutionSample['environment']): string => `${environment.dshVersion}|${environment.policyVersion}|${environment.source}`

/** Aggregate every sample once; grouping is by effective configuration and task family, never by title. */
export function aggregate(samples: EvolutionSample[]): EvolutionGroup[] {
  const groups = new Map<string, {
    group: EvolutionGroup
    dispatchToReady: number[]
    tokenSamples: number
    tokenInput: number
    tokenOutput: number
    tokenCacheRead: number
    tokenCacheWrite: number
    tokenReasoning: number
    notifications: number[]
    comments: number[]
    reviewedWithComments: number
  }>()
  for (const sample of samples) {
    const key = groupKeyOf(sample)
    let entry = groups.get(key)
    if (!entry) {
      const profile = sample.profile
      entry = {
        group: {
          key, profile, baseline: baselineOf(profile), taskFamily: sample.taskFamily, form: sample.form,
          moving: profile?.moving ?? false, comparable: !(profile?.moving ?? false), environments: [],
          n: 0, roots: 0, children: 0, lightweight: 0, fallback: 0, censored: 0,
          rootSuccess: rate(0, 0), childSuccess: rate(0, 0), lightweightSuccess: rate(0, 0),
          closed: 0, blocked: 0, failed: 0, stopped: 0, dropped: 0, failureReasons: {},
          rework: rate(0, 0),
          review: { reviewed: 0, accepted: 0, unaccepted: 0, acceptedRate: null, comments: { state: 'unknown', total: null } },
          latency: { samples: 0, p50Seconds: null, p90Seconds: null },
          tokens: { state: 'unknown', samples: 0, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
          notifications: { state: 'unknown', total: null, perResult: null },
          sampleIds: [],
        },
        dispatchToReady: [], tokenSamples: 0, tokenInput: 0, tokenOutput: 0, tokenCacheRead: 0, tokenCacheWrite: 0,
        tokenReasoning: 0, notifications: [], comments: [], reviewedWithComments: 0,
      }
      groups.set(key, entry)
    }
    const group = entry.group
    group.n += 1
    group.sampleIds.push(sample.id)
    if (sample.kind === 'root') group.roots += 1
    else if (sample.kind === 'child') group.children += 1
    else group.lightweight += 1
    if (sample.profile?.fallback) group.fallback += 1
    if (sample.ended === null) group.censored += 1
    const environment = environmentKey(sample.environment)
    if (!group.environments.includes(environment)) group.environments.push(environment)
    if (sample.ended?.outcome === 'closed') group.closed += 1
    if (sample.failure.state === 'blocked') group.blocked += 1
    if (sample.failure.state === 'failed') group.failed += 1
    if (sample.failure.state === 'stopped') group.stopped += 1
    if (sample.failure.state === 'dropped') group.dropped += 1
    if (sample.failure.reasonCode) group.failureReasons[sample.failure.reasonCode] = (group.failureReasons[sample.failure.reasonCode] ?? 0) + 1
    if (sample.kind === 'root' && sample.ended && sample.ended.outcome !== 'dropped' && sample.ended.outcome !== 'stopped') {
      group.rootSuccess.n += 1
      if (sample.ended.outcome === 'completed' || sample.ended.outcome === 'merged') group.rootSuccess.successes += 1
    } else if (sample.kind === 'child' && sample.ended) {
      group.childSuccess.n += 1
      if (sample.ended.outcome === 'completed' || sample.ended.outcome === 'merged') group.childSuccess.successes += 1
    } else if (sample.kind === 'lightweight' && sample.ended && sample.ended.outcome !== 'dropped' && sample.ended.outcome !== 'stopped') {
      group.lightweightSuccess.n += 1
      if (sample.ended.outcome === 'completed' || sample.ended.outcome === 'merged') group.lightweightSuccess.successes += 1
    }
    if (sample.kind !== 'lightweight') {
      group.rework.n += 1
      if (sample.reworked) group.rework.successes += 1
    }
    if (sample.review.reviewed) {
      group.review.reviewed += 1
      if (sample.review.accepted) group.review.accepted += 1
      else group.review.unaccepted += 1
      if (sample.review.comments !== null) {
        entry.reviewedWithComments += 1
        entry.comments.push(sample.review.comments)
      }
    }
    if (sample.latency.dispatchToReadySeconds !== null) entry.dispatchToReady.push(sample.latency.dispatchToReadySeconds)
    if (sample.tokens !== null) {
      entry.tokenSamples += 1
      entry.tokenInput += sample.tokens.input
      entry.tokenOutput += sample.tokens.output
      entry.tokenCacheRead += sample.tokens.cacheRead
      entry.tokenCacheWrite += sample.tokens.cacheWrite
      entry.tokenReasoning += sample.tokens.reasoning
    }
    if (sample.notifications !== null) entry.notifications.push(sample.notifications)
  }
  return [...groups.values()].map(entry => {
    const group = entry.group
    group.rootSuccess.rate = group.rootSuccess.n === 0 ? null : group.rootSuccess.successes / group.rootSuccess.n
    group.childSuccess.rate = group.childSuccess.n === 0 ? null : group.childSuccess.successes / group.childSuccess.n
    group.lightweightSuccess.rate = group.lightweightSuccess.n === 0 ? null : group.lightweightSuccess.successes / group.lightweightSuccess.n
    group.rework.rate = group.rework.n === 0 ? null : group.rework.successes / group.rework.n
    group.review.acceptedRate = group.review.reviewed === 0 ? null : group.review.accepted / group.review.reviewed
    group.review.comments = group.review.reviewed > 0 && entry.reviewedWithComments === group.review.reviewed
      ? { state: 'available', total: entry.comments.reduce((sum, value) => sum + value, 0) }
      : { state: 'unknown', total: null }
    group.latency = { samples: entry.dispatchToReady.length, p50Seconds: quantile(entry.dispatchToReady, 0.5), p90Seconds: quantile(entry.dispatchToReady, 0.9) }
    const tracked = group.n - group.lightweight
    group.tokens = tracked > 0 && entry.tokenSamples === tracked
      ? { state: 'available', samples: entry.tokenSamples, input: entry.tokenInput, output: entry.tokenOutput,
          cacheRead: entry.tokenCacheRead, cacheWrite: entry.tokenCacheWrite, reasoning: entry.tokenReasoning }
      : { state: 'unknown', samples: entry.tokenSamples, input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }
    group.notifications = group.n > 0 && entry.notifications.length === group.n
      ? { state: 'available', total: entry.notifications.reduce((sum, value) => sum + value, 0), perResult: entry.notifications.reduce((sum, value) => sum + value, 0) / group.n }
      : { state: 'unknown', total: null, perResult: null }
    group.sampleIds.sort()
    group.environments.sort()
    group.comparable = !group.moving && group.environments.length <= 1
    return group
  }).sort((left, right) => left.key.localeCompare(right.key))
}

/** The error function, good enough for the two-sided normal tests this offline gate reports. */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911
  const t = 1 / (1 + p * ax)
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax)
  return sign * y
}

/** The standard normal CDF. */
function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** The inverse standard normal CDF (Acklam's rational approximation), used for the pre-registered α and power. */
function invNorm(p: number): number {
  if (p <= 0 || p >= 1) throw new EvolutionInputError('invalidProbability', 'invNorm')
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const low = 0.02425, high = 1 - low
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  const q = p - 0.5
  const r = q * q
  return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
    / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
}

/** The two-proportion sample size required for the pre-registered baseline, MDE, α and power. */
export function requiredSampleSize(baseline: number, mde: number, alpha: number, power: number): number {
  if (!(baseline >= 0 && baseline <= 1) || !(mde > 0 && mde <= 0.5) || !(alpha > 0 && alpha < 1) || !(power > 0.5 && power < 1)) {
    throw new EvolutionInputError('invalidSampleSizeInput', 'baseline, mde, alpha and power')
  }
  // A 100% baseline has no headroom for the pre-registered effect: asking for a sample size would divide by zero.
  if (baseline >= 0.999) throw new EvolutionInputError('baselineAtCeiling', 'baseline has no room for the MDE')
  const p1 = Math.min(0.999, Math.max(0.001, baseline))
  const p2 = Math.min(0.999, Math.max(p1 + 0.000001, p1 + mde))
  const average = (p1 + p2) / 2
  const zAlpha = invNorm(1 - alpha / 2)
  const zPower = invNorm(power)
  const numerator = (zAlpha * Math.sqrt(2 * average * (1 - average)) + zPower * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2
  return Math.ceil(numerator / ((p2 - p1) ** 2))
}

/** A paired difference and its normal-approximation interval plus McNemar's exact two-sided p-value. */
function pairedStatistics(pairs: NonNullable<ReplayEvidence['pairs']>): { baseline: Rate; candidate: Rate; difference: number; ci: { lower: number; upper: number; level: number }; pValue: number } {
  let baselineSuccesses = 0, candidateSuccesses = 0, b = 0, c = 0
  for (const pair of pairs) {
    if (pair.baseline.success) baselineSuccesses += 1
    if (pair.candidate.success) candidateSuccesses += 1
    if (pair.baseline.success && !pair.candidate.success) b += 1
    else if (!pair.baseline.success && pair.candidate.success) c += 1
  }
  const n = pairs.length
  const difference = (c - b) / n
  const variance = (b / n + c / n - difference ** 2) / n
  const half = invNorm(0.975) * Math.sqrt(Math.max(0, variance))
  const discordant = b + c
  let pValue = 1
  if (discordant > 0) {
    const tail = Math.min(b, c)
    let term = Math.pow(0.5, discordant), sum = term
    for (let index = 1; index <= tail; index += 1) {
      term *= (discordant - index + 1) / index
      sum += term
    }
    pValue = Math.min(1, 2 * sum)
  }
  return { baseline: rate(baselineSuccesses, n), candidate: rate(candidateSuccesses, n), difference, ci: { lower: difference - half, upper: difference + half, level: 0.95 }, pValue }
}

/** An unpaired difference and its normal-approximation interval plus the two-sided z test. */
function unpairedStatistics(baseline: Rate, candidate: Rate): { difference: number; ci: { lower: number; upper: number; level: number }; pValue: number | null } {
  if (baseline.n === 0 || candidate.n === 0) return { difference: 0, ci: { lower: 0, upper: 0, level: 0.95 }, pValue: null }
  const p1 = baseline.rate!, p2 = candidate.rate!
  const difference = p2 - p1
  const variance = p1 * (1 - p1) / baseline.n + p2 * (1 - p2) / candidate.n
  const se = Math.sqrt(Math.max(0, variance))
  const half = invNorm(0.975) * se
  const pValue = se === 0 ? (difference === 0 ? 1 : 0) : 2 * (1 - normalCdf(Math.abs(difference / se)))
  return { difference, ci: { lower: difference - half, upper: difference + half, level: 0.95 }, pValue }
}

/** A stable proposal id from its public coordinates, so two runs over the same evidence agree. */
function proposalIdOf(intent: ProposalIntent): string {
  const baseline = intent.baseline.kind === 'legacy' ? 'legacy' : `${intent.baseline.profileId}@${intent.baseline.revision}`
  return `proposal:${intent.id}:${intent.profileId}@${intent.proposedRevision}:${intent.taskFamily}:${intent.form}:${baseline}`
}

/** The diagnosis for one candidate/baseline pair, including its downgrade when it cannot support a proposal. */
function diagnose(candidate: EvolutionGroup, baseline: EvolutionGroup, window: { from: string; to: string }): EvolutionDiagnosis {
  const candidateRate = candidate.rootSuccess.rate
  const baselineRate = baseline.rootSuccess.rate
  const reasons: string[] = []
  let comparable = candidate.comparable && baseline.comparable
  if (!candidate.comparable || !baseline.comparable) reasons.push('movingProfile')
  if (candidate.environments.join('|') !== baseline.environments.join('|')) {
    comparable = false
    reasons.push('environmentMismatch')
  }
  if (candidateRate === null || baselineRate === null) reasons.push('noSuccessSample')
  let delta: number | null = null
  let ci: EvolutionDiagnosis['evidence']['ci'] = null
  if (candidateRate !== null && baselineRate !== null && candidate.rootSuccess.n > 0 && baseline.rootSuccess.n > 0) {
    delta = candidateRate - baselineRate
    const statistics = unpairedStatistics(baseline.rootSuccess, candidate.rootSuccess)
    ci = statistics.ci
    if (delta <= 0) reasons.push('noImprovement')
  }
  let confidence: Confidence = 'low'
  if (comparable && candidateRate !== null && baselineRate !== null) {
    const smallest = Math.min(candidate.rootSuccess.n, baseline.rootSuccess.n)
    if (smallest >= 30 && ci !== null && ci.lower > 0) confidence = 'high'
    else if (smallest >= 10 && delta !== null && delta > 0) confidence = 'medium'
    else reasons.push('lowConfidence')
  } else {
    reasons.push('lowConfidence')
  }
  let withheld: string | null = null
  if (!comparable) withheld = 'notComparable'
  else if (candidateRate === null || baselineRate === null) withheld = 'noSuccessSample'
  else if (delta === null || delta <= 0) withheld = 'noImprovement'
  else if (confidence === 'low') withheld = 'lowConfidence'
  const profileLabel = (group: EvolutionGroup): string => group.profile ? `${group.profile.id}@${group.profile.revision}` : 'legacy'
  const blockedRate = (group: EvolutionGroup): number | null => group.n === 0 ? null : (group.blocked + group.failed) / group.n
  return {
    id: `${candidate.key}>${baseline.key}`,
    taskFamily: candidate.taskFamily,
    form: candidate.form,
    candidateKey: candidate.key,
    baselineKey: baseline.key,
    hypothesis: `${profileLabel(candidate)} changes ${candidate.taskFamily} root success relative to ${profileLabel(baseline)}`,
    confidence,
    comparable,
    reasons,
    evidence: {
      candidate: { profile: profileLabel(candidate), effectiveHash: candidate.profile?.effectiveHash ?? 'legacy', n: candidate.rootSuccess.n,
        rate: candidateRate, reworkRate: candidate.rework.rate, blockedRate: blockedRate(candidate) },
      baseline: { profile: profileLabel(baseline), effectiveHash: baseline.profile?.effectiveHash ?? 'legacy', n: baseline.rootSuccess.n,
        rate: baselineRate, reworkRate: baseline.rework.rate, blockedRate: blockedRate(baseline) },
      delta, ci,
      sampleIds: [...new Set([...candidate.sampleIds, ...baseline.sampleIds])].sort().slice(0, 8),
      window,
    },
    withheld,
  }
}

/** Pick the pre-registered comparison group: a profile prefers worker-default, which prefers legacy. */
function baselineFor(candidate: EvolutionGroup, groups: EvolutionGroup[]): EvolutionGroup | undefined {
  const candidates = groups.filter(group => group.taskFamily === candidate.taskFamily && group.form === candidate.form
    && group.key !== candidate.key && group.comparable && group.rootSuccess.n > 0
    && group.environments.join('|') === candidate.environments.join('|'))
  const rank = (group: EvolutionGroup): number => group.baseline === 'worker-default@1' ? 0 : group.baseline === 'legacy' ? 1 : 2
  return candidates.sort((left, right) => rank(left) - rank(right) || left.key.localeCompare(right.key))[0]
}

/** Diagnose every comparable candidate group against one baseline; keep low-confidence records but withhold them. */
export function diagnoses(groups: EvolutionGroup[], window: { from: string; to: string }): EvolutionDiagnosis[] {
  const result: EvolutionDiagnosis[] = []
  for (const candidate of groups) {
    if (candidate.profile === null) continue
    const baseline = baselineFor(candidate, groups)
    if (!baseline) {
      result.push({
        id: `${candidate.key}>none`, taskFamily: candidate.taskFamily, form: candidate.form,
        candidateKey: candidate.key, baselineKey: '', hypothesis: `No comparable baseline exists for ${candidate.taskFamily}`,
        confidence: 'low', comparable: false, reasons: ['noBaseline'],
        evidence: { candidate: { profile: `${candidate.profile.id}@${candidate.profile.revision}`, effectiveHash: candidate.profile.effectiveHash,
          n: candidate.rootSuccess.n, rate: candidate.rootSuccess.rate, reworkRate: candidate.rework.rate,
          blockedRate: candidate.n === 0 ? null : (candidate.blocked + candidate.failed) / candidate.n },
        baseline: { profile: 'none', effectiveHash: 'none', n: 0, rate: null, reworkRate: null, blockedRate: null },
        delta: null, ci: null, sampleIds: candidate.sampleIds.slice(0, 5), window },
        withheld: 'noBaseline',
      })
      continue
    }
    result.push(diagnose(candidate, baseline, window))
  }
  return result.sort((left, right) => left.id.localeCompare(right.id))
}

/** Guardrail values from replay outcomes, with `unknown` when a measure has no sample. */
function guardrailValues(outcomes: ReplayOutcome[]): { reworkRate: number | null; blockedRate: number | null; p90DispatchToReadySeconds: number | null; reviewRejectionRate: number | null; tokensPerRun: number | null } {
  if (outcomes.length === 0) return { reworkRate: null, blockedRate: null, p90DispatchToReadySeconds: null, reviewRejectionRate: null, tokensPerRun: null }
  const n = outcomes.length
  const latencies = outcomes.flatMap(outcome => outcome.dispatchToReadySeconds === null ? [] : [outcome.dispatchToReadySeconds])
  const tokens = outcomes.flatMap(outcome => outcome.tokens === null ? [] : [outcome.tokens.input + outcome.tokens.output + outcome.tokens.cacheRead + outcome.tokens.cacheWrite + outcome.tokens.reasoning])
  return {
    reworkRate: outcomes.filter(outcome => outcome.reworked).length / n,
    blockedRate: outcomes.filter(outcome => outcome.blocked || outcome.failed).length / n,
    p90DispatchToReadySeconds: quantile(latencies, 0.9),
    reviewRejectionRate: outcomes.filter(outcome => outcome.reviewRejected).length / n,
    tokensPerRun: tokens.length === n ? tokens.reduce((sum, value) => sum + value, 0) / n : null,
  }
}

/** Run one gate. The plan is pre-registered data; the evidence can only pass, reject or ask for more. */
export function gate(plan: ExperimentPlan, evidence: ReplayEvidence | undefined, evalSet: EvalSetManifest | undefined, observationIds: Set<string>, observationEnvironments: string[] = []): GateResult {
  const checks: GateResult['checks'] = []
  const reasons: string[] = []
  const insufficient = (reason: string): GateResult => {
    if (!reasons.includes(reason)) reasons.push(reason)
    return { proposalId: plan.id, outcome: 'insufficient', reasons, checks, requiredPerGroup: plan.requiredPerGroup, statistics: null }
  }
  checks.push({ check: 'pre-registered-eval-set', status: evalSet ? 'pass' : 'fail',
    detail: evalSet ? `${evalSet.id}@${evalSet.revision}` : 'missing manifest' })
  if (!evalSet || evalSet.id !== plan.evalSet.id || evalSet.revision !== plan.evalSet.revision) return insufficient('evalSetMismatch')
  if (plan.baseline.kind === 'profile' && plan.baseline.effectiveHash === plan.candidate.effectiveHash) return insufficient('sameEffectiveConfiguration')
  const prefix = `${evalSet.environment.dshVersion}|${evalSet.environment.policyVersion}|`
  const observationMismatch = observationEnvironments.filter(environment => !environment.startsWith(prefix))
  checks.push({ check: 'observation-environment', status: observationMismatch.length === 0 ? 'pass' : 'fail',
    detail: observationMismatch.length === 0 ? 'matches the eval-set fingerprint' : `${observationMismatch.length} mismatched group(s)` })
  if (observationMismatch.length > 0) return insufficient('observationEnvironmentMismatch')
  const holdout = evalSet.entries.filter(entry => entry.holdout && entry.taskFamily === plan.taskFamily && entry.form === plan.form)
  const entryIds = new Set(holdout.map(entry => entry.id))
  const overlap = holdout.filter(entry => observationIds.has(entry.id))
  checks.push({ check: 'holdout-separate-from-observation', status: overlap.length === 0 ? 'pass' : 'fail',
    detail: overlap.length === 0 ? `${holdout.length} holdout entries` : `${overlap.length} overlapping entries` })
  if (overlap.length > 0) return insufficient('holdoutOverlap')
  if (holdout.length === 0) return insufficient('noHoldout')
  if (plan.holdout.length !== holdout.length || plan.holdout.some(id => !entryIds.has(id))) return insufficient('holdoutMismatch')
  if (!evidence) return insufficient('noEvidence')
  if (evidence.allocation !== plan.allocation) return insufficient('allocationMismatch')
  checks.push({ check: 'environment-fingerprint', status: evidence.environment.dshVersion === evalSet.environment.dshVersion
    && evidence.environment.policyVersion === evalSet.environment.policyVersion
    && evidence.environment.repoBaseline === evalSet.environment.repoBaseline ? 'pass' : 'fail',
    detail: `${evidence.environment.dshVersion}/${evidence.environment.policyVersion}` })
  if (evidence.environment.dshVersion !== evalSet.environment.dshVersion
    || evidence.environment.policyVersion !== evalSet.environment.policyVersion
    || evidence.environment.repoBaseline !== evalSet.environment.repoBaseline) return insufficient('environmentMismatch')
  const expectedBaseline = plan.baseline.kind === 'legacy' ? 'legacy' : plan.baseline.effectiveHash
  const configurationMismatch = evidence.baseline !== expectedBaseline || evidence.candidate !== plan.candidate.effectiveHash
  checks.push({ check: 'evidence-configuration', status: configurationMismatch ? 'fail' : 'pass',
    detail: `${evidence.baseline} -> ${evidence.candidate}` })
  if (configurationMismatch) return insufficient('evidenceConfigurationMismatch')
  if (plan.stopping.afterSamples < plan.requiredPerGroup) {
    checks.push({ check: 'stopping-rule', status: 'fail', detail: 'stops before the pre-registered sample size' })
    return insufficient('stoppingBeforePower')
  }
  checks.push({ check: 'stopping-rule', status: 'pass', detail: `after ${plan.stopping.afterSamples} samples per group` })

  let baselineOutcomes: ReplayOutcome[]
  let candidateOutcomes: ReplayOutcome[]
  let statistics: GateResult['statistics'] | null
  let covered = true
  if (plan.allocation === 'paired-replay') {
    const pairs = evidence.pairs ?? []
    const outside = pairs.filter(pair => !entryIds.has(pair.entryId))
    if (pairs.length === 0) return insufficient('noSamples')
    if (outside.length > 0) { checks.push({ check: 'holdout-coverage', status: 'fail', detail: `${outside.length} entries outside holdout` }); return insufficient('holdoutCoverage') }
    baselineOutcomes = pairs.map(pair => pair.baseline)
    candidateOutcomes = pairs.map(pair => pair.candidate)
    const result = pairedStatistics(pairs)
    const guardrails = guardrailComparison(guardrailValues(baselineOutcomes), guardrailValues(candidateOutcomes), plan.guardrails)
    statistics = { method: 'paired-mcnemar', baseline: result.baseline, candidate: result.candidate, difference: result.difference,
      ci: result.ci, pValue: result.pValue, guardrails }
    covered = pairs.length === entryIds.size && new Set(pairs.map(pair => pair.entryId)).size === entryIds.size
  } else {
    const runs = evidence.runs ?? []
    const outside = runs.filter(run => !entryIds.has(run.entryId))
    if (runs.length === 0) return insufficient('noSamples')
    if (outside.length > 0) { checks.push({ check: 'holdout-coverage', status: 'fail', detail: `${outside.length} entries outside holdout` }); return insufficient('holdoutCoverage') }
    baselineOutcomes = runs.filter(run => run.group === 'baseline').map(run => run.outcome)
    candidateOutcomes = runs.filter(run => run.group === 'candidate').map(run => run.outcome)
    const baselineRate = rate(baselineOutcomes.filter(outcome => outcome.success).length, baselineOutcomes.length)
    const candidateRate = rate(candidateOutcomes.filter(outcome => outcome.success).length, candidateOutcomes.length)
    const result = unpairedStatistics(baselineRate, candidateRate)
    statistics = { method: 'unpaired-z', baseline: baselineRate, candidate: candidateRate, difference: result.difference,
      ci: result.ci, pValue: result.pValue, guardrails: guardrailComparison(guardrailValues(baselineOutcomes), guardrailValues(candidateOutcomes), plan.guardrails) }
    covered = runs.length === entryIds.size && new Set(runs.map(run => run.entryId)).size === entryIds.size
  }
  checks.push({ check: 'holdout-coverage', status: covered ? 'pass' : 'fail', detail: `${entryIds.size} entries` })
  if (!covered) return insufficient('holdoutCoverage')
  const n1 = statistics.baseline.n, n2 = statistics.candidate.n
  if (n1 < plan.requiredPerGroup || n2 < plan.requiredPerGroup) {
    checks.push({ check: 'sample-size', status: 'fail', detail: `${n1}/${n2} < ${plan.requiredPerGroup} per group` })
    return insufficient('sampleSize')
  }
  checks.push({ check: 'sample-size', status: 'pass', detail: `${n1}/${n2} >= ${plan.requiredPerGroup} per group` })
  const guardrailFailures = Object.entries(statistics.guardrails).filter(([, value]) => value.status === 'fail').map(([name]) => name)
  checks.push({ check: 'guardrails', status: guardrailFailures.length === 0 ? 'pass' : 'fail',
    detail: guardrailFailures.length === 0 ? 'no available guardrail regressed past its threshold' : guardrailFailures.join(',') })
  if (guardrailFailures.length > 0) {
    if (!reasons.includes('guardrailRegression')) reasons.push('guardrailRegression')
    return { proposalId: plan.id, outcome: 'reject', reasons, checks, requiredPerGroup: plan.requiredPerGroup, statistics }
  }
  const delta = statistics.difference
  if (delta >= plan.mde && statistics.ci.lower > 0 && statistics.pValue !== null && statistics.pValue < plan.alpha) {
    checks.push({ check: 'primary-effect', status: 'pass', detail: `${(delta * 100).toFixed(1)}pp >= ${(plan.mde * 100).toFixed(1)}pp, CI lower ${((statistics.ci.lower) * 100).toFixed(1)}pp, p ${statistics.pValue.toFixed(4)} < ${plan.alpha}` })
    return { proposalId: plan.id, outcome: 'pass', reasons, checks, requiredPerGroup: plan.requiredPerGroup, statistics }
  }
  if (statistics.ci.upper < 0) {
    reasons.push('regression')
    checks.push({ check: 'primary-effect', status: 'fail', detail: 'CI entirely below zero' })
    return { proposalId: plan.id, outcome: 'reject', reasons, checks, requiredPerGroup: plan.requiredPerGroup, statistics }
  }
  if (statistics.ci.upper < plan.mde) {
    reasons.push('belowMde')
    checks.push({ check: 'primary-effect', status: 'pass', detail: `CI upper ${(statistics.ci.upper * 100).toFixed(1)}pp is below the ${(plan.mde * 100).toFixed(1)}pp MDE` })
    return { proposalId: plan.id, outcome: 'no-difference', reasons, checks, requiredPerGroup: plan.requiredPerGroup, statistics }
  }
  reasons.push('inconclusive')
  checks.push({ check: 'primary-effect', status: 'unknown', detail: `CI ${(statistics.ci.lower * 100).toFixed(1)}–${(statistics.ci.upper * 100).toFixed(1)}pp spans the MDE` })
  return { proposalId: plan.id, outcome: 'insufficient', reasons, checks, requiredPerGroup: plan.requiredPerGroup, statistics }
}

/** Compare available guardrails; a missing measure is `unknown`, never a silent pass or a fabricated cost gate. */
function guardrailComparison(
  baseline: { reworkRate: number | null; blockedRate: number | null; p90DispatchToReadySeconds: number | null; reviewRejectionRate: number | null; tokensPerRun: number | null },
  candidate: { reworkRate: number | null; blockedRate: number | null; p90DispatchToReadySeconds: number | null; reviewRejectionRate: number | null; tokensPerRun: number | null },
  thresholds: ExperimentPlan['guardrails'],
): GuardrailComparison {
  const compare = (left: number | null, right: number | null, threshold: number | null): { baseline: number | null; candidate: number | null; threshold: number | null; status: 'pass' | 'fail' | 'unknown' } => {
    if (left === null || right === null || threshold === null) return { baseline: left, candidate: right, threshold, status: 'unknown' }
    return { baseline: left, candidate: right, threshold, status: right - left > threshold ? 'fail' : 'pass' }
  }
  return {
    reworkRate: compare(baseline.reworkRate, candidate.reworkRate, thresholds.reworkRate),
    blockedRate: compare(baseline.blockedRate, candidate.blockedRate, thresholds.blockedRate),
    p90DispatchToReadySeconds: compare(baseline.p90DispatchToReadySeconds, candidate.p90DispatchToReadySeconds, thresholds.p90DispatchToReadySeconds),
    reviewRejectionRate: compare(baseline.reviewRejectionRate, candidate.reviewRejectionRate, thresholds.reviewRejectionRate),
    tokensPerRun: baseline.tokensPerRun === null || candidate.tokensPerRun === null
      ? { baseline: baseline.tokensPerRun, candidate: candidate.tokensPerRun, threshold: thresholds.tokenGrowthRate, status: 'unknown' }
      : { baseline: baseline.tokensPerRun, candidate: candidate.tokensPerRun, threshold: thresholds.tokenGrowthRate,
          status: candidate.tokensPerRun - baseline.tokensPerRun > baseline.tokensPerRun * thresholds.tokenGrowthRate ? 'fail' : 'pass' },
  }
}

/** The conclusion from all proposals and gates; no gate may recommend adoption without a pass. */
function conclusionOf(proposals: EvolutionProposal[], gates: GateResult[], sampleCount: number, intentCount: number): EvolutionReport['conclusion'] {
  if (sampleCount === 0) return { kind: 'insufficient-evidence', summary: 'No observation samples were available; nothing was proposed.', reasons: ['noSamples'] }
  const ready = proposals.filter(proposal => proposal.status === 'ready-for-human-approval')
  if (ready.length > 0) {
    return { kind: 'propose', summary: `${ready.length} proposal(s) passed the pre-registered holdout gate and await human approval.`, reasons: ['gatePass'] }
  }
  if (gates.some(result => result.outcome === 'reject')) {
    return { kind: 'reject', summary: 'At least one pre-registered gate rejected adoption; record the reason and keep the current configuration.', reasons: ['gateReject'] }
  }
  if (gates.some(result => result.outcome === 'no-difference')) {
    return { kind: 'no-measurable-difference', summary: 'The holdout showed no effect at or above the pre-registered MDE; keep the current configuration.', reasons: ['belowMde'] }
  }
  if (intentCount === 0) {
    return { kind: 'insufficient-evidence', summary: 'No candidate experience with an explicit diff and pre-registered experiment was supplied; the observation is recorded only.', reasons: ['noCandidateExperience'] }
  }
  return { kind: 'insufficient-evidence', summary: 'Evidence is insufficient for adoption; extend the observation or run the missing holdout replay.', reasons: gates.flatMap(result => result.reasons).filter(reason => reason !== 'belowMde').slice(0, 4) }
}

/** Build the approval queue document from ready proposals; nothing here applies a proposal. */
function queueOf(proposals: EvolutionProposal[], generatedAt: string): ApprovalQueue {
  return {
    schema: QUEUE_SCHEMA, storage: 'document', generatedAt, status: 'pending-human-approval',
    items: proposals.filter(proposal => proposal.status === 'ready-for-human-approval').map(proposal => ({
      proposalId: proposal.id, profileId: proposal.scope.profileId, baseRevision: proposal.baseRevision,
      proposedRevision: proposal.proposedRevision, evidenceRef: proposal.evidence.holdout.join(','), requestedAt: generatedAt,
    })),
    note: 'Document-only queue: no production write path. A person must review the report, create the revision with the existing profile registry and activate it; bound tickets keep their snapshots.',
  }
}

/** Run the whole offline loop. Pure: it only reads its input and returns a JSON-serializable report. */
export function runEvolution(input: EvolutionInput): EvolutionReport {
  const samples = input.samples
  const groups = aggregate(samples.records)
  const diagnosesResult = diagnoses(groups, samples.window)
  const observationIds = new Set(samples.records.map(sample => sample.id))
  const intents = input.intents ?? []
  const evidence = input.evidence?.experiments ?? []
  const generatedAt = input.generatedAt ?? samples.generatedAt
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) {
    throw new EvolutionInputError('invalidInstant', 'generatedAt')
  }
  const proposals: EvolutionProposal[] = []
  const gates: GateResult[] = []
  const withheld: { id: string; reason: string }[] = diagnosesResult.filter(diagnosis => diagnosis.withheld).map(diagnosis => ({ id: diagnosis.id, reason: diagnosis.withheld! }))

  for (const intent of intents) {
    const candidate = groups.find(group => group.profile?.id === intent.profileId && group.profile.revision === intent.proposedRevision
      && group.taskFamily === intent.taskFamily && group.form === intent.form)
    const diagnosis = diagnosesResult.find(item => item.taskFamily === intent.taskFamily && item.form === intent.form
      && item.candidateKey === candidate?.key)
    const baseline = diagnosis ? groups.find(group => group.key === diagnosis.baselineKey) : undefined
    const reject = (reason: string): void => { withheld.push({ id: intent.id, reason }) }
    if (!candidate) { reject('noCandidateSamples'); continue }
    if (!diagnosis) { reject('noDiagnosis'); continue }
    if (!baseline) { reject('noBaseline'); continue }
    if (diagnosis.withheld) { reject(diagnosis.withheld); continue }
    if (candidate.profile?.moving) { reject('movingProfile'); continue }
    if (intent.baseRevision >= intent.proposedRevision) { reject('invalidRevisionOrder'); continue }
    const baselineMatches = intent.baseline.kind === 'legacy'
      ? baseline.profile === null
      : baseline.profile?.id === intent.baseline.profileId && baseline.profile.revision === intent.baseline.revision
    if (!baselineMatches) { reject('baselineMismatch'); continue }
    const baselineRate = baseline.rootSuccess.rate
    if (baselineRate === null) { reject('noBaselineRate'); continue }
    const evalSet = input.evalSet && input.evalSet.id === intent.experiment.evalSet.id && input.evalSet.revision === intent.experiment.evalSet.revision
      ? input.evalSet : undefined
    const holdout = evalSet ? evalSet.entries.filter(entry => entry.holdout && entry.taskFamily === intent.taskFamily && entry.form === intent.form).map(entry => entry.id) : []
    let required: number
    try { required = requiredSampleSize(baselineRate, intent.experiment.mde, intent.experiment.alpha, intent.experiment.power) }
    catch (error) {
      if (error instanceof EvolutionInputError && error.code === 'baselineAtCeiling') { reject('baselineAtCeiling'); continue }
      throw error
    }
    const plan: ExperimentPlan = {
      id: intent.id,
      taskFamily: intent.taskFamily,
      form: intent.form,
      candidate: { profileId: intent.profileId, revision: intent.proposedRevision, effectiveHash: candidate.profile!.effectiveHash },
      baseline: baseline.profile
        ? { kind: 'profile', profileId: baseline.profile.id, revision: baseline.profile.revision, effectiveHash: baseline.profile.effectiveHash }
        : { kind: 'legacy' },
      primaryMetric: 'root-success',
      mde: intent.experiment.mde,
      alpha: intent.experiment.alpha,
      power: intent.experiment.power,
      allocation: intent.experiment.allocation,
      evalSet: intent.experiment.evalSet,
      holdout,
      requiredPerGroup: required,
      guardrails: intent.experiment.guardrails,
      stopping: intent.experiment.stopping,
    }
    const replay = evidence.find(experiment => experiment.id === intent.id)
    const result = gate(plan, replay, evalSet, observationIds, [...new Set([...candidate.environments, ...baseline.environments])])
    gates.push(result)
    const status: EvolutionProposal['status'] = result.outcome === 'pass' ? 'ready-for-human-approval'
      : result.outcome === 'insufficient' ? 'pending-evidence' : 'not-adopted'
    const recommendation: EvolutionProposal['recommendation'] = result.outcome === 'pass' ? 'adopt'
      : result.outcome === 'insufficient' ? 'observe-more' : 'do-not-adopt'
    proposals.push({
      schema: 'evolution.proposal.v1',
      id: proposalIdOf(intent),
      status,
      recommendation,
      hypothesis: intent.hypothesis,
      confidence: diagnosis.confidence,
      evidence: { ...diagnosis.evidence, evalSet: intent.experiment.evalSet, holdout },
      scope: { taskFamily: intent.taskFamily, form: intent.form, profileId: intent.profileId, appliesTo: 'new-tickets-only' },
      expected: { primaryMetric: 'root-success', baselineRate: diagnosis.evidence.baseline.rate, candidateRate: diagnosis.evidence.candidate.rate,
        absoluteDelta: diagnosis.evidence.delta, mde: intent.experiment.mde, requiredPerGroup: required },
      risks: ['configuration drift if the live prompt changes', 'selection bias if the task family is not held constant',
        'eval contamination if holdout entries entered the observation window', 'permission misreading: profile content is not authorization'],
      rollback: { baseRevision: intent.baseRevision, proposedRevision: intent.proposedRevision, activeRevision: intent.baseRevision,
        operation: 'set-active-pointer-to-baseRevision', preservesBoundTickets: true,
        condition: 'a guardrail regression or a primary effect below the pre-registered MDE after activation' },
      baseRevision: intent.baseRevision,
      proposedRevision: intent.proposedRevision,
      diff: intent.diff,
      experiment: plan,
      gate: result,
      approval: { required: true, status: status === 'ready-for-human-approval' ? 'pending' : status === 'pending-evidence' ? 'blocked' : 'not-requested',
        decidedBy: null, decidedAt: null },
      applied: false,
      liveConfigChange: false,
    })
  }

  const proposalIds = new Set(proposals.map(proposal => proposal.id))
  if (proposalIds.size !== proposals.length) throw new EvolutionInputError('duplicateProposal', 'two intents produced the same proposal id')
  const totals = {
    groups: groups.length, samples: samples.records.length,
    roots: groups.reduce((sum, group) => sum + group.roots, 0),
    censored: groups.reduce((sum, group) => sum + group.censored, 0),
    legacy: groups.filter(group => group.profile === null).length,
    profiles: groups.filter(group => group.profile !== null).length,
    moving: groups.filter(group => group.moving).length,
  }
  return {
    schema: REPORT_SCHEMA,
    generatedAt,
    inputs: { samples: samples.records.length, evalSet: input.evalSet ? `${input.evalSet.id}@${input.evalSet.revision}` : null,
      intents: intents.length, experiments: evidence.length },
    observation: { totals, groups, diagnoses: diagnosesResult, withheld },
    proposals,
    gates,
    approvalQueue: queueOf(proposals, generatedAt),
    conclusion: conclusionOf(proposals, gates, samples.records.length, intents.length),
    guarantees: { liveConfiguration: 'unchanged', autoApply: false, authorizationFields: 'refused', privateText: 'refused', externalCredentials: false },
  }
}

/** A raw Ticket shape the exporter reads; only the sanitized fields are used. */
export interface TicketLike {
  id: string
  form?: string
  parentTicketId?: string
  channels?: { source?: string }[]
  ended?: { at?: string; outcome?: string }
  assignments?: {
    startedAt?: string
    endedReason?: string
    report?: { state?: string; at?: string; accepted?: unknown; review?: { deliverable?: { artifact?: { revision?: string } } } }
  }[]
  inputs?: { kind?: string; at?: string }[]
  delegation?: { resolution?: { kind?: string }; dispositions?: { decision?: string }[] }
  profile?: { id?: string; revision?: number; effective?: { hash?: string }; selection?: { moving?: boolean; fallback?: boolean } }
  decisionAt?: string
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; messages: number } | null
  notifications?: number | null
}

/**
 * Map raw Ticket records into sanitized samples without copying titles, summaries, prompts or any other
 * text. The caller supplies the opaque sample id (the exporter hashes the ticket id) and any decision
 * time or usage it could read.
 */
export function samplesFromTickets(tickets: TicketLike[], options: { generatedAt: string; source: string; environment: { dshVersion: string; policyVersion: string } }): SampleSet {
  const records: EvolutionSample[] = []
  for (const ticket of tickets) {
    const form: SampleForm = ticket.form === 'lightweight' ? 'lightweight' : 'tracked'
    const kind: SampleKind = ticket.parentTicketId ? 'child' : form === 'lightweight' ? 'lightweight' : 'root'
    const firstStart = ticket.assignments?.find(assignment => assignment.startedAt)?.startedAt
    const firstReady = ticket.assignments?.find(assignment => assignment.report?.state === 'ready' && assignment.report.at)?.report?.at
    const latest = ticket.assignments?.findLast(assignment => assignment.report)?.report
    const returned = ticket.assignments?.some(assignment => assignment.endedReason === 'returned') === true
      || ticket.delegation?.dispositions?.some(disposition => disposition.decision === 'returned') === true
    const resumedAfterReady = firstReady !== undefined
      && ticket.inputs?.some(input => input.kind === 'resumed' && input.at !== undefined && input.at > firstReady) === true
    const seconds = (from: string | undefined, to: string | undefined): number | null => {
      if (!from || !to) return null
      const start = Date.parse(from), end = Date.parse(to)
      return Number.isNaN(start) || Number.isNaN(end) || end < start ? null : (end - start) / 1000
    }
    let profile: EvolutionSample['profile'] = null
    if (ticket.profile) {
      if (!ticket.profile.id || !ticket.profile.revision || !ticket.profile.effective?.hash) {
        throw new EvolutionInputError('profileHashMissing', 'ticket.profile.effective.hash')
      }
      profile = { id: ticket.profile.id, revision: ticket.profile.revision, effectiveHash: ticket.profile.effective.hash,
        moving: ticket.profile.selection?.moving === true, fallback: ticket.profile.selection?.fallback === true }
    }
    const ended = ticket.ended?.at && ticket.ended.outcome && OUTCOMES.has(ticket.ended.outcome as SampleOutcome)
      ? { outcome: ticket.ended.outcome as SampleOutcome, at: ticket.ended.at } : null
    const reportState = latest?.state
    const failureState: FailureState = reportState === 'blocked' || reportState === 'failed' ? reportState
      : ended?.outcome === 'stopped' || ended?.outcome === 'dropped' ? ended.outcome : null
    const endedReason = ticket.assignments?.findLast(assignment => assignment.endedReason)?.endedReason
    const failureReason = failureState !== null && endedReason && CODE.test(endedReason) ? endedReason : null
    records.push({
      id: ticket.id,
      profile,
      taskFamily: `${ticket.channels?.[0]?.source ?? 'unknown'}/${form}`,
      kind,
      form,
      ended,
      reworked: returned || resumedAfterReady,
      review: { reviewed: latest?.review?.deliverable !== undefined, accepted: latest?.accepted !== undefined, comments: null },
      failure: { state: failureState, reasonCode: failureReason },
      latency: { decisionToDispatchSeconds: seconds(ticket.decisionAt, firstStart), dispatchToReadySeconds: seconds(firstStart, firstReady), readyToEndSeconds: seconds(firstReady, ended?.at) },
      tokens: ticket.usage
        ? { input: ticket.usage.input, output: ticket.usage.output, cacheRead: ticket.usage.cacheRead, cacheWrite: ticket.usage.cacheWrite, reasoning: ticket.usage.reasoning }
        : null,
      notifications: ticket.notifications ?? null,
      environment: { dshVersion: options.environment.dshVersion, policyVersion: options.environment.policyVersion,
        source: ticket.channels?.[0]?.source ?? 'unknown' },
    })
  }
  const endedTimes = records.flatMap(record => record.ended ? [record.ended.at] : []).sort()
  return parseSampleSet({
    schema: SAMPLE_SCHEMA,
    generatedAt: options.generatedAt,
    source: options.source,
    window: { from: endedTimes[0] ?? options.generatedAt, to: endedTimes.at(-1) ?? options.generatedAt },
    records,
  })
}