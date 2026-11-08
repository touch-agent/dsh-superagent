import { describe, expect, it } from 'vitest'
import { ACCEPTANCE_RULES, ARTIFACT_KINDS, PREVIEW_KINDS, UserError, enterReview, isAcceptanceRule, isArtifactKind, isPreviewKind, reasonText,
  type AcceptanceCriterionInput, type Artifact, type DeliverableInput, type PreviewRef } from '@superagent/kernel'

const reviewer = { source: 'feishu', id: 'ou_alice' }
const artifact = (overrides: Partial<Artifact> = {}): Artifact => ({ kind: 'document', ref: 'doc-1', revision: 'rev-1', ...overrides })
const preview = (overrides: Partial<PreviewRef> = {}): PreviewRef => ({ kind: 'text/redline', ref: 'preview-1', revision: 'rev-1', ...overrides })
const deliverable = (overrides: Partial<DeliverableInput> = {}): DeliverableInput => ({ artifact: artifact(), previewRef: preview(), ...overrides })
const criteria = (...items: AcceptanceCriterionInput[]): AcceptanceCriterionInput[] => items
/** Run a refused gate and return its UserError, so the test can check the code and values a panel will read. */
function refusal(run: () => unknown): UserError {
  try { run() } catch (error) {
    expect(error).toBeInstanceOf(UserError)
    return error as UserError
  }
  throw new Error('Expected the review to be refused')
}

