/** The mail previewer: two drafts become recipient, subject, body and attachment diffs, with an explicit audience. */
import { createHash } from 'node:crypto'

/** The three envelope fields a recipient can be in, in the order a person reads them. */
export type MailRecipientRole = 'to' | 'cc' | 'bcc'

const ROLES: readonly MailRecipientRole[] = ['to', 'cc', 'bcc']

/** One address as a draft writes it: a bare mailbox, or a display name with a mailbox. */
export type MailAddressInput = string | {
  name?: string
  address: string
}

/** One parsed address: what a person sees, the mailbox, and the key two revisions are compared by. */
export interface MailAddress {
  /** The display name without its quotes; absent for a bare address. */
  name?: string
  /** The mailbox as written, trimmed. */
  address: string
  /** The lower-cased mailbox; the same person in two revisions has the same key. */
  key: string
  /** What a person reads: `Name <mailbox>` or the bare mailbox. */
  display: string
}

/** One recipient as one revision has it, in the field it appears in. */
export interface MailRecipientRef {
  role: MailRecipientRole
  address: MailAddress
}

/** One address in the after revision, once, with every field it appears in. This is the explicit audience. */
export interface MailAudienceEntry {
  /**
   * The address. When the same mailbox appears in more than one field with different display names, `address` keeps
   * the first one seen in To, Cc, Bcc order; the per-role refs in a change keep each field's own display name.
   */
  address: MailAddress
  /** The fields the address is in, in To, Cc, Bcc order; an address may be in more than one. */
  roles: MailRecipientRole[]
  /** True when the address has a Bcc copy, which the other recipients do not see. */
  bcc: boolean
}

/** How many addresses each field has, and how many distinct addresses the whole envelope has. */
export interface MailRecipientCounts {
  to: number
  cc: number
  bcc: number
  total: number
}

/**
 * One address whose envelope changed. `changed` covers a move between To, Cc and Bcc, including the dangerous move to
 * Bcc, and a display-name change; the before and after refs name the field the address was and is in, so the move is
 * explicit rather than inferred from two unrelated additions and removals.
 */
export interface MailRecipientChange {
  kind: 'added' | 'removed' | 'changed'
  /** The address in the revision that has it, preferring the after revision. */
  address: MailAddress
  /** The fields before, in To, Cc, Bcc order; empty for an added address. */
  before: MailRecipientRef[]
  /** The fields after, in To, Cc, Bcc order; empty for a removed address. */
  after: MailRecipientRef[]
}

/** The coded warnings that make a risky envelope readable at a glance. */
export const MAIL_WARNING_CODES = ['bccHidden', 'movedToBcc', 'duplicateRecipient', 'noRecipients'] as const
/** One warning code. */
export type MailWarningCode = typeof MAIL_WARNING_CODES[number]

/** One warning about the after revision, with the addresses it is about. */
export interface MailWarning {
  code: MailWarningCode
  /** The addresses the warning is about, by canonical key; empty when the warning is about the whole envelope. */
  addresses: string[]
  message: string
}

/** The recipient section: both counts, every change, the explicit after audience and the warnings around it. */
export interface MailRecipients {
  before: MailRecipientCounts
  after: MailRecipientCounts
  changes: MailRecipientChange[]
  /** Every address the after revision will reach, once, with its fields. Bcc is named here, not hidden among To. */
  audience: MailAudienceEntry[]
  warnings: MailWarning[]
}

/** The subject section: both revisions and whether they differ. */
export interface MailSubjectDiff {
  before: string
  after: string
  changed: boolean
}

/** One body line, numbered as an editor shows it. */
export interface MailBodyLine {
  /** One-based line number in its revision. */
  line: number
  text: string
}

/** One changed body line; added and removed name one side, changed names both. */
export interface MailBodyChange {
  kind: 'added' | 'removed' | 'changed'
  before?: MailBodyLine
  after?: MailBodyLine
}

