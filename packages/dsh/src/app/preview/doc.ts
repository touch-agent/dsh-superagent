/** The doc previewer: Markdown and Word documents become paragraph blocks, compared into a structured redline. */
import { inflateRawSync } from 'node:zlib'

/** The two document formats the previewer reads. */
export type DocFormat = 'markdown' | 'docx'

/** What one block of a document is, so a heading or list change is not read as a plain text change. */
export type DocBlockKind = 'heading' | 'paragraph' | 'list' | 'quote' | 'code' | 'table'

/** One paragraph (or code/table block) of a document, with the text a person reads. */
export interface DocBlock {
  kind: DocBlockKind
  /** The heading level, 1 to 6; set only for a heading. */
  level?: number
  text: string
}

/** One block named by its zero-based position and the text it holds. */
export interface DocBlockRef {
  index: number
  kind: DocBlockKind
  level?: number
  text: string
}

/** The four changes a paragraph can go through, as a person reads them. */
export type DocChangeKind = 'added' | 'removed' | 'changed' | 'moved'

/** One token of a changed paragraph's inline comparison, in reading order. */
export interface DocInline {
  kind: 'equal' | 'added' | 'removed'
  text: string
}

/**
 * One paragraph-level change. `added` and `removed` name one side, `changed` and `moved` name both; a changed paragraph
 * also carries the inline token comparison when it is small enough to be useful. A moved paragraph keeps its text and
 * only its position changes.
 */
export interface DocChange {
  kind: DocChangeKind
  before?: DocBlockRef
  after?: DocBlockRef
  inline?: DocInline[]
}

/** The counts a panel shows above a redline. */
export interface DocSummary {
  before: number
  after: number
  added: number
  removed: number
  changed: number
  moved: number
}

/** Why a document could not be read as a structured document, so the preview fell back to a generic text diff. */
export const DOC_PARSE_CODES = ['notZip', 'missingDocument', 'invalidDocument', 'tooLarge'] as const
/** The coded reason a structured parse failed. */
export type DocParseCode = typeof DOC_PARSE_CODES[number]

const DOC_PARSE_MESSAGES: Record<DocParseCode, string> = {
  notZip: 'The .docx content is not a ZIP archive',
  missingDocument: 'The .docx archive has no word/document.xml',
  invalidDocument: 'The .docx document could not be read',
  tooLarge: 'The .docx document is too large to preview',
}

/** A parse failure the previewer may degrade to a text diff; it is not a caller error. */
export class DocParseError extends Error {
  readonly code: DocParseCode
  readonly detail?: string
  constructor(code: DocParseCode, detail?: string) {
    super(detail ? `${DOC_PARSE_MESSAGES[code]}: ${detail}` : DOC_PARSE_MESSAGES[code])
    this.name = 'DocParseError'
    this.code = code
    this.detail = detail
  }
}

/** One side of a comparison: Markdown text or the bytes of a .docx file. */
export interface DocSource {
  format: DocFormat
  content: string | Uint8Array
  /**
   * The best plain text of this side, used only when structured parsing fails and the preview degrades to a line diff.
   * A binary document whose archive is unreadable has no recoverable text otherwise.
   */
  text?: string
}

/** What one comparison needs: the two revisions and the original link a reviewer can open. */
export interface DocPreviewInput {
  before: DocSource
  after: DocSource
  link: string
}

/** Why the preview is a generic line diff rather than a structured redline, and which side could not be read. */
export interface DocDegradation {
  code: DocParseCode
  message: string
  side: 'before' | 'after'
}

/**
 * The structured preview of one document revision against another. `text/redline` is the paragraph diff;
 * `text/diff` is the D4 fallback when a document cannot be parsed, and `degraded` says why. The original link is
 * always kept so a person can open the artifact even when only a line diff could be produced. The previewer registry
 * that stores this value and gives the Deliverable its `PreviewRef` is the review surface's work.
 */