describe('the deliverable model', () => {
  it('names the five artifact kinds and the previewers a review may use', () => {
    expect(ARTIFACT_KINDS).toEqual(['file', 'document', 'spreadsheet', 'mail-draft', 'calendar-invite'])
    expect(ARTIFACT_KINDS.map(isArtifactKind)).toEqual([true, true, true, true, true])
    expect([isArtifactKind('presentation'), isArtifactKind(undefined), isArtifactKind(1)]).toEqual([false, false, false])
    expect(PREVIEW_KINDS).toEqual(['text/redline', 'text/diff', 'sheet/cell-diff', 'mail/draft', 'calendar/slot'])
    expect(PREVIEW_KINDS.map(isPreviewKind)).toEqual([true, true, true, true, true])
    expect([isPreviewKind('text/html'), isPreviewKind(undefined)]).toEqual([false, false])
    expect(ACCEPTANCE_RULES).toEqual(['pr.merged', 'artifact.sent', 'artifact.unchanged'])
    expect(ACCEPTANCE_RULES.map(isAcceptanceRule)).toEqual([true, true, true])
    // values.match needs an expected-value payload the criterion does not carry yet, so it is not judgeable.
    expect([isAcceptanceRule('values.match'), isAcceptanceRule('pr.closed'), isAcceptanceRule(undefined)]).toEqual([false, false, false])
  })

  it('enters review with one artifact revision, its preview and its criteria', () => {
    const input = deliverable({ acceptanceCriteria: criteria(
      { kind: 'rule', rule: 'pr.merged' },
      { kind: 'rule', rule: 'artifact.unchanged', window: 24 },
      { kind: 'human', who: reviewer, reason: 'The tone is right' },
    ) })
    const review = enterReview(input)
    expect(review.deliverable).toEqual({ artifact: artifact(), previewRef: preview(), acceptanceCriteria: [
      { kind: 'rule', rule: 'pr.merged' },
      { kind: 'rule', rule: 'artifact.unchanged', window: 24 },
      { kind: 'human', who: reviewer, reason: { code: 'said', values: { text: 'The tone is right' } } },
    ] })
    expect(review.criteria).toEqual([
      { kind: 'rule', rule: 'pr.merged' },
      { kind: 'rule', rule: 'artifact.unchanged', window: 24 },
    ])
    expect(review.confirmations).toEqual([{ kind: 'human', who: reviewer, reason: { code: 'said', values: { text: 'The tone is right' } } }])
    // The input is read, not mutated, and the result is plain data that survives the Store.
    expect(input.acceptanceCriteria).toHaveLength(3)
    expect(JSON.parse(JSON.stringify(review))).toEqual(review)
  })

  it('carries each artifact kind together with the preview reference its previewer chooses', () => {
    const pairs = [['file', 'text/diff'], ['document', 'text/redline'], ['spreadsheet', 'sheet/cell-diff'],
      ['mail-draft', 'mail/draft'], ['calendar-invite', 'calendar/slot']] as const
    for (const [kind, previewKind] of pairs) {
      const review = enterReview({ artifact: artifact({ kind }), previewRef: preview({ kind: previewKind }) })
      expect(review.deliverable.artifact.kind).toBe(kind)
      expect(review.deliverable.previewRef.kind).toBe(previewKind)
      expect(review.criteria).toEqual([])
      expect(review.confirmations).toEqual([])
    }
  })

  it('refuses a review with no deliverable or no preview', () => {
    expect(refusal(() => enterReview(undefined))).toMatchObject({ code: 'deliverableMissing' })
    expect(refusal(() => enterReview(null))).toMatchObject({ code: 'deliverableMissing' })
    expect(refusal(() => enterReview({ artifact: artifact() }))).toMatchObject({ code: 'deliverablePreviewMissing' })
    expect(refusal(() => enterReview(deliverable({ previewRef: null })))).toMatchObject({ code: 'deliverablePreviewMissing' })
  })

  it('refuses a preview of another revision, keeping both revisions in the refusal', () => {
    const error = refusal(() => enterReview(deliverable({ previewRef: preview({ revision: 'rev-2' }) })))
    expect(error).toMatchObject({ code: 'deliverablePreviewStale', values: { preview: 'rev-2', revision: 'rev-1' } })
    expect(error.message).toContain('rev-2')
    expect(error.message).toContain('rev-1')
  })

  it('keeps only the criteria the kernel can judge as machine criteria', () => {
    const review = enterReview(deliverable({ acceptanceCriteria: criteria(
      { kind: 'rule', rule: 'pr.merged' },
      { kind: 'rule', rule: 'artifact.sent' },
      { kind: 'rule', rule: 'artifact.unchanged', window: 24 },
    ) }))
    expect(review.criteria).toEqual([
      { kind: 'rule', rule: 'pr.merged' },
      { kind: 'rule', rule: 'artifact.sent' },
      { kind: 'rule', rule: 'artifact.unchanged', window: 24 },
    ])
    expect(review.confirmations).toEqual([])
  })

  it('downgrades a rule the kernel cannot judge to a human confirmation and keeps the reason', () => {
    const review = enterReview(deliverable({ acceptanceCriteria: criteria(
      { kind: 'rule', rule: 'values.match' },
      { kind: 'rule' },
      { kind: 'rule', rule: 'artifact.unchanged' },
      { kind: 'rule', rule: 'artifact.unchanged', window: 0 },
    ) }))
    expect(review.criteria).toEqual([])
    expect(review.confirmations).toHaveLength(4)
    // A rule without the payload it needs to be judged is an unknown rule, not an accidental automatic accept.
    expect(review.confirmations[0]).toMatchObject({ kind: 'human', degradedRule: 'values.match',
      reason: { code: 'acceptanceUnknownRule', values: { rule: 'values.match' } } })
    expect(reasonText(review.confirmations[0]!.reason)).toBe('The kernel cannot judge the acceptance rule “values.match”')
    // A criterion that never named a rule has nothing to keep as the degraded rule.
    expect(review.confirmations[1]).toMatchObject({ kind: 'human', reason: { code: 'acceptanceNoRule' } })
    expect(review.confirmations[1]).not.toHaveProperty('degradedRule')
    expect(reasonText(review.confirmations[1]!.reason)).toBe('No acceptance rule was named; a person must confirm the result')
    // A windowed rule without a positive window cannot be judged either.
    expect(review.confirmations[2]).toMatchObject({ kind: 'human', degradedRule: 'artifact.unchanged',
      reason: { code: 'acceptanceWindowMissing', values: { rule: 'artifact.unchanged' } } })
    expect(reasonText(review.confirmations[2]!.reason)).toBe('The acceptance rule “artifact.unchanged” needs a positive window in hours')
    expect(review.confirmations[3]).toMatchObject({ kind: 'human', degradedRule: 'artifact.unchanged',
      reason: { code: 'acceptanceWindowMissing', values: { rule: 'artifact.unchanged' } } })
    // The declared rule survives the downgrade, so a later rule can be recognized as what it replaced.
    expect(review.confirmations.map(item => item.degradedRule ?? null)).toEqual(['values.match', null, 'artifact.unchanged', 'artifact.unchanged'])
  })

  it('keeps a deliberately human criterion, with or without a named person and reason', () => {
    const review = enterReview(deliverable({ acceptanceCriteria: criteria(
      { kind: 'human', who: reviewer },
      { kind: 'human', reason: 'A person must read the final wording' },
    ) }))
    expect(review.criteria).toEqual([])
    expect(review.confirmations).toEqual([
      { kind: 'human', who: reviewer },
      { kind: 'human', reason: { code: 'said', values: { text: 'A person must read the final wording' } } },
    ])
  })

  it('refuses a malformed artifact, preview, criterion or contradictory window', () => {
    expect(() => enterReview({ artifact: artifact({ kind: 'presentation' as Artifact['kind'] }), previewRef: preview() }))
      .toThrow(/Unknown artifact kind: presentation/)
    expect(() => enterReview(deliverable({ artifact: artifact({ ref: ' ' }) }))).toThrow(/artifact reference must be a non-empty string/)
    expect(() => enterReview(deliverable({ artifact: artifact({ revision: '' }) }))).toThrow(/artifact revision must be a non-empty string/)
    expect(() => enterReview(deliverable({ previewRef: preview({ kind: 'text/html' as PreviewRef['kind'] }) })))
      .toThrow(/Unknown preview kind: text\/html/)
    expect(() => enterReview(deliverable({ previewRef: preview({ ref: '' }) }))).toThrow(/preview reference must be a non-empty string/)
    expect(() => enterReview(deliverable({ previewRef: preview({ revision: '' }) }))).toThrow(/preview revision must be a non-empty string/)
    expect(() => enterReview(deliverable({ acceptanceCriteria: criteria({ kind: 'auto' as 'rule' }) })))
      .toThrow(/Unknown acceptance criterion kind: auto/)
    // A field that contradicts the criterion's kind is a caller bug, not a rule the kernel could downgrade.
    expect(() => enterReview(deliverable({ acceptanceCriteria: criteria({ kind: 'rule', rule: 'pr.merged', window: 24 }) })))
      .toThrow(/“pr\.merged” takes no window/)
    expect(() => enterReview(deliverable({ acceptanceCriteria: criteria({ kind: 'human', rule: 'pr.merged' }) })))
      .toThrow(/human criterion cannot name a rule/)
    expect(() => enterReview(deliverable({ acceptanceCriteria: criteria({ kind: 'human', window: 24 }) })))
      .toThrow(/human criterion cannot carry a window/)
    expect(() => enterReview(deliverable({ acceptanceCriteria: criteria({ kind: 'human', who: { source: '', id: 'ou_alice' } }) })))
      .toThrow(/confirming actor source must be a non-empty string/)
    expect(() => enterReview(deliverable({ acceptanceCriteria: criteria({ kind: 'rule', rule: 'pr.merged', who: reviewer }) })))
      .toThrow(/rule criterion cannot name a person/)
    expect(() => enterReview(deliverable({ acceptanceCriteria: criteria({ kind: 'rule', rule: 'pr.merged', reason: 'Chosen by the team' }) })))
      .toThrow(/rule criterion cannot carry a human reason/)
    expect(() => enterReview(deliverable({ acceptanceCriteria: criteria({ kind: 'rule', rule: 42 as unknown as string }) })))
      .toThrow(/acceptance rule must be a string/)
    expect(() => enterReview(deliverable({ acceptanceCriteria: {} as AcceptanceCriterionInput[] })))
      .toThrow(/acceptance criteria must be a list/)
  })
})
