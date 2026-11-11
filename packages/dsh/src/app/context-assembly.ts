/**
 * The host-side six-layer context assembler (docs/011 §C.3, docs/019).
 *
 * It reads facts that already exist — Policy and prompt revisions, the origin Trigger, the derived group, the root
 * Ticket and its Mandate, a child's delegation and the Assignment's agent facts — and produces two things: the entries
 * the first worker message carries (with text), and a read-only snapshot on the Assignment (without text). It never
 * grants an action, never writes a Ticket, and never reads another Ticket's private work.
 *
 * Presence comes first: a dimension whose subject does not exist contributes nothing and appears in `absent`. For the
 * dimensions that do exist, entries merge by key under one rule: `constraint` before scope, then the more specific
 * scope among equal-strength defaults. Equal strength with no scope ordering is a conflict: the assembly stops and the
 * Assignment waits for a person instead of guessing. A blocked snapshot is recorded before the Assignment is asked to
 * wait, so the reason is reviewable and replayable.
 */
import { createHash } from 'node:crypto'
import { CONTEXT_DIMENSIONS, goalOf, rootTicketIdOf, ticketForm, latestReport, type Assignment, type ContextBlock, type ContextConflict,
  type ContextDimension, type ContextEntry, type ContextEntryManifest, type ContextMergeDecision, type ContextSnapshot,
  type ContextStrength, type Ticket, type Trigger } from '@superagent/kernel'
import { contextGroupDimension, type ContextGroupView } from './context-groups.ts'

/** Extra facts a deployment may supply for a dimension with no built-in carrier yet (preferences, terminology). */
export interface ContextAssemblyHost {
  ticket(id: string): Ticket | undefined
  trigger(id: string): Trigger | undefined
  /** The Ticket's shared space, or the root's for a child; the assembler inherits a child's group from its root. */
  group(ticket: Ticket): ContextGroupView | undefined
  /** The active Policy version, an organization-level fact. */
  policyVersion(): string
  /** The active worker prompt revision, the organization's delivery guidance reference. */
  promptRevision(): number
  /** Entries from a host-owned dimension source; they merge under the same rules and carry no authority. */
  entries?(ticket: Ticket): readonly ContextEntry[]
}

/** One entry with the truncation flag the manifest needs; the text is what the worker receives. */
export interface ContextPromptEntry {
  key: string
  dimension: ContextDimension
  source: string
  scope: string
  strength: ContextStrength
  inheritance: ContextEntry['inheritance']
  truncation: number
  text: string
  truncated?: true
}

/** The bounded, JSON-ready context block a worker's first message carries, or a changed later Assignment carries. */
export interface ContextPrompt {
  state: 'assembled'
  dimensions: ContextDimension[]
  absent: ContextDimension[]
  sources: Partial<Record<ContextDimension, string>>
  hash: string
  contentHash: string
  entries: ContextPromptEntry[]
}

/** A context assembly: assembled entries and snapshot, or the blocked snapshot and the question a person must answer. */
export type ContextAssembly =
  | { state: 'assembled'; snapshot: ContextSnapshot; prompt: ContextPrompt }
  | { state: 'blocked'; snapshot: ContextSnapshot; block: { summary: string; question: string } }

/** Raised internally when a source that owns a dimension cannot be read; the assembler turns it into a blocked result. */
class Unreadable extends Error {
  constructor(readonly dimension: ContextDimension, readonly cause: unknown) {
    super(`${dimension} source is unreadable`)
  }
}
/** Raised when a required dimension's subject does not exist, which is a fail-closed condition, not an absence. */
class Missing extends Error {
  constructor(readonly dimension: ContextDimension, message: string) { super(message) }
}

const stable = (value: unknown): string => JSON.stringify(value)
const digest = (text: string): string => `sha256:${createHash('sha256').update(text).digest('hex')}`
const DIMENSION_ORDER = new Map(CONTEXT_DIMENSIONS.map((dimension, index) => [dimension, index]))
/** How specific a scope is, read from its prefix; only equal-strength defaults use it. */
const SCOPE_RANK: Record<string, number> = { organization: 0, user: 1, group: 2, task: 3, subtask: 4, agent: 5 }
const scopeRank = (scope: string): number => SCOPE_RANK[scope.split(':', 1)[0] ?? ''] ?? -1
/**
 * A group's scope is the Source's own `<source>:<space>` vocabulary, so it has no prefix; the dimension supplies the rank
 * then. A prefixed scope stays authoritative for entries a host adds under a narrower vocabulary.
 */