export interface DocPreview {
  kind: 'text/redline' | 'text/diff'
  format: DocFormat
  unit: 'paragraph' | 'line'
  link: string
  changes: DocChange[]
  summary: DocSummary
  degraded?: DocDegradation
}

/** The cells the paragraph aligner may fill; beyond this the changed middle is paired without full alignment. */
const MAX_ALIGN_CELLS = 4_000_000
/** The token cells the inline comparison may fill before it is left out of a changed paragraph. */
const MAX_INLINE_CELLS = 250_000
/** The most inline segments a changed paragraph keeps before the comparison is left out. */
const MAX_INLINE_SEGMENTS = 400
/** How alike two paragraphs must be for a removal and an insertion to be read as one changed paragraph. */
const CHANGE_THRESHOLD = 0.5
/** The largest `word/document.xml` the previewer inflates, so one document cannot exhaust the process. */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
/** The ZIP records a .docx needs; a document has many more entries, but no more than this are read. */
const MAX_ZIP_ENTRIES = 10_000

const ZIP_END = 0x06054b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_LOCAL = 0x04034b50
const ZIP_COMMENT_MAX = 65_535
const DOCUMENT_ENTRY = 'word/document.xml'
const textDecoder = new TextDecoder('utf-8', { fatal: false })

/** Read one stored or deflated ZIP entry by name, with the shapes a .docx uses. */
function zipEntry(bytes: Uint8Array, name: string): Uint8Array {
  if (bytes.length < 22) throw new DocParseError('notZip')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = Math.max(0, bytes.length - 22 - ZIP_COMMENT_MAX)
  let end = -1
  for (let at = bytes.length - 22; at >= first; at--) {
    if (view.getUint32(at, true) === ZIP_END) { end = at; break }
  }
  if (end < 0) throw new DocParseError('notZip')
  const count = view.getUint16(end + 10, true)
  const directory = view.getUint32(end + 16, true)
  if (count === 0xffff || directory === 0xffffffff) throw new DocParseError('invalidDocument', 'ZIP64 is not supported')
  if (count > MAX_ZIP_ENTRIES) throw new DocParseError('invalidDocument', 'the archive has too many entries')
  let at = directory
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length) throw new DocParseError('invalidDocument', 'the central directory is truncated')
    if (view.getUint32(at, true) !== ZIP_CENTRAL) throw new DocParseError('invalidDocument', 'the central directory is malformed')
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const uncompressed = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > bytes.length) throw new DocParseError('invalidDocument', 'the central directory is truncated')
    const entry = textDecoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at = next
    if (entry !== name) continue
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new DocParseError('invalidDocument', 'ZIP64 is not supported')
    if (uncompressed > MAX_DOCUMENT_BYTES) throw new DocParseError('tooLarge')
    if (local + 30 > bytes.length || view.getUint32(local, true) !== ZIP_LOCAL) {
      throw new DocParseError('invalidDocument', 'the entry has no local header')
    }
    const localName = view.getUint16(local + 26, true)
    const localExtra = view.getUint16(local + 28, true)
    const start = local + 30 + localName + localExtra
    if (start + compressed > bytes.length) throw new DocParseError('invalidDocument', 'the entry is truncated')
    const data = bytes.subarray(start, start + compressed)
    if (method === 0) {
      if (data.length !== uncompressed) throw new DocParseError('invalidDocument', 'a stored entry has the wrong size')
      return data
    }
    if (method !== 8) throw new DocParseError('invalidDocument', `unsupported compression method ${method}`)
    try {
      const inflated = inflateRawSync(data, { maxOutputLength: uncompressed || MAX_DOCUMENT_BYTES })
      if (inflated.length !== uncompressed) throw new DocParseError('invalidDocument', 'the entry has the wrong size')
      return inflated
    } catch (error) {
      if (error instanceof DocParseError) throw error
      throw new DocParseError('invalidDocument', 'the document entry could not be inflated')
    }
  }
  throw new DocParseError('missingDocument')
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Turn the entities Word writes into the text they stand for. */
function xmlText(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, decimal: string | undefined, hex: string | undefined,
    named: string | undefined) => {
    if (decimal) return codePoint(Number(decimal), whole)
    if (hex) return codePoint(Number.parseInt(hex, 16), whole)
    return XML_ENTITIES[named!.toLowerCase()] ?? whole
  })
}

