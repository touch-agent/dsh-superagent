#!/usr/bin/env node
/**
 * Offline evolution loop CLI.
 *
 * It reads a sanitized sample set, an optional eval-set manifest, optional candidate experiences and
 * optional holdout replay evidence, then writes a deterministic report and a document-only approval
 * queue. It never opens the Store, a profile registry or a source account; the only writes are the two
 * files under `--out`. Applying a proposal is a human action through the existing profile panel.
 *
 * Usage:
 *   node scripts/evolution/run.mjs --samples samples.json --out .artifacts/evolution
 *   node scripts/evolution/run.mjs --samples samples.json --evalset evalset.json \
 *     --intents intents.json --evidence results.json --out out/
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  EvolutionInputError,
  parseEvalResults,
  parseEvalSet,
  parseIntents,
  parseSampleSet,
  runEvolution,
} from './core.ts'

/** Parse the command line into file paths; every input is optional except samples and out. */
function options(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name === '--help' || name === '-h') { console.log('usage: run.mjs --samples <file> --out <dir> [--evalset <file>] [--intents <file>] [--evidence <file>] [--at <ISO>]'); process.exit(0) }
    if (!name?.startsWith('--')) throw new Error(`unexpected argument: ${name}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    values.set(name.slice(2), value)
    index += 1
  }
  if (!values.get('samples') || !values.get('out')) throw new Error('--samples and --out are required')
  return {
    samples: values.get('samples'),
    out: values.get('out'),
    evalSet: values.get('evalset'),
    intents: values.get('intents'),
    evidence: values.get('evidence'),
    at: values.get('at'),
  }
}

/** Read and parse one JSON input; an unreadable file names itself without printing its content. */
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
    throw new EvolutionInputError('unreadableInput', `${path}: ${error instanceof Error ? error.message : 'invalid JSON'}`)
  }
}

try {
  const args = options(process.argv.slice(2))
  const samples = parseSampleSet(readJson(args.samples))
  const evalSet = args.evalSet ? parseEvalSet(readJson(args.evalSet)) : undefined
  const intents = args.intents ? parseIntents(readJson(args.intents)) : undefined
  const evidence = args.evidence ? parseEvalResults(readJson(args.evidence)) : undefined
  const report = runEvolution({ samples, evalSet, intents, evidence, generatedAt: args.at })
  mkdirSync(args.out, { recursive: true })
  writeFileSync(join(args.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(args.out, 'approval-queue.json'), `${JSON.stringify(report.approvalQueue, null, 2)}\n`)
  console.log(`evolution: ${report.conclusion.kind} — ${report.conclusion.summary}`)
  console.log(`observed ${report.observation.totals.samples} samples in ${report.observation.totals.groups} group(s); ${report.proposals.length} proposal(s), ${report.approvalQueue.items.length} awaiting human approval`)
  const outcomes = ['improvement', 'no-difference', 'guardrail-regression', 'insufficient-evidence']
    .map(outcome => `${outcome}=${report.valueGates.filter(result => result.outcome === outcome).length}`)
  console.log(`value gate: ${outcomes.join(', ')}; unknown cost is reported as unknown and never as zero`)
  console.log(`wrote ${join(args.out, 'report.json')} and ${join(args.out, 'approval-queue.json')}; no live configuration was changed`)
} catch (error) {
  if (error instanceof EvolutionInputError) {
    console.error(`evolution: rejected input — ${error.message}`)
    process.exitCode = 2
  } else {
    console.error(`evolution: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}