const entryRank = (entry: Pick<ContextEntry, 'scope' | 'dimension'>): number =>
  Math.max(scopeRank(entry.scope), SCOPE_RANK[entry.dimension] ?? -1)
const safeMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

type ResolvedEntry = ContextEntry & { truncated?: true }

/** Reads one dimension's source, attributing any failure to that dimension for the blocked snapshot. */
function read<T>(dimension: ContextDimension, work: () => T): T {
  try { return work() } catch (error) { throw new Unreadable(dimension, error) }
}

/** The organization dimension: the active Policy and worker prompt revisions. Their text already reaches the system prompt. */
function organizationDimension(policy: string, prompt: number): ContextEntry[] {
  return [
    { key: 'organization:policy', dimension: 'organization', source: 'policy', scope: `organization:${policy}`, strength: 'constraint',
      inheritance: 'inherit', truncation: 360,
      text: `Active organization policy ${policy}. Authorization, approval and acceptance are checked separately; this context grants nothing.` },
    { key: 'organization:prompts', dimension: 'organization', source: 'prompts', scope: `organization:prompt-${prompt}`, strength: 'default',
      inheritance: 'inherit', truncation: 280,
      text: `Worker prompt revision ${prompt} carries the team's communication, scope and delivery guidance.` },
  ]
}

/** The user dimension: the person who started the root Ticket, from the origin Trigger; a bot origin has no user dimension. */
function userDimension(origin: Trigger): ContextEntry[] {
  if (!origin.human) return []
  if (!origin.actor.id) throw new Missing('user', 'origin Trigger has no actor identity')
  return [{
    key: 'user:actor', dimension: 'user', source: `trigger:${origin.id}`, scope: `user:${origin.actor.source}:${origin.actor.id}`,
    strength: 'default', inheritance: 'private', truncation: 200,
    text: `Started by ${origin.actor.id} on ${origin.actor.source}. The identity is context, not permission.`,
  }]
}

/** The group dimension, inherited from the root for a child. The T5-03 projection supplies the same entry fields. */
function groupDimension(host: ContextAssemblyHost, root: Ticket): ContextEntry[] {
  const group = read('group', () => host.group(root))
  if (!group) return []
  return [{ ...contextGroupDimension(group), dimension: 'group' }]
}

/** The task dimension: the root's goal, Mandate scope reference and origin. It is authorization's pointer, not a copy. */
function taskDimension(root: Ticket, origin: Trigger): ContextEntry[] {
  const scope = `task:${root.id}`
  if (!root.mandate) throw new Missing('task', 'the root Ticket has no Mandate')
  return [
    { key: 'task:goal', dimension: 'task', source: `ticket:${root.id}`, scope, strength: 'default', inheritance: 'inherit', truncation: 600,
      text: `Root goal: ${goalOf(root).statement}.` },
    { key: 'task:mandate', dimension: 'task', source: `ticket:${root.id}#mandate`, scope, strength: 'constraint', inheritance: 'inherit',
      truncation: 400,
      text: 'The root Mandate and its scope are referenced, not copied; the action gate decides actions and this context grants nothing.' },
    { key: 'task:origin', dimension: 'task', source: `trigger:${origin.id}`, scope, strength: 'default', inheritance: 'inherit', truncation: 240,
      text: `Origin: ${origin.source}; Trigger ${origin.id}.` },
  ]
}

/** The subtask dimension: this child's own delegation and its latest local result, never a parent's private process. */
function subtaskDimension(ticket: Ticket): ContextEntry[] {
  const delegation = ticket.delegation
  if (!delegation) throw new Missing('subtask', 'the child Ticket has no delegation')
  const scope = `subtask:${ticket.id}`
  const entries: ContextEntry[] = [
    { key: 'subtask:goal', dimension: 'subtask', source: `ticket:${ticket.id}#delegation`, scope, strength: 'constraint',
      inheritance: 'private', truncation: 600, text: `Child goal: ${goalOf(ticket).statement}.` },
    { key: 'subtask:attempt', dimension: 'subtask', source: `ticket:${ticket.id}#delegation`, scope, strength: 'default',
      inheritance: 'private', truncation: 120, text: `Delegation attempt ${delegation.attempt}.` },
  ]
  if (delegation.scope) entries.push({ key: 'subtask:scope', dimension: 'subtask', source: `ticket:${ticket.id}#delegation`, scope,
    strength: 'default', inheritance: 'private', truncation: 400, text: `Child scope hint: ${delegation.scope}.` })
  const report = latestReport(ticket)
  if (report) entries.push({ key: 'subtask:last-report', dimension: 'subtask', source: `ticket:${ticket.id}#report`, scope,
    strength: 'default', inheritance: 'private', truncation: 600,
    text: `Previous attempt reported ${report.state}: ${report.summary.slice(0, 300)}` })
  return entries
}

