import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SheetParseError, cellAddress, columnIndex, columnLabel, parseCsv, parseXlsx, previewSheet, shiftFormula,
  type SheetCellChange } from '@superagent/dsh/app/preview/sheet.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'sheet-preview')
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)))
const link = 'https://example.test/sheets/ledger'
/** A change reduced to what a reviewer sees: the sheet, the category, the address and both cell states. */
const shape = (changes: readonly SheetCellChange[]) => changes.map(change => [change.sheet, change.kind, change.address,
  change.before?.formula ?? null, change.after?.formula ?? null, change.before?.value ?? null, change.after?.value ?? null])

describe('the sheet previewer', () => {
  it('names A1 addresses and column letters', () => {
    expect([columnLabel(0), columnLabel(25), columnLabel(26), columnLabel(701), columnLabel(702)])
      .toEqual(['A', 'Z', 'AA', 'ZZ', 'AAA'])
    expect([columnIndex('A'), columnIndex('Z'), columnIndex('AA'), columnIndex('XFD')]).toEqual([0, 25, 26, 16383])
    expect([columnIndex('A1'), columnIndex(''), columnIndex('_A')]).toEqual([-1, -1, -1])
    expect([cellAddress(0, 0), cellAddress(9, 27)]).toEqual(['A1', 'AB10'])
    expect(() => columnLabel(-1)).toThrow(TypeError)
    expect(() => columnIndex('')).not.toThrow()
    expect(() => cellAddress(0, -1)).toThrow(TypeError)
  })

  it('reads CSV quotes, commas, newlines and formulas as cells', () => {
    const sheet = parseCsv('\ufeffa,"b,c","d""e"\r\n1,2,\r\n=SUM(A1:A2),,\n')
    expect(sheet.name).toBe('Sheet1')
    expect([sheet.rowCount, sheet.columnCount]).toEqual([3, 3])
    expect(sheet.rows.map(row => row.cells.map(cell => [cell.address, cell.value, cell.formula ?? null]))).toEqual([
      [['A1', 'a', null], ['B1', 'b,c', null], ['C1', 'd"e', null]],
      [['A2', '1', null], ['B2', '2', null]],
      [['A3', '=SUM(A1:A2)', 'SUM(A1:A2)']],
    ])
    // A value that only looks like a formula is not one; a quoted field can hold a newline.
    expect(parseCsv('"a\nb",=\n').rows[0]!.cells.map(cell => [cell.address, cell.value, cell.formula ?? null]))
      .toEqual([['A1', 'a\nb', null], ['B1', '=', null]])
  })

  it('compares the CSV fixture by row and column, keeping added, removed, formula and value changes apart', () => {
    const preview = previewSheet({ before: { format: 'csv', content: read('ledger-before.csv') },
      after: { format: 'csv', content: read('ledger-after.csv') }, link })
    expect([preview.kind, preview.format, preview.unit, preview.link, preview.degraded]).toEqual(['sheet/cell-diff', 'csv', 'cell', link, undefined])
    expect(preview.addedSheets).toEqual([])
    expect(preview.removedSheets).toEqual([])
    expect(preview.sheets).toHaveLength(1)
    expect(preview.sheets[0]).toMatchObject({ name: 'Sheet1', status: 'changed',
      rows: { before: 4, after: 5, added: [{ index: 4, cells: 4 }], removed: [] },
      columns: { before: 4, after: 4, added: [], removed: [] },
      summary: { rows: { added: 1, removed: 0 }, columns: { added: 0, removed: 0 },
        cells: { added: 1, removed: 1, formula: 1, value: 1 } } })
    expect(shape(preview.changes)).toEqual([
      ['Sheet1', 'value', 'B2', null, null, '10', '11'],
      ['Sheet1', 'formula', 'D2', 'B2+C2', 'C2+B2', '=B2+C2', '=C2+B2'],
      ['Sheet1', 'added', 'C3', null, null, null, '9'],
      ['Sheet1', 'removed', 'B4', null, null, '4', null],
    ])
    expect(preview.summary).toEqual({
      sheets: { before: 1, after: 1, added: 0, removed: 0, changed: 1 },
      rows: { before: 4, after: 5, added: 1, removed: 0 },
      columns: { before: 4, after: 4, added: 0, removed: 0 },
      cells: { added: 1, removed: 1, formula: 1, value: 1 },
    })
  })

  it('reads a real .xlsx workbook, separates formulas from values, and keeps whole sheets apart', () => {
    const parsed = parseXlsx(bytes('ledger-before.xlsx'))
    expect(parsed.map(sheet => [sheet.name, sheet.rowCount, sheet.columnCount]))
      .toEqual([['Summary', 4, 5], ['Notes', 2, 1]])
    expect(parsed[0]!.rows[1]!.cells.map(cell => [cell.address, cell.value, cell.formula ?? null])).toEqual([
      ['A2', 'Widgit', null], ['B2', '10', null], ['C2', '2.5', null], ['D2', '25', 'B2*C2'], ['E2', 'ok', null],
    ])
    // A shared formula is expanded from its master, with the relative reference shifted for each follower.
    expect(parsed[0]!.rows.slice(1).map(row => row.cells.find(cell => cell.column === 3)!.formula))
      .toEqual(['B2*C2', 'B3*C3', 'B4*C4'])

    const preview = previewSheet({ before: { format: 'xlsx', content: bytes('ledger-before.xlsx') },
      after: { format: 'xlsx', content: bytes('ledger-after.xlsx') }, link })
    expect([preview.kind, preview.format, preview.unit, preview.link, preview.degraded]).toEqual(['sheet/cell-diff', 'xlsx', 'cell', link, undefined])
    expect(preview.addedSheets).toEqual([{ name: 'Archive', rows: 2, columns: 1 }])
    expect(preview.removedSheets).toEqual([{ name: 'Notes', rows: 2, columns: 1 }])
    expect(preview.sheets).toHaveLength(1)
    expect(preview.sheets[0]).toMatchObject({ name: 'Summary', status: 'changed',
      rows: { before: 4, after: 5, added: [{ index: 4, cells: 4 }], removed: [] },
      columns: { before: 5, after: 4, added: [], removed: [{ index: 4, label: 'E', cells: 4 }] },
      summary: { rows: { added: 1, removed: 0 }, columns: { added: 0, removed: 1 },
        cells: { added: 0, removed: 0, formula: 2, value: 2 } } })
    // D2 changes formula but keeps its cached value; D5 changes formula and value and is still a formula change,
    // while D4 keeps its formula and changes only its cached value.
    expect(shape(preview.changes)).toEqual([
      ['Summary', 'value', 'B2', null, null, '10', '11'],
      ['Summary', 'formula', 'D2', 'B2*C2', 'C2*B2', '25', '25'],
      ['Summary', 'value', 'D3', 'B3*C3', 'B3*C3', '21', '24'],
      ['Summary', 'formula', 'D4', 'B4*C4', 'B4*C4+1', '20', '21'],
    ])
    expect(preview.summary).toEqual({
      sheets: { before: 2, after: 2, added: 1, removed: 1, changed: 1 },
      rows: { before: 4, after: 5, added: 1, removed: 0 },
      columns: { before: 5, after: 4, added: 0, removed: 1 },
      cells: { added: 0, removed: 0, formula: 2, value: 2 },
    })
  })

  it('aligns a row inserted in the middle instead of rewriting every later row', () => {
    const preview = previewSheet({
      before: { format: 'csv', content: 'id,region,amount\n1,north,10\n2,south,20\n3,east,30\n4,west,40\n' },
      after: { format: 'csv', content: 'id,region,amount\n1,north,10\n2,south,20\n9,central,90\n3,east,30\n4,west,40\n' },
      link,
    })
    expect(preview.changes).toEqual([])
    expect(preview.sheets[0]!.rows).toEqual({ before: 5, after: 6, added: [{ index: 3, cells: 3 }], removed: [] })
    expect(preview.sheets[0]!.columns).toEqual({ before: 3, after: 3, added: [], removed: [] })
    expect(preview.summary.rows).toEqual({ before: 5, after: 6, added: 1, removed: 0 })
  })

  it('aligns a row removed in the middle instead of rewriting every later row', () => {
    const preview = previewSheet({
      before: { format: 'csv', content: 'id,amount\n1,10\n2,20\n3,30\n' },
      after: { format: 'csv', content: 'id,amount\n1,10\n3,30\n' },
      link,
    })
    expect(preview.changes).toEqual([])
    expect(preview.sheets[0]!.rows).toEqual({ before: 4, after: 3, added: [], removed: [{ index: 2, cells: 2 }] })
    expect(preview.summary.rows).toEqual({ before: 4, after: 3, added: 0, removed: 1 })
  })

  it('reports an unchanged table as unchanged with no structure or cell changes', () => {
    const csv = 'id,amount\n1,10\n2,20\n'
    const preview = previewSheet({ before: { format: 'csv', content: csv }, after: { format: 'csv', content: csv }, link })
    expect(preview.sheets[0]!.status).toBe('unchanged')
    expect(preview.changes).toEqual([])
    expect(preview.summary).toEqual({
      sheets: { before: 1, after: 1, added: 0, removed: 0, changed: 0 },
      rows: { before: 3, after: 3, added: 0, removed: 0 },
      columns: { before: 2, after: 2, added: 0, removed: 0 },
      cells: { added: 0, removed: 0, formula: 0, value: 0 },
    })
  })

  it('keeps a shifted formula from reading as a formula change when a row is inserted', () => {
    const preview = previewSheet({
      before: { format: 'csv', content: 'id,amount,total\n1,10,=B2*2\n2,20,=B3*2\n3,30,=B4*2\n' },
      after: { format: 'csv', content: 'id,amount,total\n1,10,=B2*2\n9,90,=B3*2\n2,20,=B4*2\n3,30,=B5*2\n' },
      link,
    })
    expect(preview.changes).toEqual([])
    expect(preview.sheets[0]!.rows).toEqual({ before: 4, after: 5, added: [{ index: 2, cells: 3 }], removed: [] })
    expect(preview.sheets[0]!.summary.cells).toEqual({ added: 0, removed: 0, formula: 0, value: 0 })
  })

  it('matches columns through a row inserted at the top and a column inserted in the middle', () => {
    const preview = previewSheet({
      before: { format: 'csv', content: 'a,b\n1,10\n2,20\n' },
      after: { format: 'csv', content: 'a,x,b\n0,zero,0\n1,one,10\n2,two,20\n' },
      link,
    })
    expect(preview.changes).toEqual([])
    expect(preview.sheets[0]!.columns).toEqual({ before: 2, after: 3, added: [{ index: 1, label: 'B', cells: 4 }], removed: [] })
    expect(preview.sheets[0]!.rows).toEqual({ before: 3, after: 4, added: [{ index: 1, cells: 3 }], removed: [] })
  })

  it('reports a formula whose relative offset changed when a column is inserted between it and its reference', () => {
    const preview = previewSheet({
      before: { format: 'csv', content: 'a,b,total\n1,2,=A2+B2\n' },
      after: { format: 'csv', content: 'a,note,b,total\n1,x,2,=A2+C2\n' },
      link,
    })
    expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0]).toMatchObject({ kind: 'formula', address: 'D2' })
  })

  it('aligns a column inserted in the middle instead of shifting every later column', () => {
    const preview = previewSheet({
      before: { format: 'csv', content: 'id,region,amount\n1,north,10\n2,south,20\n3,east,30\n' },
      after: { format: 'csv', content: 'id,note,region,amount\n1,alpha,north,10\n2,beta,south,20\n3,gamma,east,30\n' },
      link,
    })
    expect(preview.changes).toEqual([])
    expect(preview.sheets[0]!.columns).toEqual({ before: 3, after: 4, added: [{ index: 1, label: 'B', cells: 4 }], removed: [] })
    expect(preview.sheets[0]!.rows).toEqual({ before: 4, after: 4, added: [], removed: [] })
    expect(preview.summary.columns).toEqual({ before: 3, after: 4, added: 1, removed: 0 })
  })

  it('shifts relative references in a shared formula and leaves absolute references and strings alone', () => {
    expect(shiftFormula('$A$1+A1', 0, 0, 2, 3)).toBe('$A$1+D3')
    expect(shiftFormula("'My Sheet'!B2+LOG10(C3)", 0, 0, 1, 0)).toBe("'My Sheet'!B3+LOG10(C4)")
    expect(shiftFormula('A1+"A1"+SUM(A1:B2)', 0, 0, 1, 1)).toBe('B2+"A1"+SUM(B2:C3)')
    expect(shiftFormula('LOG10 (A1)+B1', 0, 0, 1, 0)).toBe('LOG10 (A2)+B2')
    expect(shiftFormula('A1', 0, 0, -1, 0)).toBe('A1')
  })

  it('reads a ZIP-stored worksheet and keeps a shared formula relative to its cell', () => {
    const parsed = parseXlsx(bytes('stored.xlsx'))
    expect([parsed[0]!.name, parsed[0]!.rows[1]!.cells.find(cell => cell.address === 'D2')!.formula])
      .toEqual(['Summary', 'B2*C2'])
  })

  it('keeps a self-closing empty shared string at its index', () => {
    const parsed = parseXlsx(bytes('empty-shared-string.xlsx'))
    expect(parsed[0]!.rows.map(row => row.cells.map(cell => [cell.address, cell.value])))
      .toEqual([[['A1', 'first']], [['A3', 'third']]])
  })

  it('expands a shared formula whose master comes after its follower', () => {
    const parsed = parseXlsx(bytes('shared-formula-up.xlsx'))
    expect([parsed[0]!.rows[1]!.cells.find(cell => cell.address === 'D2')!.formula,
      parsed[0]!.rows[2]!.cells.find(cell => cell.address === 'D3')!.formula]).toEqual(['B2*C2', 'B3*C3'])
  })

  it('degrades an unreadable workbook to a line diff with the original link and the parse code', () => {
    const preview = previewSheet({
      before: { format: 'xlsx', content: bytes('broken-before.xlsx'), text: read('broken-before.xlsx') },
      after: { format: 'xlsx', content: bytes('broken-after.xlsx'), text: read('broken-after.xlsx') },
      link,
    })
    expect([preview.kind, preview.format, preview.unit, preview.link, preview.sheets, preview.changes]).toEqual(['text/diff', 'xlsx', 'line', link, [], []])
    expect(preview.degraded).toEqual({ code: 'notZip', message: 'The .xlsx content is not a ZIP archive', side: 'before' })
    expect(preview.lines).toEqual([
      { kind: 'changed', before: { line: 1, text: 'Revenue grew by four percent.' }, after: { line: 1, text: 'Revenue grew by six percent.' } },
      { kind: 'added', after: { line: 3, text: 'Costs fall in June.' } },
    ])
    expect(preview.summary).toEqual({
      sheets: { before: 0, after: 0, added: 0, removed: 0, changed: 0 },
      rows: { before: 0, after: 0, added: 0, removed: 0 },
      columns: { before: 0, after: 0, added: 0, removed: 0 },
      cells: { added: 0, removed: 0, formula: 0, value: 0 },
    })
  })

  it('keeps the readable side when only the other workbook cannot be parsed', () => {
    const preview = previewSheet({
      before: { format: 'xlsx', content: bytes('broken-before.xlsx') },
      after: { format: 'xlsx', content: bytes('ledger-after.xlsx') },
      link,
    })
    expect(preview.degraded).toMatchObject({ code: 'notZip', side: 'before' })
    expect(preview.lines?.some(change => change.after?.text === 'A1\tItem')).toBe(true)
    expect(preview.lines?.some(change => change.after?.text.startsWith('D2\t='))).toBe(true)
    const reversed = previewSheet({
      before: { format: 'xlsx', content: bytes('ledger-after.xlsx') },
      after: { format: 'xlsx', content: bytes('broken-before.xlsx') },
      link,
    })
    expect(reversed.degraded).toMatchObject({ code: 'notZip', side: 'after' })
    expect(reversed.lines?.some(change => change.before?.text === 'A1\tItem')).toBe(true)
  })

  it('reports a removed cell where it used to be after a row insertion above it', () => {
    const preview = previewSheet({
      before: { format: 'csv', content: 'a,b\n1,2\n' },
      after: { format: 'csv', content: 'a,b\nnew,row\n1,\n' },
      link,
    })
    expect(preview.sheets[0]!.rows.added).toEqual([{ index: 1, cells: 2 }])
    expect(preview.changes.find(change => change.kind === 'removed'))
      .toMatchObject({ kind: 'removed', address: 'B2', row: 1, column: 1 })
  })

  it('keeps an entity-looking name literal instead of reading it from Object.prototype', () => {
    const parsed = parseXlsx(bytes('entity.xlsx'))
    expect(parsed[0]!.rows[0]!.cells.find(cell => cell.address === 'A1')!.value).toBe('&constructor;')
  })

  it('pairs an edited fallback line with its own revision when a line is inserted above it', () => {
    const encoder = new TextEncoder()
    const preview = previewSheet({
      before: { format: 'xlsx', content: encoder.encode('not a zip'), text: 'Alpha beta gamma\nSecond line' },
      after: { format: 'xlsx', content: encoder.encode('not a zip'), text: 'Inserted line\nAlpha beta delta\nSecond line' },
      link,
    })
    expect(preview.lines).toEqual([
      { kind: 'added', after: { line: 1, text: 'Inserted line' } },
      { kind: 'changed', before: { line: 1, text: 'Alpha beta gamma' }, after: { line: 2, text: 'Alpha beta delta' } },
    ])
  })

  it('keeps editor line numbers when blank lines are skipped in the fallback', () => {
    const encoder = new TextEncoder()
    const preview = previewSheet({
      before: { format: 'xlsx', content: encoder.encode('not a zip'), text: 'alpha\n\nbeta\ngamma' },
      after: { format: 'xlsx', content: encoder.encode('not a zip'), text: 'alpha\n\nbeta\ndelta' },
      link,
    })
    expect(preview.lines).toEqual([
      { kind: 'changed', before: { line: 4, text: 'gamma' }, after: { line: 4, text: 'delta' } },
    ])
  })

  it('refuses a malformed package or caller error instead of inventing a preview', () => {
    let failure: unknown
    try { parseXlsx(bytes('no-workbook.xlsx')) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(SheetParseError)
    expect((failure as SheetParseError).code).toBe('missingWorkbook')
    try { parseXlsx(bytes('missing-sheet.xlsx')) } catch (error) { failure = error }
    expect((failure as SheetParseError).code).toBe('missingSheet')
    failure = undefined
    try { parseXlsx(bytes('missing-relationship.xlsx')) } catch (error) { failure = error }
    expect((failure as SheetParseError).code).toBe('missingSheet')
    failure = undefined
    try { parseXlsx(bytes('bad-shared-string.xlsx')) } catch (error) { failure = error }
    expect((failure as SheetParseError).code).toBe('invalidWorkbook')
    failure = undefined
    try { parseXlsx(bytes('not-worksheet.xlsx')) } catch (error) { failure = error }
    expect((failure as SheetParseError).code).toBe('invalidWorkbook')
    failure = undefined
    try { parseXlsx(bytes('truncated-sheet.xlsx')) } catch (error) { failure = error }
    expect((failure as SheetParseError).code).toBe('invalidWorkbook')
    expect(() => previewSheet({ before: { format: 'csv', content: 'a' }, after: { format: 'xlsx', content: bytes('ledger-after.xlsx') }, link }))
      .toThrow(TypeError)
    expect(() => previewSheet({ before: { format: 'csv', content: 'a' }, after: { format: 'csv', content: 'b' }, link: ' ' }))
      .toThrow(TypeError)
    expect(() => previewSheet({ before: { format: 'xlsx', content: 'not bytes' }, after: { format: 'xlsx', content: 'not bytes' }, link }))
      .not.toThrow()
  })

  it('compares a 10,000-row 40-column table in well under two seconds', () => {
    const header = Array.from({ length: 40 }, (_, column) => `c${column}`).join(',')
    const row = (index: number, changed: boolean) => Array.from({ length: 40 }, (_, column) =>
      changed ? `x${column}` : String((index * 40 + column) % 97)).join(',')
    const beforeRows = [header]
    const afterRows = [header]
    for (let index = 0; index < 10_000; index++) {
      beforeRows.push(row(index, false))
      afterRows.push(row(index, index === 5_000))
    }
    const started = performance.now()
    const preview = previewSheet({ before: { format: 'csv', content: beforeRows.join('\n') },
      after: { format: 'csv', content: afterRows.join('\n') }, link })
    const elapsed = performance.now() - started
    expect(preview.changes).toHaveLength(40)
    expect(preview.changes.every(change => change.kind === 'value' && change.row === 5_001)).toBe(true)
    expect(preview.sheets[0]!.rows).toMatchObject({ before: 10_001, after: 10_001, added: [], removed: [] })
    expect(elapsed).toBeLessThan(2_000)
  })

  it('keeps a row insertion structural in a 10,000-row table with 2,000 edited rows', () => {
    const beforeRows = ['id,left,right']
    const afterRows = ['id,left,right']
    const insertAt = 5_002
    for (let index = 0; index < 10_000; index++) {
      const edited = index % 5 === 0
      beforeRows.push(`${index},${index + 100},${index + 200}`)
      if (index === insertAt) afterRows.push(`${index},inserted,row`)
      afterRows.push(edited ? `${index},${index + 500},${index + 600}` : `${index},${index + 100},${index + 200}`)
    }
    const started = performance.now()
    const preview = previewSheet({ before: { format: 'csv', content: beforeRows.join('\n') },
      after: { format: 'csv', content: afterRows.join('\n') }, link })
    const elapsed = performance.now() - started
    expect(preview.sheets[0]!.rows.added).toEqual([{ index: insertAt + 1, cells: 3 }])
    expect(preview.sheets[0]!.rows.removed).toEqual([])
    expect(preview.changes).toHaveLength(4_000)
    expect(preview.changes.every(change => change.kind === 'value')).toBe(true)
    expect(elapsed).toBeLessThan(2_000)
  })

  it('compares a 10,000-row .xlsx workbook in well under two seconds', () => {
    const started = performance.now()
    const preview = previewSheet({ before: { format: 'xlsx', content: bytes('large-before.xlsx') },
      after: { format: 'xlsx', content: bytes('large-after.xlsx') }, link })
    const elapsed = performance.now() - started
    expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0]).toMatchObject({ kind: 'value', address: 'B5001' })
    expect(preview.sheets[0]!.rows).toMatchObject({ before: 10_001, after: 10_001, added: [], removed: [] })
    expect(elapsed).toBeLessThan(2_000)
  })

  it('compares a 10,000-row table in well under two seconds', () => {
    const rows = 10_000
    const before = ['id,amount,note']
    const after = ['id,amount,note']
    for (let index = 1; index <= rows; index++) {
      before.push(`${index},${index % 97},row ${index}`)
      after.push(`${index},${index === 5_000 ? 999 : index % 97},row ${index}`)
    }
    const started = performance.now()
    const preview = previewSheet({ before: { format: 'csv', content: `${before.join('\n')}\n` },
      after: { format: 'csv', content: `${after.join('\n')}\n` }, link })
    const elapsed = performance.now() - started
    expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0]).toMatchObject({ kind: 'value', address: 'B5001' })
    expect(elapsed).toBeLessThan(2_000)
  })
})