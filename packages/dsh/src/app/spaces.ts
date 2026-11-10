/**
 * Spaces: the read-only projection of `Execution.directory` and the write lease that keeps one writer per directory.
 *
 * A Space is not a second aggregate: its identity is the directory a Ticket's Execution names, and its state is derived
 * from that directory, the Ticket's Assignments and the `space_lease` row. `space_lease` only coordinates writers; it grants
 * nothing and never joins an authorization decision.
 */
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { latestReport, liveTicket, runningAssignment, ticketForm, type Ticket } from '@superagent/kernel'
import type { SQLInputValue } from 'node:sqlite'
import { activityStatusOf, type ActivityStatus } from './activity.ts'
import type { Store } from './store.ts'

/** The kinds a space can have. `project` is reserved for a deployment baseline and is never invented from a Ticket. */
export type SpaceKind = 'root' | 'project' | 'checkout' | 'scratch' | 'remote' | 'unknown'
/** The directory state a person reads; lease state stays separate in `SpaceLeaseView`. */
export type SpaceState = 'planned' | 'preparing' | 'ready' | 'active' | 'legacy' | 'failed'
export type SpaceLeaseState = 'reserved' | 'active' | 'released' | 'stale'

/** One persisted write lease. A released row stays for audit; a stale row may be taken over by a later holder. */
export interface SpaceLease {
  locatorKey: string
  ticketId: string
  assignmentId?: string
  sessionId?: string
  processEpoch: number
  epoch: number
  state: SpaceLeaseState
  reservedAt: string
  activatedAt?: string
  releasedAt?: string
  updatedAt: string
}

/** Who currently writes a space, as E1 may name it: a Ticket title and status, never an internal id or path. */
export interface SpaceHolder {
  ticketTitle: string
  status: ActivityStatus
  /** True when the holder is the Ticket being viewed. */
  own: boolean
}

/** The read-only `space` projection attached to a task row. It never carries the absolute locator. */
export interface SpaceView {
  kind: SpaceKind
  /** Display name: the worktree short name with the Ticket id suffix removed. */
  name: string
  branch?: string
  state: SpaceState
  holder?: SpaceHolder
  /** The child directory is still nested inside its parent's directory. */
  legacy?: true
  /** Last Ticket activity, relative on E1 and exact on E2. */
  lastAt?: string
}

/** The lease shown in E2 only: epoch and process identity are diagnostics, not E1 content. */
export interface SpaceLeaseView {
  state: SpaceLeaseState
  epoch: number
  processEpoch: number
  stale: boolean
  reservedAt: string
  activatedAt?: string
  releasedAt?: string
}

/** One E2 space row: the projection plus the path, owning Ticket and lease diagnostics. */
export interface SpaceRow extends SpaceView {
  ticket: { id: string; title: string; status: ActivityStatus }
  /** Absolute directory; E2 may copy it, E1 never renders it. */
  locator: string
  lease?: SpaceLeaseView
  lastAt?: string
}

/** The `GET spaces` payload E2 reads: every tracked Ticket's space, newest activity first. */
export interface SpaceRowsView { generatedAt: string; rows: SpaceRow[] }

const now = (): string => new Date().toISOString()
const CURRENT_LEASE = "state IN ('reserved', 'active', 'stale')"

/** A plan-time locator: the real parent directory plus the directory's own name, so two spellings of one parent compare equal. */
export async function locatorKeyOf(directory: string): Promise<string> {
  const parent = dirname(directory)
  await mkdir(parent, { recursive: true })
  return join(await realpath(parent), basename(directory))
}

/** The same locator without waiting for the file system; used by list projections with a per-parent cache. */
export function locatorKeySync(directory: string, cache?: Map<string, string>): string {
  const parent = dirname(directory)
  let real = cache?.get(parent)
  if (real === undefined) {
    try { real = realpathSync(parent) } catch { real = resolve(parent) }
    cache?.set(parent, real)
  }
  return join(real, basename(directory))
}

