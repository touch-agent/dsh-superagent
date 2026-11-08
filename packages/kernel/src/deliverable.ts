/** Deliverables: what a worker produced, the preview a person reviews it by, and the criteria that can accept it. */
import { UserError } from './errors.ts'
import type { ActorRef } from './model.ts'
import type { Reason } from './reasons.ts'

/** The five things a Ticket can deliver: a file, a document, a spreadsheet, a mail draft or a calendar invite. */
export const ARTIFACT_KINDS = ['file', 'document', 'spreadsheet', 'mail-draft', 'calendar-invite'] as const
/** What kind of object a Deliverable points at. */
export type ArtifactKind = typeof ARTIFACT_KINDS[number]

/** Whether a value names one of the five artifact kinds. */
export const isArtifactKind = (value: unknown): value is ArtifactKind =>
  typeof value === 'string' && (ARTIFACT_KINDS as readonly string[]).includes(value)

/** One delivered artifact at one revision; a newer revision is another Deliverable, never an edit of this one. */
export interface Artifact {
  kind: ArtifactKind
  /** Where it is: a file handle, a document address, a spreadsheet address, a draft id or an invite id. */
  ref: string
  /** The revision this Deliverable presents, such as a content hash, a commit or a draft version. */
  revision: string
}

/**
 * The preview kinds a review may name. A new kind is a kernel change made with the previewer that renders it, so the
 * gate can validate the reference it is given; the previewers add their kinds here as they land.
 */
export const PREVIEW_KINDS = ['text/redline', 'text/diff', 'sheet/cell-diff', 'mail/draft', 'calendar/slot'] as const
/** What kind of structured preview a person reviews an artifact by. */
export type PreviewKind = typeof PREVIEW_KINDS[number]

/** Whether a value names one of the structured preview kinds. */
export const isPreviewKind = (value: unknown): value is PreviewKind =>
  typeof value === 'string' && (PREVIEW_KINDS as readonly string[]).includes(value)

/** Where the structured preview of one artifact revision is kept. The kernel never reads what is behind `ref`. */
export interface PreviewRef {
  kind: PreviewKind
  ref: string
  /** The artifact revision it renders; a preview of another revision is stale and must not enter review. */
  revision: string
}

/**
 * The closed set of acceptance rules the kernel can judge as machine conditions. Adding one is a kernel change with its
 * own tests, so a deployment cannot turn an arbitrary string into automatic acceptance; anything else falls back to a
 * person. The evidence a rule needs, such as a merge or a send, is recorded by the delivery and its Source.
 */
export const ACCEPTANCE_RULES = ['pr.merged', 'artifact.sent', 'artifact.unchanged'] as const
/** A condition a machine can decide, from facts the delivery and its Source record. */
export type AcceptanceRule = typeof ACCEPTANCE_RULES[number]

/** Whether a value names one of the acceptance rules the kernel can judge. */
export const isAcceptanceRule = (value: unknown): value is AcceptanceRule =>
  typeof value === 'string' && (ACCEPTANCE_RULES as readonly string[]).includes(value)

/** A criterion the kernel can judge by a rule; `window` is how long after the fact it stays true, in hours. */
export interface RuleCriterion {
  kind: 'rule'
  rule: AcceptanceRule
  window?: number
}

/**
 * A criterion a person confirms. `reason` says why as a coded reason the panel can localize, and is set when a
 * declared rule could not be judged; `degradedRule` keeps that rule so the record explains what became a question.
 */
export interface HumanCriterion {
  kind: 'human'
  /** Who should confirm it; the reviewer when no one is named. */
  who?: ActorRef
  reason?: Reason
  degradedRule?: string
}

/** How a Deliverable can be accepted: by a machine-judgeable rule, or by a person's confirmation. */
export type AcceptanceCriterion = RuleCriterion | HumanCriterion

/** What a caller declares about one criterion, before the kernel decides whether it can judge it. */
export interface AcceptanceCriterionInput {
  kind: 'rule' | 'human'
  /** The acceptance rule a machine criterion names; an unknown or missing one becomes a human confirmation. */
  rule?: string
  /** Who confirms a human criterion. */
  who?: ActorRef
  /** The hours a windowed rule stays valid; required by `artifact.unchanged`. */
  window?: number
  /** Why a human criterion needs a person, when the caller chooses to say. */
  reason?: string
}

/** What a worker submits about its result; a draft may have no preview yet, but review requires one. */
export interface DeliverableInput {
  artifact: Artifact
  previewRef?: PreviewRef | null
  acceptanceCriteria?: AcceptanceCriterionInput[]
}

/**
 * What a Ticket delivered: one artifact at one revision, its preview, and how it can be accepted. Attaching it to a
 * Ticket (its id and field) and storing it are the review surface's work; this is the value contract.
 */
export interface Deliverable {
  artifact: Artifact
  previewRef: PreviewRef
  acceptanceCriteria: AcceptanceCriterion[]
}

/**
 * A Deliverable that may be shown for review, split by who decides each criterion. Only `enterReview` builds a Review;
 * its two lists are the split of `deliverable.acceptanceCriteria`, so callers should not assemble one by hand.
 */
export interface Review {
  deliverable: Deliverable
  /** The criteria a machine decides; no person waits for one of these. */
  criteria: RuleCriterion[]
  /** The criteria a person must confirm, including every rule the kernel could not judge, with its reason. */
  confirmations: HumanCriterion[]
}

