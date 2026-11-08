/** The sheet previewer: CSV and .xlsx spreadsheets become sparse cells, compared by row and column. */
import { inflateRawSync } from 'node:zlib'

/** The two spreadsheet formats the previewer reads. */
export type SheetFormat = 'csv' | 'xlsx'

/** One non-empty cell: the stored value a reviewer compares and the formula that computes it, when it has one. */
export interface SheetCell {
  /** Zero-based row and column, so callers do not parse an address to find a cell. */
  row: number
  column: number
  /** The A1-style address a person recognises. */
  address: string
  /** The value as the file stores it; number formats are presentation, not part of the comparison. */
  value: string
  /** The formula without its leading `=`, when the cell has one. */
  formula?: string
}

/** One row that has at least one cell, with its cells in column order. */
export interface SheetRow {
  index: number
  cells: SheetCell[]
}

/** One sheet: its name, the rows that have cells, and how far the used range reaches. */
export interface Sheet {
  name: string
  rows: SheetRow[]
  /** One past the last used row; zero for an empty sheet. */
  rowCount: number
  /** One past the last used column; zero for an empty sheet. */
  columnCount: number
}

/** One side of a comparison: CSV text or the bytes of an .xlsx workbook. */
export interface SheetSource {
  format: SheetFormat
  content: string | Uint8Array
  /** The best plain text of this side, used only when a workbook cannot be parsed and the preview degrades. */
  text?: string
}

/** What one comparison needs: the two revisions and the original link a reviewer can open. */
export interface SheetPreviewInput {
  before: SheetSource
  after: SheetSource
  link: string
}

/** Why a workbook could not be read as a workbook. */
export const SHEET_PARSE_CODES = ['notZip', 'missingWorkbook', 'invalidWorkbook', 'missingSheet', 'tooLarge'] as const
/** The coded reason a workbook parse failed. */
export type SheetParseCode = typeof SHEET_PARSE_CODES[number]

const SHEET_PARSE_MESSAGES: Record<SheetParseCode, string> = {
  notZip: 'The .xlsx content is not a ZIP archive',
  missingWorkbook: 'The .xlsx archive has no xl/workbook.xml',
  invalidWorkbook: 'The .xlsx workbook could not be read',
  missingSheet: 'The .xlsx workbook names a sheet the archive does not hold',
  tooLarge: 'The .xlsx workbook is too large to preview',
}

/** A parse failure the previewer may degrade to a text diff; it is not a caller error. */
export class SheetParseError extends Error {
  readonly code: SheetParseCode
  readonly detail?: string
  constructor(code: SheetParseCode, detail?: string) {
    super(detail ? `${SHEET_PARSE_MESSAGES[code]}: ${detail}` : SHEET_PARSE_MESSAGES[code])
    this.name = 'SheetParseError'
    this.code = code
    this.detail = detail
  }
}

/** Why the preview is a generic line diff rather than a cell diff, and which side could not be read. */
export interface SheetDegradation {
  code: SheetParseCode
  message: string
  side: 'before' | 'after'
}

/** A column that only one side has, with the A1 label and how many cells it holds. */
export interface SheetColumn {
  index: number
  label: string
  cells: number
}

/** A row that only one side has, with how many cells it holds. */
export interface SheetRowRef {
  index: number
  cells: number
}

/** One cell that changed; a formula change is never also counted as a value change. */
export interface SheetCellChange {
  /** The sheet the change is in; a CSV file has one, named Sheet1. */
  sheet: string
  kind: 'added' | 'removed' | 'formula' | 'value'
  /** The position in the after sheet, so a removed cell still points at where it used to be. */
  row: number
  column: number
  address: string
  before?: SheetCell
  after?: SheetCell
}

/** One line of a fallback text diff. */
export interface SheetLine {
  /** One-based line number, as an editor shows it. */
  line: number
  text: string
}

/** One changed line in the degraded text diff. */
export interface SheetLineChange {
  kind: 'added' | 'removed' | 'changed'
  before?: SheetLine
  after?: SheetLine
}

/** The changes in one sheet both revisions have. */
export interface SheetDiff {
  name: string
  status: 'changed' | 'unchanged'
  /** Rows are zero-based; `before` and `after` count one past the last used row on each side. */
  rows: { before: number; after: number; added: SheetRowRef[]; removed: SheetRowRef[] }
  /** Columns are zero-based; `before` and `after` count one past the last used column on each side. */
  columns: { before: number; after: number; added: SheetColumn[]; removed: SheetColumn[] }
  summary: {
    rows: { added: number; removed: number }
    columns: { added: number; removed: number }
    cells: { added: number; removed: number; formula: number; value: number }
  }
}

/** A sheet only one revision has. */
export interface SheetInfo {
  name: string
  rows: number
  columns: number
}

/** The counts a panel needs for one preview. Row, column and cell counts cover sheets both sides have. */
export interface SheetSummary {
  sheets: { before: number; after: number; added: number; removed: number; changed: number }
  rows: { before: number; after: number; added: number; removed: number }
  columns: { before: number; after: number; added: number; removed: number }
  cells: { added: number; removed: number; formula: number; value: number }
}

/**
 * The structured preview of one spreadsheet revision against another. `sheet/cell-diff` compares cells by row and
 * column, keeps formula changes and value changes apart, and lists rows and columns only one side has. `text/diff` is
 * the D4 fallback when a workbook cannot be parsed, with `degraded` saying why and the original link kept. The
 * previewer registry that stores this value and gives the Deliverable its `PreviewRef` is the review surface's work.
 */
export interface SheetPreview {
  kind: 'sheet/cell-diff' | 'text/diff'
  format: SheetFormat
  unit: 'cell' | 'line'
  link: string
  /** The sheets both revisions have, in before order. */
  sheets: SheetDiff[]
  /** Whole sheets that only the after or the before revision has. */
  addedSheets: SheetInfo[]
  removedSheets: SheetInfo[]
  /** Cell changes in the sheets both sides have, in reading order. */
  changes: SheetCellChange[]
  /** The fallback line diff; set only when `kind` is `text/diff`. */
  lines?: SheetLineChange[]
  summary: SheetSummary
  degraded?: SheetDegradation
}

/** The cells any alignment may fill, beyond which a changed run is paired by position. */
const MAX_PAIR_CELLS = 20_000
/** Column pairs whose Dice score is computed; each comparison walks every row, so this stays small. */
const MAX_COLUMN_PAIR_WORK = 512
/** The steps one Myers gap may take before that gap pairs by position. */
const MAX_ALIGN_WORK = 2_000_000
/** How alike two rows must be for an unmatched removal and insertion to be read as one changed row. */
const ROW_SIMILARITY = 0.5
/** How alike two columns must be for an unmatched removal and insertion to be read as one changed column. */
const COLUMN_SIMILARITY = 0.5
/** The largest XML entry the previewer inflates, so one workbook cannot exhaust the process. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** The ZIP records a workbook needs; a workbook has more entries, but no more than this are read. */
const MAX_ZIP_ENTRIES = 10_000