/** The display name: `fix-<ticket id>` becomes `fix`, and a child keeps its `-child-n` suffix. */
export function spaceName(name: string | undefined, directory: string): string {
  const raw = name?.trim() || basename(directory)
  return raw.replace(/-[0-9a-f]{12}(?=-child-\d+$|$)/, '') || raw
}

/** One directory's filesystem facts: what kind of space it is and, for a checkout, its branch or short commit. */
export interface SpaceFacts { kind: SpaceKind; branch?: string }

/** Reads `HEAD` without trusting a stale API field; a detached checkout shows its short commit. */
function branchAtHead(head: string): string | undefined {
  const value = head.trim()
  return value.startsWith('ref: refs/heads/') ? value.slice('ref: refs/heads/'.length) : /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 7) : undefined
}

/** The directory facts synchronously, with one `.git` check for both kind and branch (E1's projection path). */
function factsSync(directory: string): SpaceFacts {
  try {
    let git = join(directory, '.git')
    if (statSync(git).isFile()) {
      const pointer = readFileSync(git, 'utf8').trim()
      if (!pointer.startsWith('gitdir:')) return { kind: 'checkout' }
      git = resolve(directory, pointer.slice('gitdir:'.length).trim())
    }
    let branch: string | undefined
    try { branch = branchAtHead(readFileSync(join(git, 'HEAD'), 'utf8')) } catch { /* a checkout without a readable HEAD */ }
    return { kind: 'checkout', ...branch ? { branch } : {} }
  } catch { /* no VCS metadata */ }
  try { statSync(directory); return { kind: 'scratch' } } catch { return { kind: 'unknown' } }
}

/** The same facts without blocking the event loop, for the batch warm-up of a list projection. */
async function factsAsync(directory: string): Promise<SpaceFacts> {
  try {
    let git = join(directory, '.git')
    if ((await stat(git)).isFile()) {
      const pointer = (await readFile(git, 'utf8')).trim()
      if (!pointer.startsWith('gitdir:')) return { kind: 'checkout' }
      git = resolve(directory, pointer.slice('gitdir:'.length).trim())
    }
    let branch: string | undefined
    try { branch = branchAtHead(await readFile(join(git, 'HEAD'), 'utf8')) } catch { /* a checkout without a readable HEAD */ }
    return { kind: 'checkout', ...branch ? { branch } : {} }
  } catch { /* no VCS metadata */ }
  try { await stat(directory); return { kind: 'scratch' } } catch { return { kind: 'unknown' } }
}

/** Read the branch (or short commit) a prepared checkout has checked out, without trusting a stale API field. */
export const branchOf = (directory: string): string | undefined => factsSync(directory).branch

/** The kind a prepared directory supports: a VCS checkout, a plain scratch directory, or unknown before it exists. */
export const kindOf = (directory: string): SpaceKind => factsSync(directory).kind

const FACTS_TTL_MS = 15_000, FACTS_LIMIT = 4_096, FACTS_WIDTH = 16

/**
 * A short-lived cache in front of the per-directory kind/branch reads. E2 polls the whole list every few seconds; without
 * a cache that is one synchronous `.git`/`HEAD` read per row per poll. `load` also warms the list concurrently so a cold
 * poll does not serialize hundreds of reads. A branch that changes inside the TTL is shown up to `ttlMs` late: this is a
 * read-only diagnostic projection, and the executor's prepare verification does not use it.
 */
export class SpaceFactsCache {
  private readonly entries = new Map<string, { at: number; facts: SpaceFacts }>()
  /** The number of underlying filesystem reads, for diagnostics and the list performance test. */
  reads = 0
  private readonly ttlMs: number
  private readonly limit: number
  private readonly clock: () => number
  private readonly read: (directory: string) => Promise<SpaceFacts>

  constructor(options: { ttlMs?: number; limit?: number; now?: () => number; read?: (directory: string) => Promise<SpaceFacts> } = {}) {
    this.ttlMs = options.ttlMs ?? FACTS_TTL_MS
    this.limit = options.limit ?? FACTS_LIMIT
    this.clock = options.now ?? (() => Date.now())
    this.read = options.read ?? factsAsync
  }