/** The rules that need a positive `window` in hours. */
const WINDOWED_RULES = new Set<AcceptanceRule>(['artifact.unchanged'])

/** Refuse a value that is not a non-empty string, naming the field. */
function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${what} must be a non-empty string`)
  return value
}

/** Refuse an actor missing either part of its Source identity. */
function requireActor(value: ActorRef, what: string): ActorRef {
  if (!value || typeof value !== 'object') throw new TypeError(`${what} must be an actor`)
  requireText(value.source, `${what} source`)
  requireText(value.id, `${what} id`)
  return value
}

/** Validate one artifact and keep the exact revision it presents. */
function reviewedArtifact(value: Artifact): Artifact {
  if (!value || typeof value !== 'object') throw new TypeError('A Deliverable must name an artifact')
  if (!isArtifactKind(value.kind)) throw new TypeError(`Unknown artifact kind: ${String(value.kind)}`)
  return { kind: value.kind, ref: requireText(value.ref, 'The artifact reference'), revision: requireText(value.revision, 'The artifact revision') }
}

/** Validate one preview reference; it must name a known previewer and the revision it renders. */
function reviewedPreview(value: PreviewRef): PreviewRef {
  if (!value || typeof value !== 'object') throw new TypeError('The preview reference must be an object')
  if (!isPreviewKind(value.kind)) throw new TypeError(`Unknown preview kind: ${String(value.kind)}`)
  return { kind: value.kind, ref: requireText(value.ref, 'The preview reference'), revision: requireText(value.revision, 'The preview revision') }
}

/** Turn a declared criterion into one the kernel can judge, or into a human confirmation that keeps the reason. */
function reviewedCriterion(input: AcceptanceCriterionInput): AcceptanceCriterion {
  if (!input || typeof input !== 'object') throw new TypeError('An acceptance criterion must be an object')
  if (input.kind === 'human') {
    if (input.rule !== undefined) throw new TypeError('A human criterion cannot name a rule')
    if (input.window !== undefined) throw new TypeError('A human criterion cannot carry a window')
    const who = input.who === undefined ? undefined : requireActor(input.who, 'The confirming actor')
    const said = input.reason === undefined ? undefined : requireText(input.reason, 'The human criterion reason')
    return { kind: 'human', ...(who ? { who } : {}), ...(said ? { reason: { code: 'said', values: { text: said } } } : {}) }
  }
  if (input.kind !== 'rule') throw new TypeError(`Unknown acceptance criterion kind: ${String((input as { kind?: unknown }).kind)}`)
  if (input.who !== undefined) throw new TypeError('A rule criterion cannot name a person')
  if (input.reason !== undefined) throw new TypeError('A rule criterion cannot carry a human reason')
  if (input.rule !== undefined && input.rule !== null && typeof input.rule !== 'string') {
    throw new TypeError('The acceptance rule must be a string')
  }
  const declared = typeof input.rule === 'string' ? input.rule.trim() : ''
  const human = (code: 'acceptanceNoRule' | 'acceptanceUnknownRule' | 'acceptanceWindowMissing'): HumanCriterion =>
    ({ kind: 'human', reason: { code, ...(declared ? { values: { rule: declared } } : {}) },
      ...(declared ? { degradedRule: declared } : {}) })
  if (!declared) return human('acceptanceNoRule')
  if (!isAcceptanceRule(declared)) return human('acceptanceUnknownRule')
  if (WINDOWED_RULES.has(declared)) {
    const window = input.window
    if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
      return human('acceptanceWindowMissing')
    }
    return { kind: 'rule', rule: declared, window }
  }
  if (input.window !== undefined) throw new TypeError(`The acceptance rule “${declared}” takes no window`)
  return { kind: 'rule', rule: declared }
}

/**
 * The structural gate a Ticket passes before a person may review its result. A review without a Deliverable, or without a
 * preview of the artifact's revision, is refused: a person cannot judge what they cannot see, so the panel must not offer
 * approval for it. The kernel does not decide which preview kind fits an artifact; the previewer that produced the ref
 * does, and the previewers register their pairings. Each declared criterion the kernel cannot judge becomes a human
 * confirmation with its reason kept, while the machine-judgeable rules stay separate. The runtime does not submit
 * Deliverables yet; this is the contract the review surface (T3-07) and later acceptance rules call.
 */
export function enterReview(input: DeliverableInput | null | undefined): Review {
  if (!input) throw new UserError('deliverableMissing')
  const artifact = reviewedArtifact(input.artifact)
  if (!input.previewRef) throw new UserError('deliverablePreviewMissing')
  const previewRef = reviewedPreview(input.previewRef)
  if (previewRef.revision !== artifact.revision) {
    throw new UserError('deliverablePreviewStale', { preview: previewRef.revision, revision: artifact.revision })
  }
  const declaredCriteria = input.acceptanceCriteria ?? []
  if (!Array.isArray(declaredCriteria)) throw new TypeError('The acceptance criteria must be a list')
  const acceptanceCriteria = declaredCriteria.map(reviewedCriterion)
  return {
    deliverable: { artifact, previewRef, acceptanceCriteria },
    criteria: acceptanceCriteria.filter((criterion): criterion is RuleCriterion => criterion.kind === 'rule'),
    confirmations: acceptanceCriteria.filter((criterion): criterion is HumanCriterion => criterion.kind === 'human'),
  }
}