const ZIP_END = 0x06054b50
const ZIP_CENTRAL = 0x02014b50
const ZIP_LOCAL = 0x04034b50
const ZIP_COMMENT_MAX = 65_535
const WORKBOOK_ENTRY = 'xl/workbook.xml'
const WORKBOOK_RELS_ENTRY = 'xl/_rels/workbook.xml.rels'
const SHARED_STRINGS_ENTRY = 'xl/sharedStrings.xml'
const textDecoder = new TextDecoder('utf-8', { fatal: false })

/** Whether a number is a valid zero-based row or column. */
function isIndex(value: number): boolean { return Number.isInteger(value) && value >= 0 }

/** The A1 label of a zero-based column: 0 is A, 25 is Z, 26 is AA. */
export function columnLabel(index: number): string {
  if (!isIndex(index)) throw new TypeError('A column index must be a non-negative integer')
  let value = index + 1
  let label = ''
  while (value > 0) {
    const digit = (value - 1) % 26
    label = String.fromCharCode(65 + digit) + label
    value = Math.floor((value - 1) / 26)
  }
  return label
}

/** The zero-based column of an A1 label, or -1 when the label is not letters. */
export function columnIndex(label: string): number {
  if (!/^[A-Za-z]{1,4}$/.test(label)) return -1
  let value = 0
  for (const character of label.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64
  return value - 1
}

/** The address of one zero-based position. */
export function cellAddress(row: number, column: number): string {
  if (!isIndex(row) || !isIndex(column)) throw new TypeError('A cell position must be two non-negative integers')
  return `${columnLabel(column)}${row + 1}`
}

/** The zero-based position of an A1 address, or undefined when the address is malformed. */
function cellPosition(address: string): { row: number; column: number } | undefined {
  const match = /^([A-Za-z]{1,4})([0-9]{1,7})$/.exec(address.trim())
  if (!match) return undefined
  const column = columnIndex(match[1]!)
  const row = Number(match[2]!) - 1
  return column < 0 || row < 0 ? undefined : { row, column }
}

/** The cached value of a formula cell; a CSV formula's visible text is the formula itself and is not a cached result. */
function storedValue(cell: SheetCell): string | undefined {
  if (cell.formula === undefined) return cell.value
  return cell.value === `=${cell.formula}` ? undefined : cell.value
}

/** What a formula cell or a value cell contributes to a signature: the formula and the cached value. */
function cellToken(cell: SheetCell): string {
  return cell.formula === undefined ? cell.value : `=${formulaKey(cell)}\u0000${storedValue(cell) ?? ''}`
}

/** Group cells into the rows that have at least one of them, in row and then column order. */
function shapeSheet(name: string, cells: readonly SheetCell[]): Sheet {
  const rows = new Map<number, SheetCell[]>()
  let rowCount = 0
  let columnCount = 0
  for (const cell of cells) {
    const list = rows.get(cell.row)
    if (list) list.push(cell)
    else rows.set(cell.row, [cell])
    rowCount = Math.max(rowCount, cell.row + 1)
    columnCount = Math.max(columnCount, cell.column + 1)
  }
  return {
    name,
    rows: [...rows.entries()].sort((left, right) => left[0] - right[0])
      .map(([index, rowCells]) => ({ index, cells: rowCells.sort((left, right) => left.column - right.column) })),
    rowCount,
    columnCount,
  }
}

/** Build one cell, adding the address and formula shape every parser shares. */
function sheetCell(row: number, column: number, value: string, formula?: string): SheetCell {
  return {
    row,
    column,
    address: cellAddress(row, column),
    value,
    ...(formula === undefined || formula === '' ? {} : { formula }),
  }
}

/**
 * Parse CSV into one sheet named `name`. Quoted fields may hold commas, quotes and newlines; a cell beginning with `=`
 * is a formula, and its visible value is the formula text because CSV has no cached result. Empty cells are not stored,
 * so the previewer compares content and not a writer's blank-cell bookkeeping.
 */
export function parseCsv(text: string, name = 'Sheet1'): Sheet {
  if (typeof text !== 'string') throw new TypeError('The CSV content must be a string')
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < content.length; index++) {
    const character = content[index]!
    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') { field += '"'; index++ }
        else quoted = false
      } else field += character
      continue
    }
    if (character === '"' && field === '') quoted = true
    else if (character === ',') { row.push(field); field = '' }
    else if (character === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (character === '\r') {
      if (content[index + 1] === '\n') index++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += character
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  const cells: SheetCell[] = []
  rows.forEach((fields, rowIndex) => fields.forEach((value, columnIndex) => {
    if (value === '') return
    const formula = value.startsWith('=') && value.length > 1 ? value.slice(1) : undefined
    cells.push(sheetCell(rowIndex, columnIndex, value, formula))
  }))
  return shapeSheet(name, cells)
}

/** Read one stored or deflated ZIP entry by name, with the shapes an .xlsx uses. */
function zipEntry(bytes: Uint8Array, name: string): Uint8Array | undefined {
  if (bytes.length < 22) throw new SheetParseError('notZip')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const first = Math.max(0, bytes.length - 22 - ZIP_COMMENT_MAX)
  let end = -1
  for (let at = bytes.length - 22; at >= first; at--) {
    if (view.getUint32(at, true) === ZIP_END) { end = at; break }
  }
  if (end < 0) throw new SheetParseError('notZip')
  const count = view.getUint16(end + 10, true)
  const directory = view.getUint32(end + 16, true)
  if (count === 0xffff || directory === 0xffffffff) throw new SheetParseError('invalidWorkbook', 'ZIP64 is not supported')
  if (count > MAX_ZIP_ENTRIES) throw new SheetParseError('invalidWorkbook', 'the archive has too many entries')
  let at = directory
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length) throw new SheetParseError('invalidWorkbook', 'the central directory is truncated')
    if (view.getUint32(at, true) !== ZIP_CENTRAL) throw new SheetParseError('invalidWorkbook', 'the central directory is malformed')
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const uncompressed = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const next = at + 46 + nameLength + extraLength + commentLength
    if (next > bytes.length) throw new SheetParseError('invalidWorkbook', 'the central directory is truncated')
    const entry = textDecoder.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    at = next
    if (entry !== name) continue
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new SheetParseError('invalidWorkbook', 'ZIP64 is not supported')
    if (uncompressed > MAX_ENTRY_BYTES) throw new SheetParseError('tooLarge')
    if (local + 30 > bytes.length || view.getUint32(local, true) !== ZIP_LOCAL) {
      throw new SheetParseError('invalidWorkbook', 'the entry has no local header')
    }
    const localName = view.getUint16(local + 26, true)
    const localExtra = view.getUint16(local + 28, true)
    const start = local + 30 + localName + localExtra
    if (start + compressed > bytes.length) throw new SheetParseError('invalidWorkbook', 'the entry is truncated')
    const data = bytes.subarray(start, start + compressed)
    if (method === 0) {
      if (data.length !== uncompressed) throw new SheetParseError('invalidWorkbook', 'a stored entry has the wrong size')
      return data
    }
    if (method !== 8) throw new SheetParseError('invalidWorkbook', `unsupported compression method ${method}`)
    try {
      const inflated = inflateRawSync(data, { maxOutputLength: uncompressed || MAX_ENTRY_BYTES })
      if (inflated.length !== uncompressed) throw new SheetParseError('invalidWorkbook', 'the entry has the wrong size')
      return inflated
    } catch (error) {
      if (error instanceof SheetParseError) throw error
      throw new SheetParseError('invalidWorkbook', 'the workbook entry could not be inflated')
    }
  }
  return undefined
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Turn the entities a spreadsheet writer uses into the text they stand for. */
function xmlText(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-zA-Z]+));/g, (whole, decimal: string | undefined, hex: string | undefined,
    named: string | undefined) => {
    if (decimal) return codePoint(Number(decimal), whole)
    if (hex) return codePoint(Number.parseInt(hex, 16), whole)
    return Object.hasOwn(XML_ENTITIES, named!.toLowerCase()) ? XML_ENTITIES[named!.toLowerCase()]! : whole
  })
}