/** One Unicode code point as text; an invalid reference is kept as written instead of throwing. */
function codePoint(value: number, whole: string): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value) : whole
}

/** Collapse the whitespace that comes from XML formatting, tabs and line breaks, so the diff reads paragraphs. */
function normalize(value: string): string { return value.replace(/\s+/g, ' ').trim() }

/** A paragraph's heading level, from its paragraph style or outline level; 0 when it is not a heading. */
function headingLevel(paragraph: string): number {
  const style = /<(?:\w+:)?pStyle\b[^>]*\b(?:\w+:)?val="([^"]*)"/.exec(paragraph)?.[1]?.trim()
  if (style) {
    if (/^title$/i.test(style)) return 1
    const heading = /^heading\s*([1-9])$/i.exec(style)
    if (heading) return Number(heading[1])
  }
  const outline = /<(?:\w+:)?outlineLvl\b[^>]*\b(?:\w+:)?val="([0-9])"/.exec(paragraph)?.[1]
  return outline === undefined ? 0 : Number(outline) + 1
}

/** Parse the text and paragraph properties of one `w:p` element. */
function docxParagraph(paragraph: string): DocBlock | undefined {
  const pieces: string[] = []
  const token = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?(?:tab|br)\b[^>]*\/>|<(?:\w+:)?noBreakHyphen\b[^>]*\/>/g
  for (const match of paragraph.matchAll(token)) {
    if (match[1] !== undefined) pieces.push(xmlText(match[1]))
    else if (/noBreakHyphen/i.test(match[0])) pieces.push('-')
    else pieces.push(' ')
  }
  const text = normalize(pieces.join(''))
  if (!text) return undefined
  const level = headingLevel(paragraph)
  if (level) return { kind: 'heading', level: Math.min(level, 6), text }
  if (/<(?:\w+:)?numPr\b/.test(paragraph)) return { kind: 'list', text }
  return { kind: 'paragraph', text }
}

/**
 * Parse a Word document into paragraph blocks. The body's paragraphs are read in document order; tables are flattened
 * to their cell paragraphs and an embedded text box is read as part of its paragraph. Paragraph style, outline level
 * and numbering give a heading or list block; formatting-only differences the XML hides, such as fonts and colours, are
 * not compared.
 */
