/**
 * The read-only vocabulary of the six-layer context assembly, shared by the host assembler and the snapshot an
 * Assignment keeps. These are assembly concepts, never authorization concepts: an entry or a snapshot says what the
 * worker was told, not what it may do. The action gate, Approval, Mandate and acceptance checks stay outside.
 */

/** The six dimensions in reading order. Presence is decided per dimension; the order is not a priority. */
export const CONTEXT_DIMENSIONS = ['organization', 'user', 'group', 'task', 'subtask', 'agent'] as const
export type ContextDimension = typeof CONTEXT_DIMENSIONS[number]

/** `constraint` outranks `default`; scope only breaks a tie between entries of the same strength. */
export type ContextStrength = 'constraint' | 'default'
/** Whether a dimension's entries may be inherited by a narrower scope, or stay where they were produced. */
export type ContextInheritance = 'inherit' | 'private'

/** One assembled context entry, as the assembler passes it to the host prompt. */
export interface ContextEntry {
  key: string
  dimension: ContextDimension
  /** Where the fact came from, such as `policy`, `trigger:<id>` or `ticket:<id>`. */
  source: string
  /** The scope the entry applies to; it is a context scope, not a Mandate scope. */
  scope: string
  strength: ContextStrength
  inheritance: ContextInheritance
  /** Character ceiling the assembler applies to `text`; the host enforces 1..4000. */
  truncation: number
  text: string
}

/** One entry in a stored snapshot: the fields and a digest of the text, but never the private text itself. */
export interface ContextEntryManifest {
  key: string
  dimension: ContextDimension
  source: string
  scope: string
  strength: ContextStrength
  inheritance: ContextInheritance
  truncation: number
  /** Characters actually assembled, after truncation. */
  chars: number
  /** `sha256:<hex>` of the assembled text, so a replay can compare what was assembled without storing it. */
  digest: string
  truncated?: true
}

/** How two or more entries for one key were resolved when no conflict stopped the assembly. */
export interface ContextMergeDecision {
  key: string
  /** `<dimension>:<source>` of the entry that won. */
  winner: string
  /** The entries it replaced, in the same form; no text is copied. */
  losers: string[]
}

/** A conflict that stopped the assembly: equal-strength entries with different text and no scope ordering. */
export interface ContextConflict {
  key: string
  strength: ContextStrength
  dimensions: ContextDimension[]
  sources: string[]
}

/** Why an assembly did not run; a blocked assignment waits for a person, it is never silently defaulted. */
export interface ContextBlock {
  reason: 'conflict' | 'missing' | 'unreadable'
  dimension?: ContextDimension
  /** Bounded, person-readable fact; it may name a key or dimension, never assembled text. */
  detail: string
}

/**
 * The read-only snapshot an Assignment keeps of the context that was assembled for it. It carries the entry fields,
 * digests, sources, the absent dimensions and the conflicts; it never carries the text assembled into the prompt, so
 * a trace or a read model can show what applied without copying private content.
 */
export interface ContextSnapshot {
  state: 'assembled' | 'blocked'
  assembledAt: string
  ticketId: string
  rootTicketId: string
  assignmentId?: string
  /**
   * Present dimensions in reading order. A dimension is present when its subject exists and it took part in the merge,
   * even if its only entry lost a key merge to a more specific source.
   */
  dimensions: ContextDimension[]
  /**
   * Dimensions not assembled because their subject did not exist. In a blocked snapshot this also includes the failed
   * dimension and any later one that was never reached; `blocked.dimension` names the failure.
   */
  absent: ContextDimension[]
  entries: ContextEntryManifest[]
  merges: ContextMergeDecision[]
  conflicts: ContextConflict[]
  /** Per dimension, the source revision or identity the entries came from. */
  sources: Partial<Record<ContextDimension, string>>
  /** `sha256:<hex>` over the snapshot facts without this field or `assembledAt`; re-assembling the same facts yields the same hash. */
  hash: string
  /**
   * `sha256:<hex>` over the context content alone (dimensions, entries, merges, conflicts). It stays equal when only the
   * Assignment identity moves, so a resumed Ticket can omit an unchanged context from its later message.
   */
  contentHash: string
  blocked?: ContextBlock
}