/** One Unicode code point as text; an invalid reference is kept as written instead of throwing. */
function codePoint(value: number, whole: string): string {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value) : whole
}

/** One XML attribute, matched with or without a namespace prefix. */
function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}="([^"]*)"`).exec(attributes)
  return match?.[1] === undefined ? undefined : xmlText(match[1])
}

/** All text in a fragment, joining rich-text runs; a phonetic hint is not part of the value. */
function fragmentText(fragment: string): string {
  const pieces: string[] = []
  const visible = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  for (const match of visible.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) pieces.push(xmlText(match[1]!))
  return pieces.join('')
}

/** One sheet name in the workbook, and the relationship that points at its XML. */
interface WorkbookSheet {
  name: string
  relationship: string | undefined
  fallback: number
}

/** Read the sheet list of `xl/workbook.xml`, in workbook order. */
function workbookSheets(xml: string): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = []
  for (const match of xml.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const attributes = match[1] ?? ''
    const name = xmlAttribute(attributes, 'name')
    if (!name) continue
    // The worksheet part is named by workbook order when the relationships are missing, not by the sheet id.
    sheets.push({ name, relationship: xmlAttribute(attributes, 'id'), fallback: sheets.length + 1 })
  }
  return sheets
}

/** One workbook relationship: where it points and whether it is a worksheet rather than, say, a chart sheet. */
interface WorkbookRelationship {
  target: string
  worksheet: boolean
  sharedStrings: boolean
}

/** Read the workbook relationships, keeping every target and whether it is a worksheet. */
function workbookRelationships(xml: string): Map<string, WorkbookRelationship> {
  const relationships = new Map<string, WorkbookRelationship>()
  for (const match of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attributes = match[1] ?? ''
    const id = xmlAttribute(attributes, 'Id')
    const target = xmlAttribute(attributes, 'Target')
    const type = xmlAttribute(attributes, 'Type')
    if (id && target) {
      relationships.set(id, { target, worksheet: type?.endsWith('/worksheet') === true,
        sharedStrings: type?.endsWith('/sharedStrings') === true })
    }
  }
  return relationships
}

/** Resolve a relationship target, which is relative to `xl/workbook.xml`, to an archive path. */
function worksheetPath(target: string): string {
  const pieces: string[] = []
  for (const piece of target.replace(/\\/g, '/').split('/')) {
    if (!piece || piece === '.') continue
    if (piece === '..') pieces.pop()
    else pieces.push(piece)
  }
  const joined = pieces.join('/')
  return joined.startsWith('xl/') ? joined : `xl/${joined}`
}

/** Read the shared strings, one entry per `<si>`, concatenating the runs of rich text; `<si/>` is an empty entry. */
function sharedStrings(xml: string): string[] {
  const strings: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    strings.push(match[1] === undefined ? '' : fragmentText(match[1]))
  }
  return strings
}

/** A formula shared by a range of cells: the master text and the position it was written at. */
interface SharedFormula {
  text: string
  row: number
  column: number
}

/** Find every shared-formula master before parsing cells, so a follower written above its master still resolves. */
function sharedFormulaMasters(xml: string): Map<string, SharedFormula> {
  const masters = new Map<string, SharedFormula>()
  if (!xml.includes('t="shared"')) return masters
  for (const cellMatch of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const body = cellMatch[2]
    if (!body) continue
    const position = cellPosition(xmlAttribute(cellMatch[1] ?? '', 'r') ?? '')
    if (!position) continue
    const formula = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body)
    if (!formula || formula[2] === undefined) continue
    const attributes = formula[1] ?? ''
    if (xmlAttribute(attributes, 't') !== 'shared') continue
    const id = xmlAttribute(attributes, 'si')
    const text = xmlText(formula[2]).replace(/^=/, '').trim()
    if (id && text) masters.set(id, { text, row: position.row, column: position.column })
  }
  return masters
}

/** A cell reference in a formula, with the absolute markers that decide whether it shifts. */
const FORMULA_REFERENCE = /(?<![A-Za-z0-9_.$])((?:'[^']*'|[A-Za-z_][\w.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)([0-9]{1,7})(?![A-Za-z0-9_]|\s*\()/g

/** One cell reference found in a formula, ready for shifting or position-normalizing. */
interface FormulaReference {
  sheet?: string
  absoluteColumn: boolean
  column: number
  absoluteRow: boolean
  row: number
}

/** Rewrite the cell references of a formula, leaving text inside quoted strings alone. */
function mapFormulaReferences(formula: string,
  map: (reference: FormulaReference, whole: string) => string | undefined): string {
  const literals: string[] = []
  const masked = formula.replace(/"(?:[^"]|"")*"/g, match => {
    literals.push(match)
    return `\u0000${literals.length - 1}\u0000`
  })
  const mapped = masked.replace(FORMULA_REFERENCE, (whole, sheet: string | undefined, absoluteColumn: string,
    letters: string, absoluteRow: string, digits: string) => {
    const column = columnIndex(letters)
    const row = Number(digits) - 1
    if (column < 0 || row < 0) return whole
    return map({
      ...(sheet === undefined ? {} : { sheet: sheet.slice(0, -1) }),
      absoluteColumn: Boolean(absoluteColumn),
      column,
      absoluteRow: Boolean(absoluteRow),
      row,
    }, whole) ?? whole
  })
  return mapped.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => literals[Number(index)] ?? '')
}

/**
 * Shift the relative references of a shared formula from its master cell to one of the cells that share it. Absolute
 * references (`$A$1`) stay put, and text inside a quoted string is not a reference.
 */
export function shiftFormula(formula: string, fromRow: number, fromColumn: number, toRow: number, toColumn: number): string {
  const rowDelta = toRow - fromRow
  const columnDelta = toColumn - fromColumn
  if (rowDelta === 0 && columnDelta === 0) return formula
  return mapFormulaReferences(formula, (reference, whole) => {
    const nextColumn = reference.absoluteColumn ? reference.column : reference.column + columnDelta
    const nextRow = reference.absoluteRow ? reference.row : reference.row + rowDelta
    if (nextColumn < 0 || nextRow < 0) return whole
    return `${reference.sheet === undefined ? '' : `${reference.sheet}!`}${reference.absoluteColumn ? '$' : ''}${columnLabel(nextColumn)}` +
      `${reference.absoluteRow ? '$' : ''}${nextRow + 1}`
  })
}