/** The body section: a line diff of the readable body, with the counts a panel shows above it. */
export interface MailBodyDiff {
  changes: MailBodyChange[]
  summary: { before: number; after: number; added: number; removed: number; changed: number }
  /**
   * How the lines were aligned. `lines` used common unchanged lines as anchors after trimming the common prefix and
   * suffix; `position` paired an oversized middle by position, so a line that merely shifted can be reported as
   * changed and the panel should say so.
   */
  alignment: 'lines' | 'position'
}

/**
 * One attachment as a draft declares it. `content` is the bytes or text; when it is given the previewer hashes it
 * (SHA-256) and measures it, so a same-named attachment whose content changed is not read as unchanged. `digest` and
 * `size` let a caller describe a large attachment without handing its bytes to the preview; a supplied `digest` must be
 * the SHA-256 hex of the bytes. Attachments are compared by name and names are case-sensitive; a revision with two
 * attachments of the same name is a caller error because the comparison would be ambiguous.
 */
export interface MailAttachment {
  name: string
  contentType?: string
  /** The size in bytes when the caller knows it; content, when given, is measured instead. */
  size?: number
  /** A content fingerprint, which must be the SHA-256 hex of the bytes, used only when `content` is not given. */
  digest?: string
  content?: string | Uint8Array
  /** Whether the attachment is shown inside the message rather than listed beside it. */
  inline?: boolean
}

/** What one revision says about one attachment, without carrying its bytes into the preview. */
export interface MailAttachmentInfo {
  name: string
  contentType?: string
  size?: number
  digest?: string
  inline: boolean
}

/** The parts of an attachment that can differ under the same name. */
export type MailAttachmentField = 'content' | 'size' | 'contentType' | 'inline'

/** One attachment that only one revision has, or that changed under the same name. */
export interface MailAttachmentChange {
  kind: 'added' | 'removed' | 'changed'
  name: string
  before?: MailAttachmentInfo
  after?: MailAttachmentInfo
  /** For a changed attachment, the parts that differ. */
  fields?: MailAttachmentField[]
}

/** The attachment section: every change, the content the preview could not verify, and the counts a panel shows. */
export interface MailAttachmentsDiff {
  changes: MailAttachmentChange[]
  summary: { before: number; after: number; added: number; removed: number; changed: number }
  /**
   * Attachments that exist on both sides but whose content could not be compared because at least one revision
   * supplied neither content nor a digest. A one-sided fingerprint is also reported as a `content` change, so content
   * is never silently called unchanged; this list says which attachments have only metadata compared.
   */
  unverified: string[]
}

/**
 * One mail draft revision. `body` is the readable text a person would read; an HTML body must be passed as its text
 * rendition, so a preview does not compare markup. Addresses are one per array item: a display name may hold commas,
 * but a mailbox may not.
 */
export interface MailDraft {
  to?: readonly MailAddressInput[]
  cc?: readonly MailAddressInput[]
  bcc?: readonly MailAddressInput[]
  subject?: string
  body?: string
  attachments?: readonly MailAttachment[]
}

/** What one comparison needs: the two drafts and the original link a reviewer can open. */
export interface MailPreviewInput {
  before: MailDraft
  after: MailDraft
  link: string
}

/**
 * The structured preview of one mail draft against another. The four sections are the envelope, the subject, the body
 * and the attachments; `recipients.audience` is the explicit answer to who will receive the after revision, including
 * every Bcc address, and a Cc/Bcc move is a `changed` recipient rather than a removal the reader has to pair by hand.
 * The previewer registry that stores this value and gives the Deliverable its `PreviewRef` is the review surface's work.
 */
export interface MailPreview {
  kind: 'mail/draft'
  unit: 'message'
  link: string
  recipients: MailRecipients
  subject: MailSubjectDiff
  body: MailBodyDiff
  attachments: MailAttachmentsDiff
  summary: {
    recipients: { before: number; after: number; added: number; removed: number; changed: number }
    subject: { changed: boolean }
    body: { before: number; after: number; added: number; removed: number; changed: number }
    attachments: { before: number; after: number; added: number; removed: number; changed: number }
  }
}