  /** Fresh facts for a directory, or undefined when absent or older than the TTL. */
  get(directory: string): SpaceFacts | undefined {
    const entry = this.entries.get(directory)
    if (!entry) return undefined
    if (this.clock() - entry.at > this.ttlMs) { this.entries.delete(directory); return undefined }
    // Refresh insertion order so the size cap evicts the least recently used directory, not the oldest read.
    this.entries.delete(directory); this.entries.set(directory, entry)
    return entry.facts
  }

  /** Facts for a synchronous projection: a cache hit, else one blocking read. */
  cached(directory: string): SpaceFacts {
    const facts = this.get(directory)
    if (facts) return facts
    this.reads++
    const read = factsSync(directory)
    this.put(directory, read)
    return read
  }

  /** Warms every distinct uncached directory concurrently, one read each, for a cold list projection. */
  async load(directories: Iterable<string>): Promise<void> {
    const pending = [...new Set(directories)].filter(directory => !this.get(directory))
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < pending.length) {
        const directory = pending[next++]!
        if (this.get(directory)) continue
        this.reads++
        this.put(directory, await this.read(directory))
      }
    }
    await Promise.all(Array.from({ length: Math.min(FACTS_WIDTH, pending.length) }, worker))
  }

  clear(): void { this.entries.clear() }

  private put(directory: string, facts: SpaceFacts): void {
    if (this.entries.has(directory)) this.entries.delete(directory)
    this.entries.set(directory, { at: this.clock(), facts })
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }
}

/** The process-wide facts cache shared by E1 and E2 reads; one runtime process owns one state directory. */
export const spaceFactsCache = new SpaceFactsCache()

/** Player-readable holder; the caller supplies the viewed Ticket so `own` does not leak an internal id. */
function holderOf(store: Store, ticketId: string, viewedId?: string): SpaceHolder | undefined {
  const ticket = store.tickets.get(ticketId)
  if (!ticket) return undefined
  return { ticketTitle: ticket.title, status: activityStatusOf(ticket), own: ticketId === viewedId }
}

/** The current lease row for a locator, if any; released history does not hold the space. */
export function currentLease(store: Store, locatorKey: string): SpaceLease | undefined {
  const row = store.db.prepare(`SELECT * FROM space_lease WHERE locator_key=? AND ${CURRENT_LEASE}`).get(locatorKey) as Record<string, SQLInputValue> | undefined
  return row ? leaseOf(row) : undefined
}

/** One ticket's read-only space view. Lightweight tickets and records without an Execution have none. */
export function spaceOf(store: Store, ticket: Ticket, options: {
  parent?: Ticket | undefined
  leases?: ReadonlyMap<string, SpaceLease>
  cache?: Map<string, string>
  facts?: SpaceFactsCache
} = {}): SpaceView | undefined {
  if (ticketForm(ticket) === 'lightweight') return undefined
  const directory = ticket.execution?.directory
  if (!directory) return undefined
  const locator = locatorKeySync(directory, options.cache)
  const lease = options.leases ? options.leases.get(locator) : currentLease(store, locator)
  const facts = (options.facts ?? spaceFactsCache).cached(directory)
  const exists = facts.kind !== 'unknown'
  const legacy = !!options.parent?.execution?.directory
    && directory.startsWith(`${options.parent.execution.directory.replace(/\/$/, '')}/`)
  const running = runningAssignment(ticket)
  const holderId = lease && (lease.state === 'reserved' || lease.state === 'active') ? lease.ticketId : running ? ticket.id : undefined
  const failed = liveTicket(ticket) && latestReport(ticket)?.state === 'failed'
  const state: SpaceState = failed ? 'failed'
    : lease?.state === 'reserved' ? 'preparing'
      : lease?.state === 'active' || (!lease && running) ? 'active'
        : legacy ? 'legacy'
          : exists ? 'ready' : 'planned'
  return {
    kind: facts.kind,
    name: spaceName(ticket.execution?.name, directory),
    ...facts.branch ? { branch: facts.branch } : {},
    state,
    ...holderId ? { holder: holderOf(store, holderId, ticket.id) } : {},
    ...legacy ? { legacy: true as const } : {},
    lastAt: ticket.updatedAt,
  }
}