/**
 * A formula as the cell sees it: relative references become offsets from the cell, absolute references keep their
 * position. Moving a formula with its cell therefore keeps the same key, while editing a reference changes it.
 */
function formulaKey(cell: SheetCell): string {
  if (cell.formula === undefined) return ''
  return mapFormulaReferences(cell.formula, reference => {
    const column = reference.absoluteColumn ? `C${reference.column + 1}` : `C[${reference.column - cell.column}]`
    const row = reference.absoluteRow ? `R${reference.row + 1}` : `R[${reference.row - cell.row}]`
    return `${reference.sheet === undefined ? '' : `${reference.sheet}!`}${column}${row}`
  })
}

/** The formula of one cell, expanding a shared formula from its master. */
function cellFormula(body: string, row: number, column: number, shared: Map<string, SharedFormula>): string | undefined {
  const match = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body)
  if (!match) return undefined
  const attributes = match[1] ?? ''
  const text = match[2] === undefined ? '' : xmlText(match[2]).replace(/^=/, '').trim()
  const type = xmlAttribute(attributes, 't')
  const id = xmlAttribute(attributes, 'si')
  if (type === 'shared' && id !== undefined) {
    if (text) {
      shared.set(id, { text, row, column })
      return text
    }
    const master = shared.get(id)
    return master ? shiftFormula(master.text, master.row, master.column, row, column) : undefined
  }
  return text || undefined
}

/** The stored value of one cell: shared text, an inline string, a boolean, an error or a number. */
function cellValue(body: string, type: string | undefined, strings: readonly string[]): string {
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (type === 'inlineStr') return fragmentText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '')
  if (raw === undefined) return ''
  const value = xmlText(raw)
  if (type === 's') {
    if (!value.trim()) return ''
    const at = Number(value.trim())
    if (!Number.isInteger(at) || at < 0 || at >= strings.length) {
      throw new SheetParseError('invalidWorkbook', `shared string index ${value} is out of range`)
    }
    return strings[at]!
  }
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'
  return value
}

/** Parse one worksheet's cells, resolving shared strings, inline text and shared formulas. */
function parseWorksheet(name: string, xml: string, strings: readonly string[]): Sheet {
  const cells: SheetCell[] = []
  const shared = sharedFormulaMasters(xml)
  let lastRow = -1
  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowAttributes = rowMatch[1] ?? ''
    const declaredRow = Number(xmlAttribute(rowAttributes, 'r'))
    const row = Number.isInteger(declaredRow) && declaredRow > 0 ? declaredRow - 1 : lastRow + 1
    lastRow = row
    const rowBody = rowMatch[2]
    if (!rowBody) continue
    let lastColumn = -1
    for (const cellMatch of rowBody.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attributes = cellMatch[1] ?? ''
      const body = cellMatch[2] ?? ''
      const reference = xmlAttribute(attributes, 'r')
      const position = reference === undefined ? undefined : cellPosition(reference)
      if (reference !== undefined && !position) continue
      const column = position ? position.column : lastColumn + 1
      const cellRow = position ? position.row : row
      if (column < 0 || cellRow < 0) continue
      lastColumn = column
      const formula = cellFormula(body, cellRow, column, shared)
      const value = cellValue(body, xmlAttribute(attributes, 't'), strings)
      if (!formula && !value) continue
      cells.push(sheetCell(cellRow, column, value, formula))
    }
  }
  return shapeSheet(name, cells)
}

/**
 * Parse an .xlsx workbook into its sheets. The workbook's sheet list, shared strings, relationships and worksheet XML
 * are read; `sharedStrings` resolves text cells, `styles` and number formats are presentation and not compared, and a
 * chart sheet is skipped because it holds no cells.
 */
export function parseXlsx(bytes: Uint8Array): Sheet[] {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('The .xlsx content must be bytes')
  const workbook = zipEntry(bytes, WORKBOOK_ENTRY)
  if (!workbook) throw new SheetParseError('missingWorkbook')
  const sheets = workbookSheets(textDecoder.decode(workbook))
  if (!sheets.length) throw new SheetParseError('invalidWorkbook', 'the workbook has no sheets')
  const rels = zipEntry(bytes, WORKBOOK_RELS_ENTRY)
  const relationships = rels ? workbookRelationships(textDecoder.decode(rels)) : new Map<string, WorkbookRelationship>()
  const sharedTarget = [...relationships.values()].find(relationship => relationship.sharedStrings)?.target
  const shared = zipEntry(bytes, sharedTarget ? worksheetPath(sharedTarget) : SHARED_STRINGS_ENTRY)
  const strings = shared ? sharedStrings(textDecoder.decode(shared)) : []
  const parsed: Sheet[] = []
  for (const sheet of sheets) {
    let path = `xl/worksheets/sheet${sheet.fallback}.xml`
    if (sheet.relationship) {
      const relationship = relationships.get(sheet.relationship)
      if (!relationship) {
        // Without a relationships part at all, the sheet parts follow workbook order. With one, a missing
        // relationship is a malformed workbook, not an invitation to skip a sheet and hide its changes.
        if (rels) throw new SheetParseError('missingSheet', sheet.name)
      } else {
        if (!relationship.worksheet) continue
        path = worksheetPath(relationship.target)
      }
    }
    const xml = zipEntry(bytes, path)
    if (!xml) throw new SheetParseError('missingSheet', sheet.name)
    const worksheet = textDecoder.decode(xml)
    const isWorksheet = /<worksheet\b[^>]*>/.test(worksheet)
    const isClosed = /<\/worksheet>/.test(worksheet) || /<worksheet\b[^>]*\/>/.test(worksheet)
    if (!isWorksheet || !isClosed) throw new SheetParseError('invalidWorkbook', `the sheet ${sheet.name} is not a worksheet`)
    parsed.push(parseWorksheet(sheet.name, worksheet, strings))
  }
  if (!parsed.length) throw new SheetParseError('invalidWorkbook', 'the workbook has no worksheet')
  return parsed
}

/** One item in an alignment: a row or a column, its key and the tokens that make it up. */
interface AxisItem {
  index: number
  key: string
  tokens: readonly string[]
}

/** One step of an alignment: an aligned pair, or a row/column only one side has. */
type AxisOp =
  | { kind: 'same'; before: number; after: number }
  | { kind: 'delete'; before: number }
  | { kind: 'insert'; after: number }

/** Pair by position when an alignment is too large or too different to read exactly. */
function positionalPairs(before: number, after: number): AxisOp[] {
  const ops: AxisOp[] = []
  const shared = Math.min(before, after)
  for (let index = 0; index < shared; index++) ops.push({ kind: 'same', before: index, after: index })
  for (let index = shared; index < before; index++) ops.push({ kind: 'delete', before: index })
  for (let index = shared; index < after; index++) ops.push({ kind: 'insert', after: index })
  return ops
}