export function parseDocx(bytes: Uint8Array): DocBlock[] {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('The .docx content must be bytes')
  const xml = textDecoder.decode(zipEntry(bytes, DOCUMENT_ENTRY))
  if (!/<(?:\w+:)?document\b/.test(xml) || !/<(?:\w+:)?body\b/.test(xml)) {
    throw new DocParseError('invalidDocument', 'the document has no body')
  }
  const blocks: DocBlock[] = []
  for (const match of xml.matchAll(/<(?:\w+:)?p(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?p>/g)) {
    const block = docxParagraph(match[1]!)
    if (block) blocks.push(block)
  }
  return blocks
}

/**
 * Parse Markdown into paragraph blocks. Headings, list items, quotes and table rows are blocks of their own; contiguous
 * prose lines join into one paragraph; a fenced code block is one block and keeps its lines. Inline Markdown is compared
 * as written, so a formatting-only edit is a changed paragraph.
 */
export function parseMarkdown(text: string): DocBlock[] {
  if (typeof text !== 'string') throw new TypeError('The Markdown content must be a string')
  const blocks: DocBlock[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  const flush = (): void => {
    const value = normalize(paragraph.join(' '))
    if (value) blocks.push({ kind: 'paragraph', text: value })
    paragraph = []
  }
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.replace(/\s+$/, '')
    if (!line.trim()) { flush(); continue }
    const fence = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      flush()
      const marker = fence[1]!
      const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
      const code: string[] = []
      for (index++; index < lines.length && !close.test(lines[index]!); index++) code.push(lines[index]!.replace(/\s+$/, ''))
      const value = code.join('\n').replace(/\n+$/, '')
      if (value.trim()) blocks.push({ kind: 'code', text: value })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const value = normalize(heading[2]!)
      if (value) blocks.push({ kind: 'heading', level: heading[1]!.length, text: value })
      continue
    }
    // A setext underline turns the prose lines above it into a heading; alone, `---` is a thematic break.
    const underline = /^\s*(=+|-+)\s*$/.exec(line)
    if (underline && paragraph.length) {
      const value = normalize(paragraph.join(' '))
      paragraph = []
      if (value) blocks.push({ kind: 'heading', level: underline[1]![0] === '=' ? 1 : 2, text: value })
      continue
    }
    const list = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
    if (list) {
      flush()
      const value = normalize(list[1]!)
      if (value) blocks.push({ kind: 'list', text: value })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      const value = normalize(quote[1]!)
      if (value) blocks.push({ kind: 'quote', text: value })
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush()
      blocks.push({ kind: 'table', text: line.trim() })
      continue
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); continue }
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}

/** The text two blocks must share to be the same block: kind, heading level and normalized text. */
function blockKey(block: DocBlock): string { return `${block.kind}\u0000${block.level ?? 0}\u0000${block.text}` }

type EqualOp = { kind: 'equal'; before: number; after: number }
type DeleteOp = { kind: 'delete'; before: number; movedTo?: number }
type InsertOp = { kind: 'insert'; after: number; movedFrom?: number }
type Op = EqualOp | DeleteOp | InsertOp

/** Align two block lists, keeping the equal prefix and suffix out of the quadratic middle. */
function align(before: readonly DocBlock[], after: readonly DocBlock[]): Op[] {
  const keysBefore = before.map(blockKey)
  const keysAfter = after.map(blockKey)
  let start = 0
  while (start < keysBefore.length && start < keysAfter.length && keysBefore[start] === keysAfter[start]) start++
  let endBefore = keysBefore.length
  let endAfter = keysAfter.length
  while (endBefore > start && endAfter > start && keysBefore[endBefore - 1] === keysAfter[endAfter - 1]) {
    endBefore--
    endAfter--
  }
  const ops: Op[] = []
  for (let index = 0; index < start; index++) ops.push({ kind: 'equal', before: index, after: index })
  const rows = endBefore - start
  const columns = endAfter - start
  if (rows && columns && (rows + 1) * (columns + 1) <= MAX_ALIGN_CELLS) {
    const width = columns + 1
    const lengths = new Uint32Array((rows + 1) * width)
    for (let row = rows - 1; row >= 0; row--) {
      const base = row * width
      const next = base + width
      for (let column = columns - 1; column >= 0; column--) {
        lengths[base + column] = keysBefore[start + row] === keysAfter[start + column]
          ? lengths[next + column + 1]! + 1
          : Math.max(lengths[next + column]!, lengths[base + column + 1]!)
      }
    }
    let row = 0
    let column = 0
    while (row < rows && column < columns) {
      if (keysBefore[start + row] === keysAfter[start + column]) {
        ops.push({ kind: 'equal', before: start + row, after: start + column })
        row++
        column++
      } else if (lengths[(row + 1) * width + column]! >= lengths[row * width + column + 1]!) {
        ops.push({ kind: 'delete', before: start + row })
        row++
      } else {
        ops.push({ kind: 'insert', after: start + column })
        column++
      }
    }
    while (row < rows) { ops.push({ kind: 'delete', before: start + row }); row++ }
    while (column < columns) { ops.push({ kind: 'insert', after: start + column }); column++ }
  } else {
    // A very large rewrite is still useful as removals and insertions; the pairing below reads the changes.
    for (let index = start; index < endBefore; index++) ops.push({ kind: 'delete', before: index })
    for (let index = start; index < endAfter; index++) ops.push({ kind: 'insert', after: index })
  }
  for (let index = 0; endBefore + index < keysBefore.length; index++) {
    ops.push({ kind: 'equal', before: endBefore + index, after: endAfter + index })
  }
  return ops
}

