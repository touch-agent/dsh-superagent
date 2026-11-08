/** The runtime's lightweight executor: it reads repository files inline, without an Assignment, a Session or a workspace. */
import { createHash } from 'node:crypto'
import { createAction, type Action, type EngineForInline, type InlineExecutor, type InlineResult, type InlineStep, type Ticket, type Trigger }
  from '@superagent/kernel'

/** The actor the inline executor records for the reads it runs: the runtime, not the person or a worker. */
export const INLINE_ACTOR = { source: 'dsh-superagent', id: 'inline' } as const
/** How many repository paths one inline run reads; a request naming more needs a tracked ticket. */
const MAX_PATHS = 4
/** Largest excerpt of one file kept in the ticket's end reason, in characters. */
const EXCERPT_CHARS = 1200
/** Largest end reason one run records, in characters. */
const SUMMARY_CHARS = 4000
/** Repository directories whose files this deployment reads without requiring a file extension. */
const SOURCE_PREFIX = /^(?:docs|packages|tests|scripts|examples|locale|meta|src)\//u
/** A token that names a file by its lowercase extension. */
const FILE_NAME = /^[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/u
/** A host name such as `github.com`, which is not a repository file even though it has an extension. */
const HOST_NAME = /^[A-Za-z0-9-]+\.(?:app|ai|cn|co|com|dev|io|me|net|org|sh)$/u
/** One path-like token in a message: it begins with a word character and stays in the path alphabet. */
const TOKEN = /[A-Za-z0-9_][A-Za-z0-9_./-]*/gu

/**
 * The repository-relative files a message names, in the order it names them, deduplicated.
 * Only file-shaped tokens count: a name with a letter-starting extension, or a path under one of this project's source
 * directories. URLs, e-mail addresses, hidden paths, `node_modules` and version numbers are not repository files.
 */
export function repositoryPaths(text: string): string[] {
  const paths: string[] = []
  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0]
    const at = match.index ?? 0
    const path = raw.replace(/[.,:;!?]+$/u, '')
    if (!path || path.length > 200 || path.startsWith('.') || path.endsWith('/') || path.includes('..')) continue
    // A token inside a URL or an e-mail address is not a path this executor may read.
    if (/:\/\/[^\s]*$/u.test(text.slice(Math.max(0, at - 300), at)) || /[@\w]$/u.test(text.slice(Math.max(0, at - 1), at))) continue
    const segments = path.split('/').filter(Boolean)
    if (segments.some(segment => segment.startsWith('.') || segment === 'node_modules')) continue
    if (HOST_NAME.test(path)) continue
    if (!FILE_NAME.test(path) && !SOURCE_PREFIX.test(path)) continue
    if (!paths.includes(path)) paths.push(path)
  }
  return paths
}

/** What one read produced, kept to build the end reason after all reads ran. */
interface ReadFact { path: string; ok: boolean; chars?: number; excerpt?: string; error?: string }

/** What the runtime lends the inline executor: the Trigger store, the Engine's callback, the read, and a clock. */
export interface InlineWorkHost {
  /** The stored Triggers, so the run reads the person's message rather than a reconstructed copy. */
  readonly store: { readonly triggers: { get(id: string): Trigger | undefined } }
  /** The Engine that records each action and the run's end. */
  readonly engine: EngineForInline
  /** Read one repository-relative file; the default assembly uses the GitHub API and the deployment's repository. */
  read(path: string, signal: AbortSignal): Promise<string>
  /** The clock the action times use; tests pin it. */
  readonly now?: () => string
  /** A warning sink for a callback the Engine refuses, such as one from a ticket that already ended. */
  readonly warn?: (message: string) => void
}

/** Returns `text` cut to `chars` characters, with an ellipsis when it was longer. */
const cut = (text: string, chars: number): string => text.length <= chars ? text : `${text.slice(0, chars)}…`
/** The bounded message of an error, without a stack. */
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300)

/**
 * Runs the Phase 0 lightweight work inline: a request that names repository files is a read-only lookup, so the executor
 * reads each named file, records one `read` action per file under the Trigger's trace, and ends the ticket `completed` with
 * a bounded excerpt of what it read. It creates no Assignment, worker Session or workspace, and it never commits, sends or
 * spends; a run that names no file, or whose files cannot be read, ends `dropped` with the reason.
 */
export class InlineWork implements InlineExecutor {
  private readonly runs = new Map<string, { run: string; abort: AbortController }>()
  private readonly pending = new Set<Promise<void>>()
  private readonly now: () => string
  constructor(private readonly host: InlineWorkHost) { this.now = host.now ?? (() => new Date().toISOString()) }

  /**
   * Queue `ticket`'s inline run. The Engine calls this inside an accept command, so the work starts on a microtask after the
   * command commits; a later run for the same ticket supersedes an earlier one.
   */
  start(ticket: Ticket, run: string): void {
    const previous = this.runs.get(ticket.id)
    if (previous) previous.abort.abort('A newer inline run superseded it')
    const abort = new AbortController()
    this.runs.set(ticket.id, { run, abort })
    const done = Promise.resolve().then(() => this.execute(ticket, run, abort.signal)).catch(error => {
      // The Engine refuses callbacks for a ticket that ended or a run that is no longer current; that is not a failure to report.
      if (!abort.signal.aborted) this.host.warn?.(`dsh-superagent could not finish inline ticket ${ticket.id}: ${reasonOf(error)}`)
    })
    this.pending.add(done)
    void done.finally(() => { this.pending.delete(done); if (this.runs.get(ticket.id)?.run === run) this.runs.delete(ticket.id) })
  }