/** The agent dimension: the worker role, workspace, Assignment and the profile the Session runs under. */
function agentDimension(ticket: Ticket, assignment: Assignment | undefined): ContextEntry[] {
  if (!assignment) throw new Missing('agent', 'a tracked Ticket has no Assignment')
  const scope = `agent:worker-${ticket.id}`
  const profile = ticket.profile
  return [
    { key: 'agent:role', dimension: 'agent', source: `worker:${ticket.id}`, scope, strength: 'default', inheritance: 'private',
      truncation: 260, text: `Worker role; workspace ${ticket.execution?.directory ?? 'the host workspace'}.` },
    { key: 'agent:profile', dimension: 'agent',
      source: profile ? `profile:${profile.id}@${profile.revision}` : 'profile:legacy', scope, strength: 'default', inheritance: 'private',
      truncation: 260, text: profile
        ? `Profile ${profile.id}@${profile.revision}; effective ${profile.effective.hash}.`
        : 'Legacy profile: role settings, live prompt and role work tools.' },
  ]
}

/** Applies the character ceiling to one entry and remembers that it did. */
function truncate(entry: ContextEntry): ResolvedEntry {
  if (!entry.key.trim() || !entry.text.trim()) throw new Error('context entry has an empty key or text')
  if (!Number.isInteger(entry.truncation) || entry.truncation <= 0) throw new Error(`context entry ${entry.key} has no positive truncation`)
  const text = entry.text.slice(0, entry.truncation)
  return { ...entry, text, ...(text.length < entry.text.length ? { truncated: true as const } : {}) }
}

/**
 * Merges entries by key. A single constraint beats any default; otherwise the entry with the highest scope rank wins.
 * Different text at the same strength and scope is a conflict: no source is guessed, and the caller stops the assembly.
 */
export function mergeContextEntries(entries: readonly ContextEntry[]): { entries: ResolvedEntry[]; merges: ContextMergeDecision[]; conflicts: ContextConflict[] } {
  const byKey = new Map<string, ResolvedEntry[]>()
  for (const entry of entries) {
    const resolved = truncate(entry)
    const group = byKey.get(resolved.key)
    if (group) group.push(resolved)
    else byKey.set(resolved.key, [resolved])
  }
  const chosen: ResolvedEntry[] = []
  const merges: ContextMergeDecision[] = []
  const conflicts: ContextConflict[] = []
  for (const [key, group] of [...byKey].sort(([left], [right]) => left.localeCompare(right))) {
    if (group.length === 1) { chosen.push(group[0]!); continue }
    const label = (entry: ResolvedEntry) => `${entry.dimension}:${entry.source}`
    const conflict = (strength: ContextStrength, candidates: ResolvedEntry[]) => conflicts.push({ key, strength,
      dimensions: [...new Set(candidates.map(entry => entry.dimension))].sort((left, right) => DIMENSION_ORDER.get(left)! - DIMENSION_ORDER.get(right)!),
      sources: candidates.map(label) })
    const constraints = group.filter(entry => entry.strength === 'constraint')
    const defaults = group.filter(entry => entry.strength === 'default')
    // Same text is agreement, not a conflict: among agreeing constraints the most specific scope wins, and an agreeing
    // constraint still beats an agreeing default even though the worker would read the same characters either way.
    if (constraints.length) {
      if (new Set(constraints.map(entry => entry.text)).size > 1) { conflict('constraint', constraints); continue }
      const rank = Math.max(...constraints.map(entryRank))
      const winner = constraints.filter(entry => entryRank(entry) === rank).sort((left, right) => label(left).localeCompare(label(right)))[0]!
      chosen.push(winner)
      merges.push({ key, winner: label(winner), losers: group.filter(entry => entry !== winner).map(label) })
      continue
    }
    const rank = Math.max(...defaults.map(entryRank))
    const top = defaults.filter(entry => entryRank(entry) === rank)
    // A more specific default wins even when its text differs; only defaults at the same rank with different text are unresolved.
    if (new Set(top.map(entry => entry.text)).size > 1) { conflict('default', top); continue }
    const winner = [...top].sort((left, right) => label(left).localeCompare(label(right)))[0]!
    chosen.push(winner)
    merges.push({ key, winner: label(winner), losers: group.filter(entry => entry !== winner).map(label) })
  }
  return { entries: chosen.sort((left, right) => DIMENSION_ORDER.get(left.dimension)! - DIMENSION_ORDER.get(right.dimension)!
    || left.key.localeCompare(right.key)),
  merges, conflicts }
}