/** The state stale derivation: an old process epoch without a live worker Session means no writer can still own it. */
export function deriveLeaseState(lease: SpaceLease, processEpoch: number, live: (ticketId: string) => boolean): SpaceLeaseState {
  if ((lease.state === 'reserved' || lease.state === 'active') && lease.processEpoch !== processEpoch && !live(lease.ticketId)) return 'stale'
  return lease.state
}

/**
 * The write-lease repository. It reserves before `executor.prepare`, activates after verification, and releases when the
 * Ticket ends; it never grants an action level or changes a Ticket's authorization.
 */
export class SpaceLeases {
  constructor(readonly store: Store, readonly processEpoch: number) {}

  /** The current row for a locator, as stored (a stale row is derived in views, not hidden here). */
  current(locatorKey: string): SpaceLease | undefined {
    const row = this.store.db.prepare(`SELECT * FROM space_lease WHERE locator_key=? AND ${CURRENT_LEASE}
      ORDER BY epoch DESC LIMIT 1`).get(locatorKey) as Record<string, SQLInputValue> | undefined
    return row ? leaseOf(row) : undefined
  }

  /** All current rows, for a list projection that reads leases once; the newest epoch per locator wins. */
  currentRows(): SpaceLease[] {
    return (this.store.db.prepare(`SELECT lease.* FROM space_lease lease
      WHERE lease.state IN ('reserved', 'active', 'stale')
      AND lease.epoch = (SELECT MAX(epoch) FROM space_lease WHERE locator_key=lease.locator_key)`)
      .all() as Record<string, SQLInputValue>[]).map(leaseOf)
  }

  /** All rows, newest epoch first, for diagnostics and migration tests. */
  all(): SpaceLease[] {
    return (this.store.db.prepare('SELECT * FROM space_lease ORDER BY locator_key, epoch DESC').all() as Record<string, SQLInputValue>[]).map(leaseOf)
  }

  /**
   * Reserve `ticket`'s planned directory before prepare. The same Ticket re-enters its own lease; a different Ticket gets
   * the holder so the executor can queue instead of preparing, unless the row is stale (old process and no live Session).
   */
  async reserve(input: { ticket: Ticket; assignmentId?: string; sessionId?: string; live: (ticketId: string) => boolean }): Promise<
  { lease: SpaceLease; heldBy?: undefined } | { lease?: undefined; heldBy: SpaceHolder }> {
    const directory = input.ticket.execution?.directory
    if (!directory) throw new Error('The Ticket has no Execution.directory to lease')
    const locatorKey = await locatorKeyOf(directory)
    return this.store.atomic(() => {
      const existing = this.current(locatorKey)
      if (existing) {
        const stale = deriveLeaseState(existing, this.processEpoch, input.live) === 'stale'
        // The same Ticket re-enters a live lease, but a lease from an older process is stale even for its old holder.
        if (existing.ticketId === input.ticket.id && !stale) {
          return { lease: this.updateHolder(existing, input.assignmentId, input.sessionId) }
        }
        if (stale) this.markStale(existing, locatorKey)
        else {
          const holder = holderOf(this.store, existing.ticketId, input.ticket.id)
          if (holder) return { heldBy: holder }
          return { heldBy: { ticketTitle: '', status: 'working', own: false } }
        }
      }
      return { lease: this.insert(locatorKey, input.ticket.id, input.assignmentId, input.sessionId) }
    })
  }