/** Backtrack a Myers path into aligned pairs and one-sided items. */
function backtrack(trace: readonly Int32Array[], depth: number, before: number, after: number): AxisOp[] {
  const ops: AxisOp[] = []
  let x = before
  let y = after
  for (let d = depth; d > 0; d--) {
    const snapshot = trace[d]!
    const k = x - y
    const at = (value: number): number => snapshot[value + d]!
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const previousX = at(previousK)
    const previousY = previousX - previousK
    while (x > previousX && y > previousY) { ops.push({ kind: 'same', before: x - 1, after: y - 1 }); x--; y-- }
    if (x === previousX) { ops.push({ kind: 'insert', after: y - 1 }); y-- }
    else { ops.push({ kind: 'delete', before: x - 1 }); x-- }
  }
  while (x > 0 && y > 0) { ops.push({ kind: 'same', before: x - 1, after: y - 1 }); x--; y-- }
  while (x > 0) { ops.push({ kind: 'delete', before: x - 1 }); x-- }
  while (y > 0) { ops.push({ kind: 'insert', after: y - 1 }); y-- }
  ops.reverse()
  return ops
}

/** One exact key that occurs once on each side and is kept as an alignment anchor. */
interface KeyAnchor {
  before: number
  after: number
}

/** The longest ordered run of keys that occur exactly once on each side (patience anchors). */
function uniqueAnchors(beforeKeys: readonly string[], afterKeys: readonly string[]): KeyAnchor[] {
  if (!beforeKeys.length || !afterKeys.length) return []
  const beforeCounts = new Map<string, number>()
  for (const key of beforeKeys) beforeCounts.set(key, (beforeCounts.get(key) ?? 0) + 1)
  const afterCounts = new Map<string, number>()
  for (const key of afterKeys) afterCounts.set(key, (afterCounts.get(key) ?? 0) + 1)
  const afterAt = new Map<string, number>()
  for (let index = 0; index < afterKeys.length; index++) {
    const key = afterKeys[index]!
    if (afterCounts.get(key) === 1) afterAt.set(key, index)
  }
  const candidates: KeyAnchor[] = []
  for (let index = 0; index < beforeKeys.length; index++) {
    const key = beforeKeys[index]!
    if (beforeCounts.get(key) !== 1) continue
    const after = afterAt.get(key)
    if (after !== undefined) candidates.push({ before: index, after })
  }
  if (!candidates.length) return []
  const tails: number[] = []
  const previous = new Int32Array(candidates.length).fill(-1)
  for (let index = 0; index < candidates.length; index++) {
    const value = candidates[index]!.after
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (candidates[tails[middle]!]!.after < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1]!
    tails[low] = index
  }
  const anchors: KeyAnchor[] = []
  let cursor = tails[tails.length - 1]!
  while (cursor >= 0) {
    anchors.push(candidates[cursor]!)
    cursor = previous[cursor]!
  }
  anchors.reverse()
  return anchors
}

/** Offset an alignment operation from a sliced gap back to the full key lists. */
function offsetOp(op: AxisOp, before: number, after: number): AxisOp {
  if (op.kind === 'same') return { kind: 'same', before: op.before + before, after: op.after + after }
  if (op.kind === 'delete') return { kind: 'delete', before: op.before + before }
  return { kind: 'insert', after: op.after + after }
}

/** Align one gap between anchors, using Myers when it is bounded and position when it is not. */
function alignSegment(beforeKeys: readonly string[], afterKeys: readonly string[],
  beforeStart: number, beforeEnd: number, afterStart: number, afterEnd: number): AxisOp[] {
  const beforeLength = beforeEnd - beforeStart
  const afterLength = afterEnd - afterStart
  if (!beforeLength) {
    return Array.from({ length: afterLength }, (_value, index) => ({ kind: 'insert' as const, after: afterStart + index }))
  }
  if (!afterLength) {
    return Array.from({ length: beforeLength }, (_value, index) => ({ kind: 'delete' as const, before: beforeStart + index }))
  }
  const segment = myersAlign(beforeKeys.slice(beforeStart, beforeEnd), afterKeys.slice(afterStart, afterEnd))
  return segment
    ? segment.map(op => offsetOp(op, beforeStart, afterStart))
    : positionalPairs(beforeLength, afterLength).map(op => offsetOp(op, beforeStart, afterStart))
}

/** Keep the patience anchors and align every gap between them. */
function alignAnchored(beforeKeys: readonly string[], afterKeys: readonly string[], anchors: readonly KeyAnchor[]): AxisOp[] {
  const ops: AxisOp[] = []
  let beforeStart = 0
  let afterStart = 0
  for (const anchor of anchors) {
    ops.push(...alignSegment(beforeKeys, afterKeys, beforeStart, anchor.before, afterStart, anchor.after))
    ops.push({ kind: 'same', before: anchor.before, after: anchor.after })
    beforeStart = anchor.before + 1
    afterStart = anchor.after + 1
  }
  ops.push(...alignSegment(beforeKeys, afterKeys, beforeStart, beforeKeys.length, afterStart, afterKeys.length))
  return ops
}

/** Myers' shortest edit script over a gap with no patience anchors; undefined when the work budget is exhausted. */
function myersAlign(beforeKeys: readonly string[], afterKeys: readonly string[]): AxisOp[] | undefined {
  const before = beforeKeys.length
  const after = afterKeys.length
  if (!before && !after) return []
  if (!before) return afterKeys.map((_key, index) => ({ kind: 'insert', after: index }))
  if (!after) return beforeKeys.map((_key, index) => ({ kind: 'delete', before: index }))
  const max = before + after
  const offset = max
  const furthest = new Int32Array(2 * max + 1)
  const trace: Int32Array[] = []
  let work = 0
  for (let distance = 0; distance <= max; distance++) {
    const snapshot = new Int32Array(2 * distance + 1)
    for (let diagonal = -distance; diagonal <= distance; diagonal++) snapshot[diagonal + distance] = furthest[offset + diagonal]!
    trace.push(snapshot)
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      work++
      if (work > MAX_ALIGN_WORK) return undefined
      let x: number
      if (diagonal === -distance || (diagonal !== distance && furthest[offset + diagonal - 1]! < furthest[offset + diagonal + 1]!)) {
        x = furthest[offset + diagonal + 1]!
      } else x = furthest[offset + diagonal - 1]! + 1
      let y = x - diagonal
      while (x < before && y < after && beforeKeys[x] === afterKeys[y]) { x++; y++; work++ }
      furthest[offset + diagonal] = x
      if (x >= before && y >= after) return backtrack(trace, distance, before, after)
    }
  }
  return undefined
}

/**
 * Align two key lists with unique exact keys as patience anchors, then Myers inside each gap. The anchors keep a heavily
 * edited table from exhausting the whole-table work budget and falling back to position for every later row.
 */
