/**
 * The execution configuration an AgentProfile names and the immutable snapshot a Ticket binds: its role, model
 * policy, work-tool policy, prompt reference and evaluation baseline. These are pure descriptions. They never carry
 * authorization: who may start work, which action level is permitted, whether an approval is needed, whom a message may
 * reach and how long a Mandate holds are answered by Policy, Mandate, the Action gate and Approval, not here.
 */
import type { Ticket } from './model.ts'

/** Phase 1 activates the worker role only; `orchestrator` is reserved so the model can grow without a schema change. */
export type ProfileRole = 'worker' | 'orchestrator'
/** A model policy: follow the role's configured model, or pin a complete approved route. */
export type ProfileModelPolicy =
  | { mode: 'inherit' }
  | { mode: 'pinned'; provider: string; model: string; reasoningEffort?: string }
/** A work-tool policy: follow the role's work-tool cap, or list a subset of it. */
export type ProfileToolsPolicy =
  | { mode: 'inherit' }
  | { mode: 'list'; names: string[] }
/** A prompt policy: follow the live prompt revision, or pin one revision. */
export type ProfilePromptPolicy =
  | { mode: 'live' }
  | { mode: 'pinned'; revision: number }

/** The immutable content of one profile revision; lifecycle lives on the head, never in here. */
export interface AgentProfile {
  id: string
  revision: number
  role: ProfileRole
  title: string
  description: string
  model: ProfileModelPolicy
  tools: ProfileToolsPolicy
  prompt: ProfilePromptPolicy
  /** A declaration of the baseline an experiment would use; it is not an activation gate and not part of the effective hash. */
  evalBaseline?: { evalSet: string; revision: number }
  provenance: { by: string; at: string; reason: string; source: 'builtin' | 'panel' | 'tool' | 'import' }
  /** Hash of this revision's canonical content, excluding `contentHash`; changes only when content changes. */
  contentHash: string
}

/** A profile's mutable head: which revision is offered, which are retired, and when it was last bound. */
export interface ProfileHead {
  activeRevision: number
  retiredRevisions: number[]
  lastBoundAt?: string
  updatedBy: string
}

/** How a ticket picked its snapshot; `by` is code or a person, never a model. */
export interface ProfileSelection {
  by: 'code' | 'human'
  source: 'builtin' | 'manual' | 'legacy'
  reason: string
  /** Whether the configuration may move after binding (live prompt, inherited model or tools). */
  moving: boolean
  /** Whether the selected profile resolved enough to run; `false` means launch must fail closed. */
  valid: boolean
  /** Set when a selected profile was unavailable and the ticket fell back to legacy. */
  fallback?: true
}

/** The actual model a snapshot resolves to. `host-default` means the role settings named none and DSH supplies one. */
export interface ProfileResolvedModel { provider: string; model: string; reasoningEffort?: string }
/** The runtime fields covered by `effective.hash`; title, description, provenance and evalBaseline are deliberately absent. */
export interface ProfileEffective {
  promptRevision: number
  promptHash: string
  toolsHash: string
  model: ProfileResolvedModel
  dshVersion: string
  policyVersion: string
  skillsHash: string
  hash: string
}
/**
 * The immutable execution configuration a Ticket binds. A profile revision supplies the policy; the effective fields
 * record the actual prompt revision, work-tool list and model resolved at binding time, so two tickets can be compared
 * only when both hashes agree.
 */
export interface ProfileSnapshot {
  id: string
  revision: number
  /** The revision's `contentHash`, or a synthetic hash for a fallback snapshot. */
  hash: string
  role: 'worker'
  selection: ProfileSelection
  model: ProfileModelPolicy
  /** The effective work tools; the fixed protocol tools are separate and never appear here. */
  tools: string[]
  /** Whether `tools` followed the role ceiling (`inherit`) or an explicit subset (`list`); list must fail closed if missing. */
  toolsMode: 'inherit' | 'list'
  prompt: { mode: 'live' | 'pinned'; revision: number; hash: string }
  effective: ProfileEffective
  boundAt: string
  reason: string
}

/** One run's effective fields, recorded when a Session binds a prompt; moving profiles are grouped by this hash. */
export interface ProfileRunEffective extends ProfileEffective {
  at: string
  /** Whether the run's model matched the snapshot's pinned policy; absent for a moving policy. */
  modelCompliant?: boolean
}

/** The hooks the deployment gives the kernel to bind a snapshot without importing registry or host code. */
export interface ProfileBinder {
  /**
   * Resolve the snapshot a new root ticket binds. It must not throw: a profile failure may leave the ticket without a
   * snapshot or with `selection.valid=false`, but it must never fail the accept that created the ticket.
   */
  bindRoot(ticket: Ticket): ProfileSnapshot | undefined
  /** Copy a parent's snapshot to its child, never widening its work tools or changing its model policy. */
  bindChild(parent: Ticket, child: Ticket): ProfileSnapshot | undefined
}

/**
 * The profile facts a `dispatch` span carries. Recording them is observability, not authorization: a span is written
 * after the Assignment exists and cannot change a Mandate, an Action level or a Decision.
 */
export function profileSpan(ticket: Pick<Ticket, 'profile'>): Record<string, unknown> {
  const profile = ticket.profile
  if (!profile) return { profile: 'legacy' }
  return {
    profile: profile.id,
    profileRevision: profile.revision,
    profileHash: profile.hash,
    effectiveHash: profile.effective.hash,
    promptRevision: profile.effective.promptRevision,
    toolsHash: profile.effective.toolsHash,
    moving: profile.selection.moving,
    profileValid: profile.selection.valid,
    ...profile.selection.fallback ? { profileFallback: true } : {},
  }
}