  /** Stop the ticket's queued or running inline work; the callbacks that already ran stay in the trace. */
  stop(ticket: Ticket, reason: string): void {
    this.runs.get(ticket.id)?.abort.abort(reason)
    this.runs.delete(ticket.id)
  }

  /** Stop every run, such as when the host shuts down; the tickets stay open for a later host. */
  stopAll(reason = 'dsh-superagent stopped before the inline run finished'): void {
    for (const { abort } of this.runs.values()) abort.abort(reason)
    this.runs.clear()
  }

  /** Resolves when every queued or running inline run has settled, so a caller can read the results it recorded. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }

  /** Read the named files and record the actions and the end; the run stops quietly when its token is aborted. */
  private async execute(ticket: Ticket, run: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    const trigger = this.host.store.triggers.get(ticket.origin.triggerId)
    if (!trigger) {
      this.finish(ticket, run, { outcome: 'dropped', summary: 'The ticket’s originating message is no longer stored, so there was nothing to read inline.' })
      return
    }
    // A resumed ticket may hold a person's follow-up. Read only what an unread follow-up names, so a resumed run does not
    // repeat the origin read; a follow-up that names no file stays unread and goes back to Eval when this run drops.
    const unread = ticket.inputs.flatMap(input => input.kind === 'trigger' && !input.readAt ? [input] : [])
    const groups: { input?: { id: string }; paths: string[] }[] = unread.length
      ? unread.flatMap(input => {
        const text = this.host.store.triggers.get(input.triggerId)?.text
        return text === undefined ? [] : [{ input, paths: repositoryPaths(text) }]
      })
      : [{ paths: repositoryPaths(trigger.text) }]
    const paths = [...new Set(groups.flatMap(group => group.paths))]
    if (!paths.length) {
      this.finish(ticket, run, { outcome: 'dropped', summary: unread.length
        ? 'The follow-up names no repository file, so this inline executor cannot answer it. It needs a tracked ticket.'
        : 'The request names no repository file, so there was nothing this inline executor could read. This work needs a tracked ticket.' })
      return
    }
    if (paths.length > MAX_PATHS) {
      this.finish(ticket, run, { outcome: 'dropped',
        summary: `The request names ${paths.length} repository files; this inline executor reads at most ${MAX_PATHS}. This work needs a tracked ticket.` })
      return
    }
    const facts: ReadFact[] = []
    for (const path of paths) {
      if (signal.aborted) return
      const at = this.now()
      try {
        const content = await this.host.read(path, signal)
        if (signal.aborted) return
        const revision = createHash('sha256').update(content).digest('hex').slice(0, 12)
        this.action(ticket, run, action(path, revision), at, true)
        facts.push({ path, ok: true, chars: content.length, excerpt: cut(content, EXCERPT_CHARS) })
      } catch (error) {
        if (signal.aborted) return
        const message = reasonOf(error)
        this.action(ticket, run, action(path, 'unreadable'), at, false, message)
        facts.push({ path, ok: false, error: message })
      }
    }
    if (signal.aborted) return
    // Take up only the follow-ups whose named file was read; one that named no file, or whose file failed, stays for Eval.
    const read = groups.flatMap(group => group.input && group.paths.some(path => facts.some(fact => fact.ok && fact.path === path))
      ? [group.input.id] : [])
    this.finish(ticket, run, resultOf(facts), read)
  }

  /** Record one action; a refused callback (the ticket ended, the run is stale) stops the run rather than retrying it. */
  private action(ticket: Ticket, run: string, action: Action, at: string, ok: boolean, error?: string): void {
    const step: InlineStep = { action, at, ok, ...(error ? { error } : {}) }
    this.host.engine.inlineAction(ticket.id, run, step)
  }

  /** Record the run's end; a callback the Engine refuses (the ticket ended meanwhile) is not a second failure. */
  private finish(ticket: Ticket, run: string, result: InlineResult, read: readonly string[] = []): void {
    try { this.host.engine.inlineFinished(ticket.id, run, { ...result, ...(read.length ? { read: [...read] } : {}) }) }
    catch (error) { this.host.warn?.(`dsh-superagent could not end inline ticket ${ticket.id}: ${reasonOf(error)}`) }
  }
}

/** The read Action for one repository file. */
function action(path: string, revision: string): Action {
  return createAction({ kind: 'repository.read', source: 'github', objectId: path, revision, actor: INLINE_ACTOR, level: 'read' })
}

/** What the reads add up to: completed when at least one file was read, dropped when none was. */
function resultOf(facts: readonly ReadFact[]): InlineResult {
  const read = facts.filter(fact => fact.ok)
  const lines = facts.map(fact => fact.ok
    ? `Read ${fact.path} (${fact.chars} characters).\n${fact.excerpt ?? ''}`
    : `Could not read ${fact.path}: ${fact.error ?? 'unknown error'}`)
  return { outcome: read.length ? 'completed' : 'dropped', summary: cut(lines.join('\n\n'), SUMMARY_CHARS) }
}