function alignKeys(beforeKeys: readonly string[], afterKeys: readonly string[]): AxisOp[] | undefined {
  if (!beforeKeys.length && !afterKeys.length) return []
  if (!beforeKeys.length) return afterKeys.map((_key, index) => ({ kind: 'insert', after: index }))
  if (!afterKeys.length) return beforeKeys.map((_key, index) => ({ kind: 'delete', before: index }))
  const anchors = uniqueAnchors(beforeKeys, afterKeys)
  return anchors.length ? alignAnchored(beforeKeys, afterKeys, anchors) : myersAlign(beforeKeys, afterKeys)
}
/** Dice similarity over the tokens of two columns, which keeps a moved row insertion from breaking the columns. */
function columnSimilarity(before: AxisItem, after: AxisItem): number {
  if (before.key === after.key) return 1
  const counts = new Map<string, number>()
  for (const token of before.tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  let common = 0
  for (const token of after.tokens) {
    const count = counts.get(token)
    if (count) { common++; counts.set(token, count - 1) }
  }
  const total = before.tokens.length + after.tokens.length
  return total ? (2 * common) / total : 0
}

/** Positional similarity of two rows, whose tokens are already aligned by column. */
function rowSimilarity(before: AxisItem, after: AxisItem): number {
  if (before.key === after.key) return 1
  const total = Math.max(before.tokens.length, after.tokens.length)
  if (!total) return 0
  let common = 0
  for (let index = 0; index < Math.min(before.tokens.length, after.tokens.length); index++) {
    if (before.tokens[index] === after.tokens[index]) common++
  }
  return common / total
}

/** Dice similarity over character bigrams, enough to read an edited line as one changed line in the fallback. */
function lineSimilarity(before: AxisItem, after: AxisItem): number {
  if (before.key === after.key) return 1
  const left = Array.from(before.tokens[0] ?? '')
  const right = Array.from(after.tokens[0] ?? '')
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

/** The similarity one alignment kind uses for an unmatched run. */
function pairSimilarity(kind: 'row' | 'column' | 'line', before: AxisItem, after: AxisItem): number {
  if (kind === 'column') return columnSimilarity(before, after)
  if (kind === 'line') return lineSimilarity(before, after)
  return rowSimilarity(before, after)
}

/** Pair a run of removals and insertions by likeness, then by position, so a changed row is not two one-sided rows. */
function pairRun(run: readonly AxisOp[], before: readonly AxisItem[], after: readonly AxisItem[],
  kind: 'row' | 'column' | 'line'): AxisOp[] {
  const deletes = run.filter((op): op is Extract<AxisOp, { kind: 'delete' }> => op.kind === 'delete').map(op => op.before)
  const inserts = run.filter((op): op is Extract<AxisOp, { kind: 'insert' }> => op.kind === 'insert').map(op => op.after)
  // An equal number of unmatched columns with no exact anchor is read by position: scoring every column pair would
  // rebuild a row-token map per pair, which is O(columns^2 * rows) on a wide table.
  if (kind === 'column' && deletes.length === inserts.length) {
    return deletes.map((removed, index) => ({ kind: 'same' as const, before: removed, after: inserts[index]! }))
  }
  const pairs: { before: number; after: number; score: number }[] = []
  const pairWork = kind === 'column' ? MAX_COLUMN_PAIR_WORK : MAX_PAIR_CELLS
  if (deletes.length * inserts.length <= pairWork) {
    const threshold = kind === 'row' ? ROW_SIMILARITY : COLUMN_SIMILARITY
    for (const removed of deletes) {
      for (const added of inserts) {
        const score = pairSimilarity(kind, before[removed]!, after[added]!)
        if (score >= threshold) pairs.push({ before: removed, after: added, score })
      }
    }
  }
  pairs.sort((left, right) => right.score - left.score
    || Math.abs(left.before - left.after) - Math.abs(right.before - right.after)
    || left.before - right.before || left.after - right.after)
  const usedBefore = new Set<number>()
  const usedAfter = new Set<number>()
  const result: AxisOp[] = []
  for (const pair of pairs) {
    if (usedBefore.has(pair.before) || usedAfter.has(pair.after)) continue
    usedBefore.add(pair.before)
    usedAfter.add(pair.after)
    result.push({ kind: 'same', before: pair.before, after: pair.after })
  }
  // A run with no likeness left is still better read as changed rows than as a removal followed by an insertion.
  const remainingBefore = deletes.filter(index => !usedBefore.has(index))
  const remainingAfter = inserts.filter(index => !usedAfter.has(index))
  const shared = Math.min(remainingBefore.length, remainingAfter.length)
  for (let index = 0; index < shared; index++) result.push({ kind: 'same', before: remainingBefore[index]!, after: remainingAfter[index]! })
  for (let index = shared; index < remainingBefore.length; index++) result.push({ kind: 'delete', before: remainingBefore[index]! })
  for (let index = shared; index < remainingAfter.length; index++) result.push({ kind: 'insert', after: remainingAfter[index]! })
  return result
}

/** Align rows or columns, pairing an unmatched run by likeness before it is reported as one-sided. */
function alignAxis(before: readonly AxisItem[], after: readonly AxisItem[], kind: 'row' | 'column' | 'line'): AxisOp[] {
  const exact = alignKeys(before.map(item => item.key), after.map(item => item.key))
  if (!exact) return positionalPairs(before.length, after.length)
  const ops: AxisOp[] = []
  for (let index = 0; index < exact.length;) {
    const op = exact[index]!
    if (op.kind === 'same') { ops.push(op); index++; continue }
    const run: AxisOp[] = []
    while (index < exact.length && exact[index]!.kind !== 'same') { run.push(exact[index]!); index++ }
    ops.push(...pairRun(run, before, after, kind))
  }
  return ops
}

/** The columns that have at least one cell, with the tokens that identify each column's content. */
function columnItems(sheet: Sheet): AxisItem[] {
  const columns = new Map<number, string[]>()
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const tokens = columns.get(cell.column)
      if (tokens) tokens.push(cellToken(cell))
      else columns.set(cell.column, [cellToken(cell)])
    }
  }
  return [...columns.entries()].sort((left, right) => left[0] - right[0]).map(([index, tokens]) => ({
    index, tokens, key: tokens.join('\u0001'),
  }))
}

/** The rows that have at least one cell, with tokens for the columns both sides share. */
function rowItems(sheet: Sheet, columns: readonly { before: number; after: number }[], side: 'before' | 'after'): AxisItem[] {
  const used = columns.map(column => side === 'before' ? column.before : column.after)
  const usedSet = new Set(used)
  return sheet.rows.map(row => {
    const byColumn = new Map(row.cells.map(cell => [cell.column, cell]))
    let tokens = used.map(column => {
      const cell = byColumn.get(column)
      return cell ? cellToken(cell) : ''
    })
    if (tokens.every(token => token === '')) {
      // A row whose only cells are in columns one side lacks still has content; keep it distinct from an empty row.
      const other = row.cells.filter(cell => !usedSet.has(cell.column)).map(cellToken)
      if (other.length) tokens = ['\u0002' + other.join('\u0001')]
    }
    return { index: row.index, tokens, key: tokens.join('\u0001') }
  })
}