/**
 * Pair an unaligned removal with an unaligned insertion of the same block as a move, choosing the nearest position so
 * duplicate paragraphs pair with the copy they most likely came from.
 */
function markMoves(ops: readonly Op[], before: readonly DocBlock[], after: readonly DocBlock[]): void {
  const keysBefore = before.map(blockKey)
  const keysAfter = after.map(blockKey)
  const inserts = new Map<string, InsertOp[]>()
  for (const op of ops) {
    if (op.kind !== 'insert') continue
    const key = keysAfter[op.after]!
    const list = inserts.get(key)
    if (list) list.push(op)
    else inserts.set(key, [op])
  }
  for (const op of ops) {
    if (op.kind !== 'delete') continue
    const candidates = inserts.get(keysBefore[op.before]!)
    if (!candidates) continue
    let match: InsertOp | undefined
    let distance = Number.POSITIVE_INFINITY
    for (const candidate of candidates) {
      if (candidate.movedFrom !== undefined) continue
      const gap = Math.abs(candidate.after - op.before)
      if (gap < distance) { distance = gap; match = candidate }
    }
    if (match) { op.movedTo = match.after; match.movedFrom = op.before }
  }
}

/** Dice similarity over character bigrams: enough to tell an edited paragraph from an unrelated one in any script. */
function similarity(before: string, after: string): number {
  if (before === after) return 1
  const left = Array.from(before)
  const right = Array.from(after)
  if (left.length < 2 || right.length < 2) return before === after ? 1 : 0
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

/** Words in Latin scripts, one token per CJK character, and one token per whitespace run or punctuation mark. */
const INLINE_TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|\s+|[^\s\p{L}\p{N}]/gu

/** Compare two changed paragraphs token by token, coalescing adjacent segments; undefined when too large or identical. */
function inlineDiff(before: string, after: string): DocInline[] | undefined {
  if (before === after) return undefined
  const left = before.match(INLINE_TOKEN) ?? []
  const right = after.match(INLINE_TOKEN) ?? []
  if (!left.length || !right.length) return undefined
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) start++
  let endLeft = left.length
  let endRight = right.length
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) { endLeft--; endRight-- }
  const rows = endLeft - start
  const columns = endRight - start
  if (rows && columns && (rows + 1) * (columns + 1) > MAX_INLINE_CELLS) return undefined
  const segments: DocInline[] = []
  const push = (kind: DocInline['kind'], text: string): void => {
    if (!text) return
    const last = segments.at(-1)
    if (last?.kind === kind) last.text += text
    else segments.push({ kind, text })
  }
  for (let index = 0; index < start; index++) push('equal', left[index]!)
  if (rows && columns) {
    const width = columns + 1
    const lengths = new Uint32Array((rows + 1) * width)
    for (let row = rows - 1; row >= 0; row--) {
      const base = row * width
      const next = base + width
      for (let column = columns - 1; column >= 0; column--) {
        lengths[base + column] = left[start + row] === right[start + column]
          ? lengths[next + column + 1]! + 1
          : Math.max(lengths[next + column]!, lengths[base + column + 1]!)
      }
    }
    let row = 0
    let column = 0
    while (row < rows && column < columns) {
      if (left[start + row] === right[start + column]) {
        push('equal', left[start + row]!)
        row++
        column++
      } else if (lengths[(row + 1) * width + column]! >= lengths[row * width + column + 1]!) {
        push('removed', left[start + row]!)
        row++
      } else {
        push('added', right[start + column]!)
        column++
      }
    }
    while (row < rows) { push('removed', left[start + row]!); row++ }
    while (column < columns) { push('added', right[start + column]!); column++ }
  } else {
    for (let index = start; index < endLeft; index++) push('removed', left[index]!)
    for (let index = start; index < endRight; index++) push('added', right[index]!)
  }
  for (let index = 0; endLeft + index < left.length; index++) push('equal', left[endLeft + index]!)
  return segments.length <= MAX_INLINE_SEGMENTS ? segments : undefined
}