/** The snapshot fields, with entry text replaced by its digest and character count. */
function manifestOf(entry: ResolvedEntry): ContextEntryManifest {
  return { key: entry.key, dimension: entry.dimension, source: entry.source, scope: entry.scope, strength: entry.strength,
    inheritance: entry.inheritance, truncation: entry.truncation, chars: entry.text.length, digest: digest(entry.text),
    ...(entry.truncated ? { truncated: true as const } : {}) }
}

/** Builds a snapshot and its stable hash from the already-resolved facts; no text enters the snapshot. */
function snapshotOf(input: { state: 'assembled' | 'blocked'; at: string; ticket: Ticket; assignment?: Assignment | undefined;
  entries: ResolvedEntry[]; merges: ContextMergeDecision[]; conflicts: ContextConflict[]; present: ContextDimension[];
  absent: ContextDimension[]; sources: Partial<Record<ContextDimension, string>>; blocked?: ContextBlock }): ContextSnapshot {
  const entries = input.entries.map(manifestOf)
  const contentHash = digest(stable({ dimensions: input.present, absent: input.absent, entries, merges: input.merges, conflicts: input.conflicts }))
  const base = { state: input.state, assembledAt: input.at, ticketId: input.ticket.id, rootTicketId: rootTicketIdOf(input.ticket),
    ...(input.assignment ? { assignmentId: input.assignment.id } : {}), dimensions: input.present, absent: input.absent,
    entries, merges: input.merges, conflicts: input.conflicts, sources: input.sources, contentHash,
    ...(input.blocked ? { blocked: input.blocked } : {}) }
  // The hash covers facts, not when they were read: a replay at a later time must compare equal.
  const { assembledAt: _readAt, ...facts } = base
  return { ...base, hash: digest(stable(facts)) }
}

/** The prompt block: entry text plus the same manifest facts, bounded and JSON-ready. */
function promptOf(snapshot: ContextSnapshot, entries: ResolvedEntry[]): ContextPrompt {
  return { state: 'assembled', dimensions: snapshot.dimensions, absent: snapshot.absent, sources: snapshot.sources, hash: snapshot.hash,
    contentHash: snapshot.contentHash,
    entries: entries.map(entry => ({ key: entry.key, dimension: entry.dimension, source: entry.source, scope: entry.scope,
      strength: entry.strength, inheritance: entry.inheritance, truncation: entry.truncation, text: entry.text,
      ...(entry.truncated ? { truncated: true as const } : {}) })) }
}

/** A blocked assembly: the snapshot records why, and the question asks a person rather than filling in a default. */
function blocked(ticket: Ticket, at: string, block: ContextBlock, conflicts: ContextConflict[] = [], entries: ResolvedEntry[] = [],
  merges: ContextMergeDecision[] = [], present: ContextDimension[] = [], sources: Partial<Record<ContextDimension, string>> = {}): ContextAssembly {
  const absent = CONTEXT_DIMENSIONS.filter(dimension => !present.includes(dimension))
  const snapshot = snapshotOf({ state: 'blocked', at, ticket, entries, merges, conflicts, present, absent, sources, blocked: block })
  const summary = block.reason === 'conflict'
    ? `Context assembly blocked on a context conflict: ${block.detail}`
    : `Context assembly blocked: ${block.detail}`
  const question = block.reason === 'conflict'
    ? `Two context entries disagree and the assembly did not choose one. Decide which applies, then resume the Ticket: ${block.detail}.`
    : `Context assembly could not run: ${block.detail}. Restore the missing or unreadable source, then resume the Ticket.`
  return { state: 'blocked', snapshot, block: { summary: summary.slice(0, 300), question: question.slice(0, 500) } }
}

/**
 * Assembles one Assignment's six-layer context. `assignment` is absent only for a lightweight Ticket, whose inline
 * execution has no worker Session and therefore only the task dimension. The returned snapshot is stored by the caller;
 * this function writes nothing.
 */