/** The lines one body may align by full dynamic programming; beyond this the two sides pair by position. */
const MAX_BODY_ALIGN_CELLS = 1_000_000
/** The removal/insertion pairs one body gap may score before it pairs the rest by position. */
const MAX_BODY_PAIR_COMPARISONS = 10_000
/** How alike two body lines must be for a removal and an insertion to read as one changed line. */
const BODY_CHANGE_THRESHOLD = 0.5
/** The characters of a body line used to score likeness, so a handful of enormous lines cannot dominate the diff. */
const MAX_BODY_SIMILARITY_CHARS = 4_000
const textEncoder = new TextEncoder()

/** Whether a value is a plain object, never an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strip the quotes a display name may carry, and refuse a name that could break a header or spoof an address. */
function displayName(raw: string, what: string): string | undefined {
  let name = raw.trim()
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\"/g, '"').trim()
  // A name that contains angle brackets can swallow a second address in a joined string; refuse it rather than
  // showing one recipient while silently dropping another.
  if (/[\u0000-\u001f\u007f<>]/.test(name)) {
    throw new TypeError(`${what} has a display name with a control character or angle bracket`)
  }
  return name || undefined
}

/** Parse one address input into the display a person reads and the key two revisions compare. */
function parseAddress(value: MailAddressInput, what: string): MailAddress {
  if (typeof value !== 'string' && !isRecord(value)) throw new TypeError(`${what} must be an address string or an object`)
  let name: string | undefined
  let mailbox: string
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) throw new TypeError(`${what} must not be empty`)
    const bracketed = /^(.*?)\s*<\s*([^<>]+)\s*>$/.exec(text)
    if (bracketed) {
      name = displayName(bracketed[1]!, what)
      mailbox = bracketed[2]!.trim()
    } else {
      mailbox = text
    }
  } else {
    if (typeof value.address !== 'string') throw new TypeError(`${what} must have a string address`)
    mailbox = value.address.trim()
    if (value.name !== undefined) {
      if (typeof value.name !== 'string') throw new TypeError(`${what} must have a string display name`)
      name = displayName(value.name, what)
    }
  }
  // One mailbox per item: a comma, semicolon, colon or whitespace here means two addresses were joined, and a
  // bracketed display name may not hide a second address either (displayName rejects angle brackets).
  if (!mailbox) throw new TypeError(`${what} must have an address`)
  if (!/^[^@\s,<>;:]+@[^@\s,<>;:]+$/.test(mailbox)) {
    throw new TypeError(`${what} "${mailbox}" is not a mailbox; pass one address per item`)
  }
  const key = mailbox.toLowerCase()
  return name ? { name, address: mailbox, key, display: `${name} <${mailbox}>` } : { address: mailbox, key, display: mailbox }
}

/** Parse one envelope field, keeping the first occurrence of an address and naming the repeats. */
function parseField(value: unknown, role: MailRecipientRole, what: string): { refs: MailRecipientRef[]; duplicates: string[] } {
  if (value === undefined) return { refs: [], duplicates: [] }
  if (!Array.isArray(value)) throw new TypeError(`${what} ${role} must be an array of addresses`)
  const refs: MailRecipientRef[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const address = parseAddress(item as MailAddressInput, `${what} ${role}`)
    if (seen.has(address.key)) {
      duplicates.push(address.key)
      continue
    }
    seen.add(address.key)
    refs.push({ role, address })
  }
  return { refs, duplicates }
}