/** Name a block by its position. */
function blockRef(blocks: readonly DocBlock[], index: number): DocBlockRef {
  const block = blocks[index]!
  return { index, kind: block.kind, ...(block.level === undefined ? {} : { level: block.level }), text: block.text }
}

/** Turn one run of unaligned removals and insertions into changed, removed and added changes. */
function runChanges(run: readonly (DeleteOp | InsertOp)[], before: readonly DocBlock[], after: readonly DocBlock[]): DocChange[] {
  const removals = run.filter((op): op is DeleteOp => op.kind === 'delete')
  const insertions = run.filter((op): op is InsertOp => op.kind === 'insert')
  const paired = new Map<DeleteOp, InsertOp>()
  const used = new Set<InsertOp>()
  for (const removal of removals) {
    let best: InsertOp | undefined
    let score = CHANGE_THRESHOLD
    for (const insertion of insertions) {
      if (used.has(insertion)) continue
      const candidate = similarity(before[removal.before]!.text, after[insertion.after]!.text)
      if (candidate > score) { score = candidate; best = insertion }
    }
    if (best) { paired.set(removal, best); used.add(best) }
  }
  const changes: DocChange[] = []
  for (const op of run) {
    if (op.kind === 'insert') {
      if (!used.has(op)) changes.push({ kind: 'added', after: blockRef(after, op.after) })
      continue
    }
    const match = paired.get(op)
    if (!match) { changes.push({ kind: 'removed', before: blockRef(before, op.before) }); continue }
    const previous = blockRef(before, op.before)
    const next = blockRef(after, match.after)
    const inline = inlineDiff(previous.text, next.text)
    changes.push({ kind: 'changed', before: previous, after: next, ...(inline ? { inline } : {}) })
  }
  return changes
}

/** Diff two block lists into added, removed, changed and moved changes, in reading order. */
export function diffDocBlocks(before: readonly DocBlock[], after: readonly DocBlock[]): DocChange[] {
  const ops = align(before, after)
  markMoves(ops, before, after)
  const changes: DocChange[] = []
  for (let index = 0; index < ops.length;) {
    const op = ops[index]!
    if (op.kind === 'equal') { index++; continue }
    if (op.kind === 'delete' && op.movedTo !== undefined) {
      changes.push({ kind: 'moved', before: blockRef(before, op.before), after: blockRef(after, op.movedTo) })
      index++
      continue
    }
    if (op.kind === 'insert' && op.movedFrom !== undefined) { index++; continue }
    const run: (DeleteOp | InsertOp)[] = []
    while (index < ops.length) {
      const next = ops[index]!
      if (next.kind === 'equal' || (next.kind === 'delete' && next.movedTo !== undefined)
        || (next.kind === 'insert' && next.movedFrom !== undefined)) break
      run.push(next)
      index++
    }
    changes.push(...runChanges(run, before, after))
  }
  return changes
}

/** The counts a panel needs, read off the changes once. */
function summarize(before: readonly DocBlock[], after: readonly DocBlock[], changes: readonly DocChange[]): DocSummary {
  const summary: DocSummary = { before: before.length, after: after.length, added: 0, removed: 0, changed: 0, moved: 0 }
  for (const change of changes) summary[change.kind]++
  return summary
}