export function assembleContext(host: ContextAssemblyHost, ticket: Ticket, assignment?: Assignment, now = new Date()): ContextAssembly {
  const at = now.toISOString()
  try {
    const root = ticket.parentTicketId ? host.ticket(ticket.rootTicketId ?? ticket.parentTicketId) : ticket
    if (!root) throw new Missing('task', 'the root Ticket is unavailable')
    if (!root.mandate) throw new Missing('task', 'the root Ticket has no Mandate')
    const origin = host.trigger(root.origin.triggerId)
    if (!origin) throw new Missing('task', 'the origin Trigger is unavailable')

    const task = taskDimension(root, origin)
    // A lightweight Ticket has no Assignment or agent; its assembly is exactly the task dimension (docs/011 §C.3).
    if (ticketForm(ticket) === 'lightweight') {
      const merged = mergeContextEntries(task)
      if (merged.conflicts.length) {
        return blocked(ticket, at, { reason: 'conflict', detail: merged.conflicts.map(conflict => conflict.key).join(', ') },
          merged.conflicts, merged.entries, merged.merges, ['task'], { task: `ticket:${root.id}` })
      }
      const snapshot = snapshotOf({ state: 'assembled', at, ticket, entries: merged.entries, merges: merged.merges, conflicts: [],
        present: ['task'], absent: CONTEXT_DIMENSIONS.filter(dimension => dimension !== 'task'),
        sources: { task: `ticket:${root.id}` } })
      return { state: 'assembled', snapshot, prompt: promptOf(snapshot, merged.entries) }
    }

    const policy = read('organization', () => host.policyVersion())
    const prompt = read('organization', () => host.promptRevision())
    const organization = organizationDimension(policy, prompt)
    const user = userDimension(origin)
    const group = groupDimension(host, root)
    const subtask = ticket.parentTicketId ? subtaskDimension(ticket) : []
    const agent = agentDimension(ticket, assignment)
    const extra = host.entries?.(ticket) ?? []
    const carried = new Set([...organization, ...user, ...group, ...task, ...subtask, ...agent].map(entry => entry.dimension))
    for (const entry of extra) {
      if (!DIMENSION_ORDER.has(entry.dimension)) throw new Error(`unknown context dimension ${String(entry.dimension)}`)
      // Presence first: extra entries add facts to a dimension that exists, never conjure one the subject lacks.
      if (!carried.has(entry.dimension)) throw new Error(`context dimension ${entry.dimension} has no present subject`)
    }

    const merged = mergeContextEntries([...organization, ...user, ...group, ...task, ...subtask, ...agent, ...extra])
    const present = [...new Set([...organization, ...user, ...group, ...task, ...subtask, ...agent, ...extra].map(entry => entry.dimension))]
      .sort((left, right) => DIMENSION_ORDER.get(left)! - DIMENSION_ORDER.get(right)!)
    const sources: Partial<Record<ContextDimension, string>> = { organization: `policy:${policy};prompt:${prompt}`,
      task: `ticket:${root.id}`, agent: assignment ? `assignment:${assignment.id}` : '' }
    if (user.length) sources.user = `trigger:${origin.id}`
    if (group.length) sources.group = `${group[0]!.scope}`
    if (subtask.length) sources.subtask = `ticket:${ticket.id}#delegation`
    if (merged.conflicts.length) {
      return blocked(ticket, at, { reason: 'conflict', detail: merged.conflicts.map(conflict => conflict.key).join(', ') },
        merged.conflicts, merged.entries, merged.merges, present, sources)
    }
    const absent = CONTEXT_DIMENSIONS.filter(dimension => !present.includes(dimension))
    const snapshot = snapshotOf({ state: 'assembled', at, ticket, assignment, entries: merged.entries, merges: merged.merges,
      conflicts: [], present, absent, sources })
    return { state: 'assembled', snapshot, prompt: promptOf(snapshot, merged.entries) }
  } catch (error) {
    if (error instanceof Unreadable) {
      return blocked(ticket, at, { reason: 'unreadable', dimension: error.dimension,
        detail: `${error.dimension} source could not be read: ${safeMessage(error.cause)}` })
    }
    if (error instanceof Missing) return blocked(ticket, at, { reason: 'missing', dimension: error.dimension, detail: error.message })
    return blocked(ticket, at, { reason: 'unreadable', detail: `context assembly failed: ${safeMessage(error)}` })
  }
}