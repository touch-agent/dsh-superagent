#!/usr/bin/env node
/**
 * Read-only telemetry export for the offline evolution loop.
 *
 * The exporter opens the orchestrator SQLite store with `readOnly: true`, reads the most recently
 * ended Tickets, and writes a sanitized sample set. It copies no titles, summaries, prompts, review
 * bodies, messages or account names: every Ticket id becomes a short hash, and free-text reasons are
 * dropped unless they are a short reason code. It never writes the database, calls a model or touches
 * a profile.
 *
 * Usage:
 *   node scripts/evolution/export.mjs --db <orchestrator.sqlite> --out samples.json --limit 10
 *
 * The output is the `evolution.samples.v1` input `scripts/evolution/run.mjs` expects.
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { samplesFromTickets } from './core.ts'

/** The command line: a database path, an output path and optional window/environment labels. */
function options(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (!name?.startsWith('--')) throw new Error(`unexpected argument: ${name}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`)
    values.set(name.slice(2), value)
    index += 1
  }
  if (!values.get('db') || !values.get('out')) throw new Error('--db and --out are required')
  const limit = values.get('limit') === undefined ? 10 : Number(values.get('limit'))
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('--limit must be an integer from 1 to 10000')
  return {
    db: values.get('db'),
    out: values.get('out'),
    limit,
    at: values.get('at'),
    dshVersion: values.get('dsh-version') ?? 'unknown',
    policyVersion: values.get('policy-version') ?? 'unknown',
  }
}

/** Parse a stored JSON column, or return undefined for a row this exporter does not understand. */
function json(value) {
  if (typeof value !== 'string') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

/** Read the token usage the host recorded for a worker Session, when present. */
function usageOf(db, ticketId) {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(`session-usage:worker-${ticketId}`)
  const value = row ? json(row.value) : undefined
  if (!value || typeof value !== 'object') return null
  const fields = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']
  return fields.every(field => typeof value[field] === 'number') ? value : null
}

/** Read a Decision's instant for a Ticket, when the Ticket has one. */
function decisionAt(db, decisionId) {
  if (typeof decisionId !== 'string') return undefined
  const row = db.prepare('SELECT value FROM decision WHERE id = ?').get(decisionId)
  return row ? json(row.value)?.at : undefined
}

/** Keep only the fields the analyzer reads, so a later schema field cannot become an accidental export. */
function sanitized(ticket, id, decisionAt, usage) {
  return {
    id,
    form: ticket.form,
    parentTicketId: ticket.parentTicketId,
    channels: Array.isArray(ticket.channels) ? ticket.channels.map(channel => ({ source: channel.source })) : [],
    ended: ticket.ended ? { at: ticket.ended.at, outcome: ticket.ended.outcome } : undefined,
    assignments: Array.isArray(ticket.assignments) ? ticket.assignments.map(assignment => ({
      startedAt: assignment.startedAt,
      endedReason: assignment.endedReason,
      report: assignment.report ? {
        state: assignment.report.state,
        at: assignment.report.at,
        accepted: assignment.report.accepted ? {} : undefined,
        review: assignment.report.review?.deliverable ? { deliverable: { artifact: { revision: 'present' } } } : undefined,
      } : undefined,
    })) : [],
    inputs: Array.isArray(ticket.inputs) ? ticket.inputs.map(input => ({ kind: input.kind, at: input.at })) : [],
    delegation: ticket.delegation ? {
      resolution: ticket.delegation.resolution ? { kind: ticket.delegation.resolution.kind } : undefined,
      dispositions: Array.isArray(ticket.delegation.dispositions)
        ? ticket.delegation.dispositions.map(disposition => ({ decision: disposition.decision })) : undefined,
    } : undefined,
    profile: ticket.profile ? {
      id: ticket.profile.id,
      revision: ticket.profile.revision,
      effective: ticket.profile.effective ? { hash: ticket.profile.effective.hash } : undefined,
      selection: { moving: ticket.profile.selection?.moving, fallback: ticket.profile.selection?.fallback },
    } : undefined,
    decisionAt,
    usage,
    notifications: null,
  }
}

const args = options(process.argv.slice(2))
const db = new DatabaseSync(args.db, { readOnly: true })
try {
  const rows = db.prepare('SELECT value FROM ticket WHERE json_extract(value, ?) IS NOT NULL ORDER BY json_extract(value, ?) DESC LIMIT ?')
    .all('$.ended.at', '$.ended.at', args.limit)
  const tickets = []
  let skippedProfile = 0
  for (const row of rows) {
    const ticket = json(row.value)
    if (!ticket || typeof ticket.id !== 'string') continue
    if (ticket.profile && !ticket.profile.effective?.hash) { skippedProfile += 1; continue }
    const id = createHash('sha256').update(ticket.id).digest('hex').slice(0, 16)
    tickets.push(sanitized(ticket, id, decisionAt(db, ticket.decisionId), usageOf(db, ticket.id)))
  }
  const generatedAt = args.at ?? new Date().toISOString()
  const samples = samplesFromTickets(tickets, {
    generatedAt,
    source: 'live-store',
    environment: { dshVersion: args.dshVersion, policyVersion: args.policyVersion },
  })
  writeFileSync(args.out, `${JSON.stringify(samples, null, 2)}\n`)
  const roots = samples.records.filter(record => record.kind === 'root').length
  const ended = samples.records.filter(record => record.ended !== null).length
  console.log(`exported ${samples.records.length} sanitized samples (${roots} roots, ${ended} ended) to ${args.out}`)
  if (skippedProfile > 0) console.warn(`skipped ${skippedProfile} ticket(s) whose profile snapshot had no effective hash`)
} finally {
  db.close()
}