  /** Activate the reserved row after prepare and verification. Idempotent for the same Ticket and epoch. */
  activate(lease: SpaceLease): SpaceLease {
    const at = now()
    this.store.db.prepare(`UPDATE space_lease SET state='active', activated_at=COALESCE(activated_at, ?), updated_at=?
      WHERE locator_key=? AND epoch=? AND ticket_id=? AND state='reserved'`).run(at, at, lease.locatorKey, lease.epoch, lease.ticketId)
    const current = this.current(lease.locatorKey)
    // A row released, staled or taken over between reserve and activation must not be treated as owned.
    if (!current || current.epoch !== lease.epoch || current.ticketId !== lease.ticketId || current.state !== 'active')
      throw new Error('The write lease was lost before activation')
    return current
  }

  /** Release a Ticket's current lease for its directory; repeated release is a no-op. */
  release(ticketId: string, directory: string | undefined): void {
    if (!directory) return
    let locatorKey: string
    try { locatorKey = locatorKeySync(directory) } catch { return }
    const at = now()
    this.store.db.prepare(`UPDATE space_lease SET state='released', released_at=?, updated_at=?
      WHERE locator_key=? AND ticket_id=? AND ${CURRENT_LEASE}`).run(at, at, locatorKey, ticketId)
  }

  /** Release one never-activated reservation, but only while it still belongs to the same Assignment. */
  releaseReservation(lease: SpaceLease): void {
    if (lease.state !== 'reserved' || !lease.assignmentId) return
    const at = now()
    this.store.db.prepare(`UPDATE space_lease SET state='released', released_at=?, updated_at=?
      WHERE locator_key=? AND epoch=? AND ticket_id=? AND assignment_id=? AND state='reserved'`)
      .run(at, at, lease.locatorKey, lease.epoch, lease.ticketId, lease.assignmentId)
  }

  /** Mark old-process rows whose holder has no live Session stale, without preempting a possibly live writer. */
  reconcile(live: (ticketId: string) => boolean): void {
    const at = now()
    for (const lease of this.currentRows()) {
      if (deriveLeaseState(lease, this.processEpoch, live) !== 'stale') continue
      this.store.db.prepare(`UPDATE space_lease SET state='stale', updated_at=? WHERE locator_key=? AND epoch=? AND ${CURRENT_LEASE}`)
        .run(at, lease.locatorKey, lease.epoch)
    }
  }

  private updateHolder(lease: SpaceLease, assignmentId?: string, sessionId?: string): SpaceLease {
    const at = now()
    this.store.db.prepare(`UPDATE space_lease SET assignment_id=?, session_id=?, process_epoch=?, updated_at=?
      WHERE locator_key=? AND epoch=?`).run(assignmentId ?? null, sessionId ?? null, this.processEpoch, at, lease.locatorKey, lease.epoch)
    return this.current(lease.locatorKey) ?? { ...lease, assignmentId, sessionId, processEpoch: this.processEpoch, updatedAt: at }
  }

  private markStale(lease: SpaceLease, locatorKey: string): void {
    this.store.db.prepare(`UPDATE space_lease SET state='stale', updated_at=? WHERE locator_key=? AND epoch=?`)
      .run(now(), locatorKey, lease.epoch)
  }

  private insert(locatorKey: string, ticketId: string, assignmentId?: string, sessionId?: string): SpaceLease {
    const at = now()
    const row = this.store.db.prepare('SELECT COALESCE(MAX(epoch), 0) AS epoch FROM space_lease WHERE locator_key=?').get(locatorKey) as { epoch: number }
    const epoch = Number(row.epoch) + 1
    this.store.db.prepare(`INSERT INTO space_lease
      (locator_key, ticket_id, assignment_id, session_id, process_epoch, epoch, state, reserved_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`).run(locatorKey, ticketId, assignmentId ?? null, sessionId ?? null, this.processEpoch, epoch, at, at)
    return { locatorKey, ticketId, ...assignmentId ? { assignmentId } : {}, ...sessionId ? { sessionId } : {},
      processEpoch: this.processEpoch, epoch, state: 'reserved', reservedAt: at, updatedAt: at }
  }
}