/** The SHA-256 of an attachment's content, so a same-named attachment with new bytes is visible. */
function contentDigest(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

/** The bytes an attachment holds, so a string and a Uint8Array are measured the same way. */
function contentSize(content: string | Uint8Array): number {
  return typeof content === 'string' ? textEncoder.encode(content).length : content.byteLength
}

/** Read one attachment, measuring and hashing its content when the caller supplies it. */
function parseAttachment(value: unknown, what: string): MailAttachmentInfo {
  if (!isRecord(value)) throw new TypeError(`${what} must be an object`)
  if (typeof value.name !== 'string' || !value.name.trim()) throw new TypeError(`${what} must have a non-empty name`)
  const name = value.name.trim()
  if (/[\r\n]/.test(name)) throw new TypeError(`${what} has a name with a line break`)
  if (value.contentType !== undefined && (typeof value.contentType !== 'string' || !value.contentType.trim())) {
    throw new TypeError(`${what} content type must be a non-empty string`)
  }
  if (value.size !== undefined && (typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 0)) {
    throw new TypeError(`${what} size must be a non-negative integer`)
  }
  if (value.digest !== undefined && (typeof value.digest !== 'string' || !value.digest.trim())) {
    throw new TypeError(`${what} digest must be a non-empty string`)
  }
  if (value.content !== undefined && typeof value.content !== 'string' && !(value.content instanceof Uint8Array)) {
    throw new TypeError(`${what} content must be a string or a Uint8Array`)
  }
  if (value.inline !== undefined && typeof value.inline !== 'boolean') throw new TypeError(`${what} inline must be a boolean`)
  const content = value.content as string | Uint8Array | undefined
  const size = content !== undefined ? contentSize(content) : value.size as number | undefined
  // The bytes are the truth when they are present; a caller's digest describes an attachment it did not hand over.
  const digest = content !== undefined ? contentDigest(content)
    : value.digest === undefined ? undefined : value.digest.trim().toLowerCase()
  const info: MailAttachmentInfo = { name, inline: value.inline === true }
  if (typeof value.contentType === 'string') info.contentType = value.contentType.trim()
  if (size !== undefined) info.size = size
  if (digest !== undefined) info.digest = digest
  return info
}

/** Read one revision's attachment list, refusing duplicate names that would make the comparison ambiguous. */
function parseAttachments(value: unknown, what: string): MailAttachmentInfo[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(`${what} attachments must be an array`)
  const attachments: MailAttachmentInfo[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const attachment = parseAttachment(item, `${what} attachment`)
    if (seen.has(attachment.name)) throw new TypeError(`${what} has two attachments named "${attachment.name}"`)
    seen.add(attachment.name)
    attachments.push(attachment)
  }
  return attachments
}

/** One revision, normalized to the shape the comparison reads. */
interface NormalizedDraft {
  fields: Record<MailRecipientRole, MailRecipientRef[]>
  duplicates: string[]
  subject: string
  body: string
  attachments: MailAttachmentInfo[]
}

/** Validate and normalize one draft, so a comparison never reads a caller's raw value. */
function normalizeDraft(value: MailDraft, what: string): NormalizedDraft {
  if (!isRecord(value)) throw new TypeError(`${what} must be an object`)
  const fields = { to: [] as MailRecipientRef[], cc: [] as MailRecipientRef[], bcc: [] as MailRecipientRef[] }
  const duplicates: string[] = []
  for (const role of ROLES) {
    const parsed = parseField(value[role], role, what)
    fields[role] = parsed.refs
    duplicates.push(...parsed.duplicates)
  }
  const subject = value.subject === undefined ? '' : value.subject
  if (typeof subject !== 'string') throw new TypeError(`${what} subject must be a string`)
  if (/[\r\n]/.test(subject)) throw new TypeError(`${what} subject must not contain a line break`)
  const body = value.body === undefined ? '' : value.body
  if (typeof body !== 'string') throw new TypeError(`${what} body must be a string`)
  return { fields, duplicates, subject, body, attachments: parseAttachments(value.attachments, what) }
}

/** Every distinct address in the after revision, in reading order, with the fields it is in. */
function audienceOf(fields: Record<MailRecipientRole, MailRecipientRef[]>): MailAudienceEntry[] {
  const entries = new Map<string, MailAudienceEntry>()
  for (const role of ROLES) {
    for (const ref of fields[role]) {
      let entry = entries.get(ref.address.key)
      if (!entry) {
        entry = { address: ref.address, roles: [], bcc: false }
        entries.set(ref.address.key, entry)
      }
      if (!entry.roles.includes(role)) entry.roles.push(role)
      if (role === 'bcc') entry.bcc = true
    }
  }
  return [...entries.values()]
}

/** The counts of one revision's envelope. */
function countsOf(fields: Record<MailRecipientRole, MailRecipientRef[]>): MailRecipientCounts {
  return { to: fields.to.length, cc: fields.cc.length, bcc: fields.bcc.length, total: audienceOf(fields).length }
}

/** The refs of one address, grouped by key, in reading order. */
function refsByKey(fields: Record<MailRecipientRole, MailRecipientRef[]>): Map<string, MailRecipientRef[]> {
  const grouped = new Map<string, MailRecipientRef[]>()
  for (const role of ROLES) {
    for (const ref of fields[role]) {
      const refs = grouped.get(ref.address.key)
      if (refs) refs.push(ref)
      else grouped.set(ref.address.key, [ref])
    }
  }
  return grouped
}

/** Whether two revisions put one address in the same fields with the same display names; mailbox case is not a change. */
function sameRecipient(before: readonly MailRecipientRef[], after: readonly MailRecipientRef[]): boolean {
  return before.length === after.length && before.every((ref, index) => {
    const other = after[index]!
    return ref.role === other.role && ref.address.key === other.address.key && ref.address.name === other.address.name
  })
}

/** The recipient section: counts, one change per address and the explicit after audience. */
function compareRecipients(before: NormalizedDraft, after: NormalizedDraft): MailRecipients {
  const beforeRefs = refsByKey(before.fields)
  const afterRefs = refsByKey(after.fields)
  const afterAudience = audienceOf(after.fields)
  const order = [...afterAudience.map(entry => entry.address.key),
    ...[...beforeRefs.keys()].filter(key => !afterRefs.has(key))]
  const changes: MailRecipientChange[] = []
  for (const key of order) {
    const refsBefore = beforeRefs.get(key) ?? []
    const refsAfter = afterRefs.get(key) ?? []
    const address = (refsAfter[0] ?? refsBefore[0])!.address
    if (!refsBefore.length) {
      changes.push({ kind: 'added', address, before: [], after: refsAfter })
      continue
    }
    if (!refsAfter.length) {
      changes.push({ kind: 'removed', address, before: refsBefore, after: [] })
      continue
    }
    if (!sameRecipient(refsBefore, refsAfter)) changes.push({ kind: 'changed', address, before: refsBefore, after: refsAfter })
  }
  const duplicateKeys = [...new Set([...after.duplicates,
    ...afterAudience.filter(entry => entry.roles.length > 1).map(entry => entry.address.key)])]
  const warnings: MailWarning[] = []
  const bcc = afterAudience.filter(entry => entry.bcc).map(entry => entry.address.key)
  if (bcc.length) {
    warnings.push({ code: 'bccHidden', addresses: bcc,
      message: `${bcc.length} recipient(s) have a Bcc copy; Bcc copies are not shown to the other recipients.` })
  }
  const movedToBcc = changes.filter(change => {
    const beforeRoles = new Set(change.before.map(ref => ref.role))
    const afterRoles = new Set(change.after.map(ref => ref.role))
    return (beforeRoles.has('to') || beforeRoles.has('cc')) && afterRoles.has('bcc')
      && !afterRoles.has('to') && !afterRoles.has('cc')
  }).map(change => change.address.key)
  if (movedToBcc.length) {
    warnings.push({ code: 'movedToBcc', addresses: movedToBcc,
      message: `${movedToBcc.length} recipient(s) moved from To or Cc to Bcc, so the other recipients no longer see them.` })
  }
  if (duplicateKeys.length) {
    warnings.push({ code: 'duplicateRecipient', addresses: duplicateKeys,
      message: `${duplicateKeys.length} address(es) appear more than once in the envelope; some providers deliver one copy per field.` })
  }
  if (!afterAudience.length) {
    warnings.push({ code: 'noRecipients', addresses: [], message: 'The draft has no To, Cc or Bcc recipient.' })
  }
  return {
    before: countsOf(before.fields),
    after: countsOf(after.fields),
    changes,
    audience: afterAudience,
    warnings,
  }
}

/** The body's lines, numbered as an editor shows them; trailing whitespace and a final newline are not content. */
function bodyLines(text: string): MailBodyLine[] {
  if (!text) return []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((line, index) => ({ line: index + 1, text: line.replace(/\s+$/, '') }))
}

/** One alignment step over body line indexes. */
interface BodyOp {
  kind: 'same' | 'delete' | 'insert'
  before?: number
  after?: number
}

/** Pair the lines of a gap by position, so a changed run is read as changed rather than as a delete and an add. */
function positionalBodyOps(beforeCount: number, afterCount: number): BodyOp[] {
  const ops: BodyOp[] = []
  const shared = Math.min(beforeCount, afterCount)
  for (let index = 0; index < shared; index++) ops.push({ kind: 'same', before: index, after: index })
  for (let index = shared; index < beforeCount; index++) ops.push({ kind: 'delete', before: index })
  for (let index = shared; index < afterCount; index++) ops.push({ kind: 'insert', after: index })
  return ops
}

/** The start and end of a long line, enough to score likeness without reading megabytes per pair. */
function sampledLine(text: string): string {
  if (text.length <= MAX_BODY_SIMILARITY_CHARS) return text
  const half = Math.floor(MAX_BODY_SIMILARITY_CHARS / 2)
  return text.slice(0, half) + text.slice(-half)
}

/** Dice similarity over character bigrams, enough to read an edited line as one changed line. */
function lineSimilarity(before: string, after: string): number {
  if (before === after) return 1
  const left = Array.from(sampledLine(before))
  const right = Array.from(sampledLine(after))
  if (left.length < 2 || right.length < 2) return 0
  const counts = new Map<string, number>()
  for (let index = 0; index < left.length - 1; index++) {
    const gram = left[index]! + left[index + 1]!
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  let common = 0
  for (let index = 0; index < right.length - 1; index++) {
    const gram = right[index]! + right[index + 1]!
    const count = counts.get(gram)
    if (count) { common++; counts.set(gram, count - 1) }
  }
  const total = left.length - 1 + right.length - 1
  return total ? (2 * common) / total : 0
}

/** Pair a gap's removals and insertions by likeness, then by position, so the change reads as one line edited. */
function pairBodyRun(deletes: readonly number[], inserts: readonly number[], before: readonly string[],
  after: readonly string[]): BodyOp[] {
  const pairs: { before: number; after: number; score: number }[] = []
  if (deletes.length * inserts.length <= MAX_BODY_PAIR_COMPARISONS) {
    for (const removed of deletes) {
      for (const added of inserts) {
        const score = lineSimilarity(before[removed]!, after[added]!)
        if (score >= BODY_CHANGE_THRESHOLD) pairs.push({ before: removed, after: added, score })
      }
    }
  }
  pairs.sort((left, right) => right.score - left.score
    || Math.abs(left.before - left.after) - Math.abs(right.before - right.after)
    || left.before - right.before || left.after - right.after)
  const usedBefore = new Set<number>()
  const usedAfter = new Set<number>()
  const ops: BodyOp[] = []
  for (const pair of pairs) {
    if (usedBefore.has(pair.before) || usedAfter.has(pair.after)) continue
    usedBefore.add(pair.before)
    usedAfter.add(pair.after)
    ops.push({ kind: 'same', before: pair.before, after: pair.after })
  }
  const remainingBefore = deletes.filter(index => !usedBefore.has(index))
  const remainingAfter = inserts.filter(index => !usedAfter.has(index))
  const shared = Math.min(remainingBefore.length, remainingAfter.length)
  for (let index = 0; index < shared; index++) {
    ops.push({ kind: 'same', before: remainingBefore[index]!, after: remainingAfter[index]! })
  }
  for (let index = shared; index < remainingBefore.length; index++) ops.push({ kind: 'delete', before: remainingBefore[index]! })
  for (let index = shared; index < remainingAfter.length; index++) ops.push({ kind: 'insert', after: remainingAfter[index]! })
  return ops
}

/** One alignment: the steps over body line indexes and whether an oversized middle had to pair by position. */
interface AlignedBody {
  ops: BodyOp[]
  alignment: 'lines' | 'position'
}

/** Align a body middle by its unchanged lines, pairing each changed gap rather than reporting every later line moved. */
function alignMiddle(before: readonly string[], after: readonly string[]): AlignedBody {
  const width = after.length + 1
  if ((before.length + 1) * width > MAX_BODY_ALIGN_CELLS) {
    return { ops: positionalBodyOps(before.length, after.length), alignment: 'position' }
  }
  const dp = new Uint32Array((before.length + 1) * width)
  for (let row = before.length - 1; row >= 0; row--) {
    for (let column = after.length - 1; column >= 0; column--) {
      dp[row * width + column] = before[row] === after[column]
        ? dp[(row + 1) * width + column + 1]! + 1
        : Math.max(dp[(row + 1) * width + column]!, dp[row * width + column + 1]!)
    }
  }
  const exact: BodyOp[] = []
  let row = 0
  let column = 0
  while (row < before.length && column < after.length) {
    if (before[row] === after[column]) {
      exact.push({ kind: 'same', before: row, after: column })
      row++
      column++
    } else if (dp[(row + 1) * width + column]! >= dp[row * width + column + 1]!) {
      exact.push({ kind: 'delete', before: row })
      row++
    } else {
      exact.push({ kind: 'insert', after: column })
      column++
    }
  }
  while (row < before.length) exact.push({ kind: 'delete', before: row++ })
  while (column < after.length) exact.push({ kind: 'insert', after: column++ })
  const ops: BodyOp[] = []
  for (let index = 0; index < exact.length;) {
    const op = exact[index]!
    if (op.kind === 'same') { ops.push(op); index++; continue }
    const run: BodyOp[] = []
    while (index < exact.length && exact[index]!.kind !== 'same') { run.push(exact[index]!); index++ }
    const deletes = run.filter(step => step.kind === 'delete').map(step => step.before!)
    const inserts = run.filter(step => step.kind === 'insert').map(step => step.after!)
    ops.push(...pairBodyRun(deletes, inserts, before, after))
  }
  return { ops, alignment: 'lines' }
}

/**
 * Align two bodies after trimming the common prefix and suffix. Trimming keeps a single insertion or removal from
 * discarding every exact anchor and marking the rest of the body changed; only the remaining middle can still be
 * oversized, and then it pairs by position with `alignment: 'position'`.
 */
function alignBodyLines(before: readonly string[], after: readonly string[]): AlignedBody {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  const middle = alignMiddle(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix))
  const ops: BodyOp[] = []
  for (let index = 0; index < prefix; index++) ops.push({ kind: 'same', before: index, after: index })
  for (const op of middle.ops) {
    const mapped: BodyOp = { kind: op.kind }
    if (op.before !== undefined) mapped.before = op.before + prefix
    if (op.after !== undefined) mapped.after = op.after + prefix
    ops.push(mapped)
  }
  for (let index = 0; index < suffix; index++) {
    ops.push({ kind: 'same', before: before.length - suffix + index, after: after.length - suffix + index })
  }
  return { ops, alignment: middle.alignment }
}

/** The body section: added, removed and changed lines against the readable body. */
function diffBody(before: string, after: string): MailBodyDiff {
  const beforeLines = bodyLines(before)
  const afterLines = bodyLines(after)
  const aligned = alignBodyLines(beforeLines.map(line => line.text), afterLines.map(line => line.text))
  const changes: MailBodyChange[] = []
  for (const op of aligned.ops) {
    if (op.kind === 'delete') {
      changes.push({ kind: 'removed', before: beforeLines[op.before!] })
      continue
    }
    if (op.kind === 'insert') {
      changes.push({ kind: 'added', after: afterLines[op.after!] })
      continue
    }
    const was = beforeLines[op.before!]!
    const now = afterLines[op.after!]!
    if (was.text !== now.text) changes.push({ kind: 'changed', before: was, after: now })
  }
  changes.sort((left, right) => (left.after?.line ?? left.before?.line ?? 0) - (right.after?.line ?? right.before?.line ?? 0)
    || (left.before?.line ?? 0) - (right.before?.line ?? 0))
  const count = (kind: MailBodyChange['kind']): number => changes.filter(change => change.kind === kind).length
  return {
    changes,
    summary: { before: beforeLines.length, after: afterLines.length,
      added: count('added'), removed: count('removed'), changed: count('changed') },
    alignment: aligned.alignment,
  }
}

/** The parts of an attachment that differ under the same name. */
function attachmentFields(before: MailAttachmentInfo, after: MailAttachmentInfo): MailAttachmentField[] {
  const fields: MailAttachmentField[] = []
  // Compare content only when both revisions have a fingerprint. A one-sided fingerprint is a conservative content
  // change: the preview cannot prove the bytes are equal, so it must not report the attachment as unchanged.
  if (before.digest !== undefined && after.digest !== undefined) {
    if (before.digest !== after.digest) fields.push('content')
  } else if (before.digest !== undefined || after.digest !== undefined) {
    fields.push('content')
  }
  if (before.size !== undefined && after.size !== undefined && before.size !== after.size) fields.push('size')
  if ((before.contentType ?? '').toLowerCase() !== (after.contentType ?? '').toLowerCase()) fields.push('contentType')
  if (before.inline !== after.inline) fields.push('inline')
  return fields
}

/** The attachment section: added, removed and changed attachments, keyed by name. */
function diffAttachments(before: readonly MailAttachmentInfo[], after: readonly MailAttachmentInfo[]): MailAttachmentsDiff {
  const beforeByName = new Map(before.map(attachment => [attachment.name, attachment]))
  const afterByName = new Map(after.map(attachment => [attachment.name, attachment]))
  const changes: MailAttachmentChange[] = []
  const unverified: string[] = []
  for (const attachment of after) {
    const was = beforeByName.get(attachment.name)
    if (!was) {
      changes.push({ kind: 'added', name: attachment.name, after: attachment })
      continue
    }
    const fields = attachmentFields(was, attachment)
    if (fields.length) changes.push({ kind: 'changed', name: attachment.name, before: was, after: attachment, fields })
    // Added attachments have nothing to compare; a pair is unverified when either revision has only metadata.
    if (was.digest === undefined || attachment.digest === undefined) unverified.push(attachment.name)
  }
  for (const attachment of before) {
    if (!afterByName.has(attachment.name)) changes.push({ kind: 'removed', name: attachment.name, before: attachment })
  }
  const count = (kind: MailAttachmentChange['kind']): number => changes.filter(change => change.kind === kind).length
  return {
    changes,
    summary: { before: before.length, after: after.length,
      added: count('added'), removed: count('removed'), changed: count('changed') },
    unverified,
  }
}

/**
 * Preview one mail draft against another. The envelope is compared per address so a move between To, Cc and Bcc is one
 * explicit change, the after audience lists every address (Bcc included) and the subject, body and attachments are
 * diffed in their own sections.
 */
export function previewMail(input: MailPreviewInput): MailPreview {
  if (!input || typeof input !== 'object') throw new TypeError('A mail preview needs two drafts and a link')
  if (typeof input.link !== 'string' || !input.link.trim()) throw new TypeError('The original link must be a non-empty string')
  const before = normalizeDraft(input.before, 'The before draft')
  const after = normalizeDraft(input.after, 'The after draft')
  const recipients = compareRecipients(before, after)
  const subject: MailSubjectDiff = { before: before.subject, after: after.subject, changed: before.subject !== after.subject }
  const body = diffBody(before.body, after.body)
  const attachments = diffAttachments(before.attachments, after.attachments)
  const recipientsSummary = (kind: MailRecipientChange['kind']): number =>
    recipients.changes.filter(change => change.kind === kind).length
  return {
    kind: 'mail/draft',
    unit: 'message',
    link: input.link,
    recipients,
    subject,
    body,
    attachments,
    summary: {
      recipients: {
        before: recipients.before.total,
        after: recipients.after.total,
        added: recipientsSummary('added'),
        removed: recipientsSummary('removed'),
        changed: recipientsSummary('changed'),
      },
      subject: { changed: subject.changed },
      body: body.summary,
      attachments: attachments.summary,
    },
  }
}