/** A column that only one side has, with its cell count. */
function columnRef(sheet: Sheet, index: number): SheetColumn {
  let cells = 0
  for (const row of sheet.rows) for (const cell of row.cells) if (cell.column === index) cells++
  return { index, label: columnLabel(index), cells }
}



/** Look a cell up by its zero-based position. */
function cellLookup(sheet: Sheet): Map<number, Map<number, SheetCell>> {
  const lookup = new Map<number, Map<number, SheetCell>>()
  for (const row of sheet.rows) {
    const line = new Map<number, SheetCell>()
    for (const cell of row.cells) line.set(cell.column, cell)
    lookup.set(row.index, line)
  }
  return lookup
}

/**
 * Compare one cell. A formula change is the formula difference and is never also a value change, even when the cached
 * result moved with it; a value change is a different stored value under the same formula, or two plain values. A
 * removed cell is reported where it used to be, and an added cell where it now is.
 */
function cellChange(sheet: string, beforeRow: number, beforeColumn: number, afterRow: number, afterColumn: number,
  before: SheetCell | undefined, after: SheetCell | undefined): SheetCellChange | undefined {
  if (!before && !after) return undefined
  if (!before) return { sheet, kind: 'added', row: afterRow, column: afterColumn, address: cellAddress(afterRow, afterColumn), after }
  if (!after) return { sheet, kind: 'removed', row: beforeRow, column: beforeColumn, address: cellAddress(beforeRow, beforeColumn), before }
  let kind: SheetCellChange['kind']
  if (formulaKey(before) !== formulaKey(after)) kind = 'formula'
  else if (storedValue(before) !== storedValue(after)) kind = 'value'
  else return undefined
  return { sheet, kind, row: afterRow, column: afterColumn, address: cellAddress(afterRow, afterColumn), before, after }
}

/** The empty counts a fallback and an unchanged sheet share. */
function emptySummary(): SheetSummary {
  return {
    sheets: { before: 0, after: 0, added: 0, removed: 0, changed: 0 },
    rows: { before: 0, after: 0, added: 0, removed: 0 },
    columns: { before: 0, after: 0, added: 0, removed: 0 },
    cells: { added: 0, removed: 0, formula: 0, value: 0 },
  }
}

/** Compare one sheet both revisions have. */
function diffSheet(before: Sheet, after: Sheet): { diff: SheetDiff; changes: SheetCellChange[] } {
  const beforeColumns = columnItems(before)
  const afterColumns = columnItems(after)
  const columnOps = alignAxis(beforeColumns, afterColumns, 'column')
  const columns: { before: number; after: number }[] = []
  const addedColumns: SheetColumn[] = []
  const removedColumns: SheetColumn[] = []
  for (const op of columnOps) {
    if (op.kind === 'same') columns.push({ before: beforeColumns[op.before]!.index, after: afterColumns[op.after]!.index })
    else if (op.kind === 'delete') removedColumns.push(columnRef(before, beforeColumns[op.before]!.index))
    else addedColumns.push(columnRef(after, afterColumns[op.after]!.index))
  }
  columns.sort((left, right) => left.after - right.after)
  addedColumns.sort((left, right) => left.index - right.index)
  removedColumns.sort((left, right) => left.index - right.index)

  const rowOps = alignAxis(rowItems(before, columns, 'before'), rowItems(after, columns, 'after'), 'row')
  const rows: { before: number; after: number }[] = []
  const addedRows: SheetRowRef[] = []
  const removedRows: SheetRowRef[] = []
  for (const op of rowOps) {
    if (op.kind === 'same') {
      rows.push({ before: before.rows[op.before]!.index, after: after.rows[op.after]!.index })
    } else if (op.kind === 'delete') {
      const row = before.rows[op.before]!
      removedRows.push({ index: row.index, cells: row.cells.length })
    } else {
      const row = after.rows[op.after]!
      addedRows.push({ index: row.index, cells: row.cells.length })
    }
  }
  rows.sort((left, right) => left.after - right.after)
  addedRows.sort((left, right) => left.index - right.index)
  removedRows.sort((left, right) => left.index - right.index)

  const beforeCells = cellLookup(before)
  const afterCells = cellLookup(after)
  const changes: SheetCellChange[] = []
  for (const row of rows) {
    for (const column of columns) {
      const change = cellChange(before.name, row.before, column.before, row.after, column.after,
        beforeCells.get(row.before)?.get(column.before), afterCells.get(row.after)?.get(column.after))
      if (change) changes.push(change)
    }
  }
  changes.sort((left, right) => left.row - right.row || left.column - right.column)

  const summary = {
    rows: { added: addedRows.length, removed: removedRows.length },
    columns: { added: addedColumns.length, removed: removedColumns.length },
    cells: {
      added: changes.filter(change => change.kind === 'added').length,
      removed: changes.filter(change => change.kind === 'removed').length,
      formula: changes.filter(change => change.kind === 'formula').length,
      value: changes.filter(change => change.kind === 'value').length,
    },
  }
  return {
    diff: {
      name: after.name,
      status: (summary.rows.added || summary.rows.removed || summary.columns.added || summary.columns.removed
        || changes.length) ? 'changed' : 'unchanged',
      rows: { before: before.rowCount, after: after.rowCount, added: addedRows, removed: removedRows },
      columns: { before: before.columnCount, after: after.columnCount, added: addedColumns, removed: removedColumns },
      summary,
    },
    changes,
  }
}

/** Add one sheet's counts to the preview summary. */
function addSheetSummary(summary: SheetSummary, before: Sheet, after: Sheet, diff: SheetDiff): void {
  summary.rows.before += before.rowCount
  summary.rows.after += after.rowCount
  summary.rows.added += diff.summary.rows.added
  summary.rows.removed += diff.summary.rows.removed
  summary.columns.before += before.columnCount
  summary.columns.after += after.columnCount
  summary.columns.added += diff.summary.columns.added
  summary.columns.removed += diff.summary.columns.removed
  summary.cells.added += diff.summary.cells.added
  summary.cells.removed += diff.summary.cells.removed
  summary.cells.formula += diff.summary.cells.formula
  summary.cells.value += diff.summary.cells.value
  if (diff.status === 'changed') summary.sheets.changed++
}

/** Compare every sheet both revisions have, and list the whole sheets only one side has. */
function compareSheets(before: readonly Sheet[], after: readonly Sheet[]): {
  sheets: SheetDiff[]
  addedSheets: SheetInfo[]
  removedSheets: SheetInfo[]
  changes: SheetCellChange[]
  summary: SheetSummary
} {
  const beforeByName = new Map(before.map(sheet => [sheet.name, sheet]))
  const afterByName = new Map(after.map(sheet => [sheet.name, sheet]))
  const summary = emptySummary()
  summary.sheets.before = before.length
  summary.sheets.after = after.length
  const sheets: SheetDiff[] = []
  const changes: SheetCellChange[] = []
  for (const sheet of before) {
    const other = afterByName.get(sheet.name)
    if (!other) continue
    const compared = diffSheet(sheet, other)
    sheets.push(compared.diff)
    changes.push(...compared.changes)
    addSheetSummary(summary, sheet, other, compared.diff)
  }
  const addedSheets = after.filter(sheet => !beforeByName.has(sheet.name))
    .map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount }))
  const removedSheets = before.filter(sheet => !afterByName.has(sheet.name))
    .map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount }))
  summary.sheets.added = addedSheets.length
  summary.sheets.removed = removedSheets.length
  return { sheets, addedSheets, removedSheets, changes, summary }
}