function leaseOf(row: Record<string, SQLInputValue>): SpaceLease {
  const text = (name: string): string | undefined => row[name] === null || row[name] === undefined ? undefined : String(row[name])
  return { locatorKey: String(row.locator_key), ticketId: String(row.ticket_id),
    ...text('assignment_id') ? { assignmentId: text('assignment_id') } : {}, ...text('session_id') ? { sessionId: text('session_id') } : {},
    processEpoch: Number(row.process_epoch), epoch: Number(row.epoch), state: String(row.state) as SpaceLeaseState,
    reservedAt: String(row.reserved_at), ...text('activated_at') ? { activatedAt: text('activated_at') } : {},
    ...text('released_at') ? { releasedAt: text('released_at') } : {}, updatedAt: String(row.updated_at) }
}

/** The E1 task row's space, with the parent (a nested child shows the legacy flag) and the leases read once per request. */
export class SpaceProjection {
  private readonly leases: Map<string, SpaceLease>
  private readonly cache = new Map<string, string>()
  constructor(private readonly store: Store, readonly processEpoch: number, private readonly live: (ticketId: string) => boolean,
    private readonly facts: SpaceFactsCache = spaceFactsCache) {
    this.leases = new Map(new SpaceLeases(store, processEpoch).currentRows().map(lease => [lease.locatorKey, lease]))
  }

  view(ticket: Ticket, parent?: Ticket): SpaceView | undefined {
    return spaceOf(this.store, ticket, { parent, leases: this.leases, cache: this.cache, facts: this.facts })
  }

  lease(ticket: Ticket): SpaceLease | undefined {
    const directory = ticket.execution?.directory
    if (!directory) return undefined
    return this.leases.get(locatorKeySync(directory, this.cache))
  }

  leaseView(ticket: Ticket): SpaceLeaseView | undefined {
    // The E1 projection is built without a process epoch; never mark a live lease stale from that read path.
    if (!this.processEpoch) return undefined
    const lease = this.lease(ticket)
    if (!lease) return undefined
    const state = deriveLeaseState(lease, this.processEpoch, this.live)
    return { state, epoch: lease.epoch, processEpoch: lease.processEpoch, stale: state === 'stale',
      reservedAt: lease.reservedAt, ...lease.activatedAt ? { activatedAt: lease.activatedAt } : {},
      ...lease.releasedAt ? { releasedAt: lease.releasedAt } : {} }
  }
}

/** Every E2 space row: tracked Tickets with an Execution, newest activity first, with the path and lease diagnostics. */
export async function spaceRows(store: Store, processEpoch: number, live: (ticketId: string) => boolean,
  facts: SpaceFactsCache = spaceFactsCache): Promise<SpaceRow[]> {
  const latest = new Map<string, string>()
  for (const record of store.activity.latestByTicket()) if (record.ticket) latest.set(record.ticket, record.at)
  const tickets = [...store.tickets.allList()].filter(ticket => ticketForm(ticket) === 'tracked' && !!ticket.execution?.directory)
  // One concurrent warm-up for the whole list: a cold poll reads each distinct directory once instead of one row at a time.
  await facts.load(tickets.map(ticket => ticket.execution!.directory))
  const projection = new SpaceProjection(store, processEpoch, live, facts)
  const parents = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const rank = (ticket: Ticket): number => ticket.ended ? 2 : runningAssignment(ticket) ? 0 : 1
  return tickets.sort((left, right) => rank(left) - rank(right) || (latest.get(right.id) ?? right.updatedAt).localeCompare(latest.get(left.id) ?? left.updatedAt))
    .flatMap(ticket => {
      const space = projection.view(ticket, ticket.parentTicketId ? parents.get(ticket.parentTicketId) : undefined)
      if (!space) return []
      return [{ ...space, ticket: { id: ticket.id, title: ticket.title, status: activityStatusOf(ticket) }, locator: ticket.execution!.directory,
        ...projection.leaseView(ticket) ? { lease: projection.leaseView(ticket)! } : {},
        ...latest.get(ticket.id) ? { lastAt: latest.get(ticket.id)! } : {} }]
    })
}