/** The best plain text of a side when a structured parse fails: the caller's text, or what the bytes decode to. */
function fallbackText(side: DocSource): string {
  if (side.text !== undefined) return side.text
  if (typeof side.content === 'string') return side.content
  return textDecoder.decode(side.content).replace(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/g, ' ')
}

/** A line diff's blocks: non-empty lines, trailing blanks removed, so a fallback still reads as a diff. */
function fallbackBlocks(side: DocSource): DocBlock[] {
  return fallbackText(side).replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => line.trim())
    .map(line => ({ kind: 'paragraph' as const, text: line }))
}

/** Parse one side, naming a .docx handed over as text as unreadable rather than throwing a caller error. */
function parseSide(side: DocSource): DocBlock[] {
  if (side.format === 'markdown') {
    return parseMarkdown(typeof side.content === 'string' ? side.content : textDecoder.decode(side.content))
  }
  if (typeof side.content !== 'string') return parseDocx(side.content)
  throw new DocParseError('notZip', 'the document was given as text')
}

/** Validate one side without turning a parse failure into a caller error. */
function docSource(value: unknown, what: string): DocSource {
  if (!value || typeof value !== 'object') throw new TypeError(`${what} must name a document`)
  const source = value as Partial<DocSource>
  if (source.format !== 'markdown' && source.format !== 'docx') throw new TypeError(`${what} must be markdown or docx`)
  if (typeof source.content !== 'string' && !(source.content instanceof Uint8Array)) {
    throw new TypeError(`${what} content must be text or bytes`)
  }
  if (source.text !== undefined && typeof source.text !== 'string') throw new TypeError(`${what} text must be a string`)
  return { format: source.format, content: source.content, ...(source.text === undefined ? {} : { text: source.text }) }
}

/**
 * Preview one document revision against another. Markdown and Word documents are read as paragraphs and diffed into
 * added, removed, changed and moved blocks; when either side cannot be parsed, the preview degrades to `text/diff`, a
 * generic line diff of the best available text, and states the parse code and side while keeping the original link (D4).
 */
export function previewDoc(input: DocPreviewInput): DocPreview {
  if (!input || typeof input !== 'object') throw new TypeError('A document preview needs two documents and a link')
  const before = docSource(input.before, 'The before document')
  const after = docSource(input.after, 'The after document')
  if (before.format !== after.format) throw new TypeError('Both documents must have the same format')
  if (typeof input.link !== 'string' || !input.link.trim()) throw new TypeError('The original link must be a non-empty string')
  let beforeBlocks: DocBlock[]
  let afterBlocks: DocBlock[]
  try { beforeBlocks = parseSide(before) } catch (error) {
    if (!(error instanceof DocParseError)) throw error
    return degradedPreview(before, after, input.link, 'before', error)
  }
  try { afterBlocks = parseSide(after) } catch (error) {
    if (!(error instanceof DocParseError)) throw error
    return degradedPreview(before, after, input.link, 'after', error)
  }
  const changes = diffDocBlocks(beforeBlocks, afterBlocks)
  return {
    kind: 'text/redline',
    format: before.format,
    unit: 'paragraph',
    link: input.link,
    changes,
    summary: summarize(beforeBlocks, afterBlocks, changes),
  }
}

/** The D4 fallback: a line diff of both sides' best text, the original link and the coded parse failure. */
function degradedPreview(before: DocSource, after: DocSource, link: string, side: 'before' | 'after',
  error: DocParseError): DocPreview {
  const beforeBlocks = fallbackBlocks(before)
  const afterBlocks = fallbackBlocks(after)
  const changes = diffDocBlocks(beforeBlocks, afterBlocks)
  return {
    kind: 'text/diff',
    format: before.format,
    unit: 'line',
    link,
    changes,
    summary: summarize(beforeBlocks, afterBlocks, changes),
    degraded: { code: error.code, message: error.message, side },
  }
}