/** The best plain text of a side when its workbook cannot be parsed. */
function fallbackText(side: SheetSource): string {
  if (side.text !== undefined) return side.text
  if (typeof side.content === 'string') return side.content
  return textDecoder.decode(side.content).replace(/[^\t\n\r\x20-\x7e\u00a0-\uffff]/g, ' ')
}

/** The non-empty lines a fallback text diff compares, keeping the editor's one-based line number; blank lines and
 * trailing whitespace are ignored. */
function fallbackLines(side: SheetSource): SheetLine[] {
  return fallbackText(side).replace(/\r\n?/g, '\n').split('\n')
    .map((text, index) => ({ line: index + 1, text: text.replace(/\s+$/, '') }))
    .filter(line => line.text.trim())
}

/** A line diff for the D4 fallback: changed lines are paired by position, extras become added or removed. */
function diffLines(before: readonly SheetLine[], after: readonly SheetLine[]): SheetLineChange[] {
  const beforeItems: AxisItem[] = before.map((line, index) => ({ index, tokens: [line.text], key: line.text }))
  const afterItems: AxisItem[] = after.map((line, index) => ({ index, tokens: [line.text], key: line.text }))
  const changes: SheetLineChange[] = []
  for (const op of alignAxis(beforeItems, afterItems, 'line')) {
    if (op.kind === 'delete') {
      changes.push({ kind: 'removed', before: before[op.before]! })
      continue
    }
    if (op.kind === 'insert') {
      changes.push({ kind: 'added', after: after[op.after]! })
      continue
    }
    const previous = before[op.before]!
    const next = after[op.after]!
    if (previous.text !== next.text) changes.push({ kind: 'changed', before: previous, after: next })
  }
  changes.sort((left, right) => (left.after?.line ?? left.before?.line ?? 0) - (right.after?.line ?? right.before?.line ?? 0)
    || (left.before?.line ?? 0) - (right.before?.line ?? 0))
  return changes
}

/** A readable side's non-empty cells as fallback lines, so a ZIP is never diffed as text when it can be parsed. */
function fallbackSheetLines(sheets: readonly Sheet[]): SheetLine[] {
  const lines: SheetLine[] = []
  for (const sheet of sheets) {
    if (sheets.length > 1) lines.push({ line: lines.length + 1, text: `# ${sheet.name}` })
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        const text = cell.formula === undefined ? cell.value : `=${cell.formula}`
        if (text) lines.push({ line: lines.length + 1, text: `${cell.address}\t${text}` })
      }
    }
  }
  return lines
}

/** The fallback lines of one side: parsed cells when it reads, the best text otherwise. */
function readableLines(source: SheetSource): SheetLine[] {
  try { return fallbackSheetLines(parseSide(source)) } catch (error) {
    if (error instanceof SheetParseError) return fallbackLines(source)
    throw error
  }
}

/** The D4 fallback: a line diff of both sides' best text, the original link and the coded parse failure. */
function degradedPreview(before: SheetSource, after: SheetSource, link: string, side: 'before' | 'after',
  error: SheetParseError): SheetPreview {
  // The side that parsed contributes its cells, not the ZIP bytes it happens to arrive as.
  const beforeLines = side === 'before' ? fallbackLines(before) : readableLines(before)
  const afterLines = side === 'after' ? fallbackLines(after) : readableLines(after)
  return {
    kind: 'text/diff',
    format: before.format,
    unit: 'line',
    link,
    sheets: [],
    addedSheets: [],
    removedSheets: [],
    changes: [],
    lines: diffLines(beforeLines, afterLines),
    summary: emptySummary(),
    degraded: { code: error.code, message: error.message, side },
  }
}

/** Parse one side, naming a workbook handed over as text as unreadable rather than throwing a caller error. */
function parseSide(side: SheetSource): Sheet[] {
  if (side.format === 'csv') return [parseCsv(typeof side.content === 'string' ? side.content : textDecoder.decode(side.content))]
  if (typeof side.content !== 'string') return parseXlsx(side.content)
  throw new SheetParseError('notZip', 'the workbook was given as text')
}

/** Validate one side without turning a parse failure into a caller error. */
function sheetSource(value: unknown, what: string): SheetSource {
  if (!value || typeof value !== 'object') throw new TypeError(`${what} must name a spreadsheet`)
  const source = value as Partial<SheetSource>
  if (source.format !== 'csv' && source.format !== 'xlsx') throw new TypeError(`${what} must be csv or xlsx`)
  if (typeof source.content !== 'string' && !(source.content instanceof Uint8Array)) {
    throw new TypeError(`${what} content must be text or bytes`)
  }
  if (source.text !== undefined && typeof source.text !== 'string') throw new TypeError(`${what} text must be a string`)
  return { format: source.format, content: source.content, ...(source.text === undefined ? {} : { text: source.text }) }
}

/**
 * Preview one spreadsheet revision against another. CSV and .xlsx workbooks are read as sparse cells and compared by
 * row and column: a formula change is reported as `formula` even when its cached value moved, a value under the same
 * formula is `value`, and rows or columns only one side has are listed instead of being spread across their cells.
 * When either side cannot be parsed, the preview degrades to `text/diff`, a line diff of the best available text,
 * states the parse code and side and keeps the original link (D4).
 */
export function previewSheet(input: SheetPreviewInput): SheetPreview {
  if (!input || typeof input !== 'object') throw new TypeError('A sheet preview needs two spreadsheets and a link')
  const before = sheetSource(input.before, 'The before spreadsheet')
  const after = sheetSource(input.after, 'The after spreadsheet')
  if (before.format !== after.format) throw new TypeError('Both spreadsheets must have the same format')
  if (typeof input.link !== 'string' || !input.link.trim()) throw new TypeError('The original link must be a non-empty string')
  let beforeSheets: Sheet[]
  let afterSheets: Sheet[]
  try { beforeSheets = parseSide(before) } catch (error) {
    if (!(error instanceof SheetParseError)) throw error
    return degradedPreview(before, after, input.link, 'before', error)
  }
  try { afterSheets = parseSide(after) } catch (error) {
    if (!(error instanceof SheetParseError)) throw error
    return degradedPreview(before, after, input.link, 'after', error)
  }
  const compared = compareSheets(beforeSheets, afterSheets)
  return {
    kind: 'sheet/cell-diff',
    format: before.format,
    unit: 'cell',
    link: input.link,
    ...compared,
  }
}