import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DocParseError, diffDocBlocks, parseDocx, parseMarkdown, previewDoc, type DocChange, type DocInline } from '@superagent/dsh/app/preview/doc.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'doc-preview')
const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)))
const link = 'https://example.test/documents/handbook'
/** A change reduced to what a reader sees: the kind, both positions and the paragraph. */
const shape = (changes: readonly DocChange[]) => changes.map(change => [change.kind, change.before?.index ?? null,
  change.after?.index ?? null, change.before?.text ?? change.after?.text])
/** Render inline segments the way a reviewer reads them, marking removed and added text. */
const inline = (segments: readonly DocInline[] = []): string => segments
  .map(segment => segment.kind === 'removed' ? `[-${segment.text}-]` : segment.kind === 'added' ? `{+${segment.text}+}` : segment.text)
  .join('')
/** A ZIP whose one central-directory entry declares `size`, enough to test the bound without the content. */
const declaredArchive = (size: number): Uint8Array => {
  const name = Buffer.from('word/document.xml')
  const central = Buffer.alloc(46 + name.length)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(size, 24)
  central.writeUInt16LE(name.length, 28)
  name.copy(central, 46)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length, 12)
  return new Uint8Array(Buffer.concat([central, eocd]))
}

describe('the doc previewer', () => {
  it('reads Markdown headings, prose, lists, quotes, tables and code as blocks', () => {
    expect(parseMarkdown(read('handbook-before.md'))).toEqual([
      { kind: 'heading', level: 1, text: 'Release handbook' },
      { kind: 'paragraph', text: 'The release train leaves on Thursday. Every change needs a review.' },
      { kind: 'heading', level: 2, text: 'Checklist' },
      { kind: 'list', text: 'Run the tests' },
      { kind: 'list', text: 'Write the changelog' },
      { kind: 'list', text: 'Announce the release' },
      { kind: 'heading', level: 2, text: 'Rollback' },
      { kind: 'paragraph', text: 'Revert the merge commit and page the on-call engineer.' },
      { kind: 'heading', level: 2, text: 'Contacts' },
      { kind: 'paragraph', text: 'Ask the release manager in #release.' },
    ])
    // A prose paragraph spans its soft-wrapped lines, while every block form keeps its own paragraph.
    expect(parseMarkdown('Title\n===\n\nA wrapped line\ncontinues here.\n\n> quoted\n\n```ts\nconst x = 1\n```\n\n| a | b |\n|---|---|\n')).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'A wrapped line continues here.' },
      { kind: 'quote', text: 'quoted' },
      { kind: 'code', text: 'const x = 1' },
      { kind: 'table', text: '| a | b |' },
      { kind: 'table', text: '|---|---|' },
    ])
  })

  it('compares the Markdown fixture into added, removed, changed and moved paragraphs', () => {
    const preview = previewDoc({ before: { format: 'markdown', content: read('handbook-before.md') },
      after: { format: 'markdown', content: read('handbook-after.md') }, link })
    expect([preview.kind, preview.format, preview.unit, preview.link, preview.degraded]).toEqual(['text/redline', 'markdown', 'paragraph', link, undefined])
    expect(shape(preview.changes)).toEqual([
      ['changed', 1, 1, 'The release train leaves on Thursday. Every change needs a review.'],
      ['moved', 3, 5, 'Run the tests'],
      ['added', null, 6, 'Update the status page'],
      ['changed', 7, 8, 'Revert the merge commit and page the on-call engineer.'],
      ['removed', 8, null, 'Contacts'],
      ['removed', 9, null, 'Ask the release manager in #release.'],
    ])
    expect(preview.summary).toEqual({ before: 10, after: 9, added: 1, removed: 2, changed: 2, moved: 1 })
    // The changed paragraph carries a token-level redline, not just its two revisions.
    expect(inline(preview.changes[0]!.inline)).toBe('The release train leaves on [-Thursday-]{+Friday+}. Every change needs [-a-]{+two+} [-review-]{+reviews+}.')
    expect(inline(preview.changes[3]!.inline)).toBe('Revert the merge commit{+,+} [-and-]{+then+} page the on-call engineer.')
  })

  it('reads Word paragraphs, headings and lists, then diffs the docx fixture the same way', () => {
    expect(parseDocx(bytes('notes-before.docx'))).toEqual([
      { kind: 'heading', level: 1, text: 'Release notes' },
      { kind: 'paragraph', text: 'The release train leaves on Thursday.' },
      { kind: 'heading', level: 1, text: 'Checklist' },
      { kind: 'list', text: 'Run the tests' },
      { kind: 'list', text: 'Write the changelog' },
      { kind: 'list', text: 'Announce the release' },
      { kind: 'heading', level: 1, text: 'Rollback' },
      { kind: 'paragraph', text: 'Revert the merge commit and page the on-call engineer.' },
      { kind: 'heading', level: 1, text: 'Contacts' },
      { kind: 'paragraph', text: 'Ask the release manager in #release.' },
    ])
    const preview = previewDoc({ before: { format: 'docx', content: bytes('notes-before.docx') },
      after: { format: 'docx', content: bytes('notes-after.docx') }, link })
    expect([preview.kind, preview.format, preview.unit, preview.link, preview.degraded]).toEqual(['text/redline', 'docx', 'paragraph', link, undefined])
    expect(shape(preview.changes)).toEqual([
      ['changed', 1, 1, 'The release train leaves on Thursday.'],
      ['moved', 3, 5, 'Run the tests'],
      ['added', null, 6, 'Update the status page'],
      ['changed', 7, 8, 'Revert the merge commit and page the on-call engineer.'],
      ['removed', 8, null, 'Contacts'],
      ['removed', 9, null, 'Ask the release manager in #release.'],
    ])
    expect(preview.summary).toEqual({ before: 10, after: 9, added: 1, removed: 2, changed: 2, moved: 1 })
    expect(inline(preview.changes[0]!.inline)).toBe('The release train leaves on [-Thursday-]{+Friday+}.')
  })

  it('reads an outline level and a style as headings, and leaves outline level 9 as body text', () => {
    expect(parseDocx(bytes('outline.docx'))).toEqual([
      { kind: 'paragraph', text: 'Body outline text' },
      { kind: 'heading', level: 2, text: 'Second outline heading' },
      { kind: 'heading', level: 2, text: 'Second styled heading' },
    ])
  })

  it('keeps an unknown entity as text instead of reading an inherited object member', () => {
    expect(parseDocx(bytes('entities.docx'))).toEqual([{ kind: 'paragraph', text: 'A & B &constructor; C < D' }])
  })

  it('degrades an unreadable document to a line diff with the original link and the parse code', () => {
    const preview = previewDoc({ before: { format: 'docx', content: bytes('broken-before.docx') },
      after: { format: 'docx', content: bytes('broken-after.docx') }, link })
    expect([preview.kind, preview.format, preview.unit, preview.link]).toEqual(['text/diff', 'docx', 'line', link])
    expect(preview.degraded).toEqual({ code: 'notZip', message: 'The .docx content is not a ZIP archive', side: 'before' })
    expect(shape(preview.changes)).toEqual([
      ['changed', 1, 1, 'Revenue grew by four percent.'],
      ['added', null, 3, 'Hiring resumes in May.'],
    ])
    expect(preview.summary).toEqual({ before: 3, after: 4, added: 1, removed: 0, changed: 1, moved: 0 })
    expect(inline(preview.changes[0]!.inline)).toBe('Revenue grew by [-four-]{+six+} percent.')
  })

  it('uses the caller’s plain text when a binary side cannot be read, and names that side', () => {
    const preview = previewDoc({
      before: { format: 'docx', content: new Uint8Array([0, 1, 2]), text: 'Alpha\nBeta' },
      after: { format: 'docx', content: new Uint8Array([3, 4, 5]), text: 'Alpha\nBeta\nGamma' },
      link,
    })
    expect(preview.degraded).toMatchObject({ code: 'notZip', side: 'before' })
    expect(shape(preview.changes)).toEqual([['added', null, 2, 'Gamma']])
  })

  it('reads an empty document as no change and keeps the result stable as plain data', () => {
    const empty = previewDoc({ before: { format: 'markdown', content: '' }, after: { format: 'markdown', content: '\n\n' }, link })
    expect(empty).toEqual({ kind: 'text/redline', format: 'markdown', unit: 'paragraph', link, changes: [],
      summary: { before: 0, after: 0, added: 0, removed: 0, changed: 0, moved: 0 } })
    const before = parseMarkdown(read('handbook-before.md'))
    const after = parseMarkdown(read('handbook-after.md'))
    const first = diffDocBlocks(before, after)
    expect(diffDocBlocks(before, after)).toEqual(first)
    expect(JSON.parse(JSON.stringify(first))).toEqual(first)
  })

  it('reads an unrelated replacement as a removal and an addition, not a change', () => {
    expect(diffDocBlocks(parseMarkdown('Something completely different.'), parseMarkdown('Nothing alike here.')))
      .toEqual([{ kind: 'removed', before: { index: 0, kind: 'paragraph', text: 'Something completely different.' } },
        { kind: 'added', after: { index: 0, kind: 'paragraph', text: 'Nothing alike here.' } }])
  })

  it('reads a ZIP-stored document entry as well as the deflated one', () => {
    expect(parseDocx(bytes('stored.docx'))).toEqual([
      { kind: 'heading', level: 1, text: 'Stored notes' },
      { kind: 'paragraph', text: 'A stored entry is one ZIP writes without compression.' },
    ])
  })

  it('keeps the paragraph around a text box, without reading the box', () => {
    expect(parseDocx(bytes('textbox.docx'))).toEqual([{ kind: 'paragraph', text: 'Before the box after it.' }])
  })

  it('names a missing document entry, a document without a body, an unclosed document and an unclosed paragraph', () => {
    const failure = (name: string): unknown => {
      try { parseDocx(bytes(name)) } catch (error) { return error }
      throw new Error(`${name} was expected to fail`)
    }
    expect(failure('no-document.docx')).toMatchObject({ name: 'DocParseError', code: 'missingDocument' })
    expect(failure('no-body.docx')).toMatchObject({ name: 'DocParseError', code: 'invalidDocument' })
    expect(failure('malformed.docx')).toMatchObject({ name: 'DocParseError', code: 'invalidDocument' })
    expect(failure('unbalanced.docx')).toMatchObject({ name: 'DocParseError', code: 'invalidDocument' })
    const preview = previewDoc({ before: { format: 'docx', content: bytes('no-document.docx') },
      after: { format: 'docx', content: bytes('notes-after.docx') }, link })
    expect(preview.degraded).toMatchObject({ code: 'missingDocument', side: 'before' })
    expect(preview.kind).toBe('text/diff')
    // The side that parsed contributes its paragraph text, not the ZIP bytes it arrived as.
    expect(preview.changes.some(change => change.after?.text === 'Release notes')).toBe(true)
    const reversed = previewDoc({ before: { format: 'docx', content: bytes('notes-before.docx') },
      after: { format: 'docx', content: bytes('no-document.docx') }, link })
    expect(reversed.degraded).toMatchObject({ code: 'missingDocument', side: 'after' })
    expect(reversed.changes.some(change => change.before?.text === 'Release notes')).toBe(true)
  })

  it('pairs a duplicate paragraph with the nearest copy', () => {
    const block = (text: string) => ({ kind: 'paragraph' as const, text })
    expect(diffDocBlocks(['A', 'B', 'A', 'C'].map(block), ['A', 'C', 'B', 'A'].map(block))).toEqual([
      { kind: 'moved', before: { index: 3, kind: 'paragraph', text: 'C' }, after: { index: 1, kind: 'paragraph', text: 'C' } },
    ])
  })

  it('leaves the inline comparison out of a paragraph too large to tokenize', () => {
    const long = 'word '.repeat(5_000)
    const preview = previewDoc({ before: { format: 'markdown', content: `${long}end` },
      after: { format: 'markdown', content: `${long}finish` }, link })
    expect(preview.changes).toHaveLength(1)
    expect(preview.changes[0]?.kind).toBe('changed')
    expect(preview.changes[0]?.inline).toBeUndefined()
  })

  it('bounds the similarity work a very large rewrite may spend', () => {
    const before = Array.from({ length: 400 }, (_, index) => ({ kind: 'paragraph' as const, text: `Paragraph ${index} before` }))
    const after = Array.from({ length: 400 }, (_, index) => ({ kind: 'paragraph' as const, text: `Paragraph ${index} after` }))
    const started = Date.now()
    const changes = diffDocBlocks(before, after)
    expect(Date.now() - started).toBeLessThan(2_000)
    // A paired edit turns two changes into one, so the list is smaller than 800 and never below 400.
    expect(changes.length).toBeGreaterThanOrEqual(400)
    expect(changes.length).toBeLessThan(800)
    // The first removals pair with their edits, then the comparison budget runs out and the rest stay removed and added.
    expect(changes.filter(change => change.kind === 'changed').length).toBeGreaterThan(0)
    expect(changes.filter(change => change.kind === 'changed').length).toBeLessThan(400)
    const removed = changes.filter(change => change.kind === 'removed').length
    expect(removed).toBeGreaterThan(0)
    expect(changes.filter(change => change.kind === 'added').length).toBe(removed)
  })

  it('refuses an entry whose declared size is beyond the preview bound', () => {
    let failure: unknown
    try { parseDocx(declaredArchive(33 * 1024 * 1024)) } catch (error) { failure = error }
    expect(failure).toMatchObject({ name: 'DocParseError', code: 'tooLarge' })
  })

  it('refuses a caller error instead of degrading it', () => {
    expect(() => previewDoc({ before: { format: 'markdown', content: 'a' }, after: { format: 'docx', content: bytes('notes-after.docx') }, link }))
      .toThrow(TypeError)
    expect(() => previewDoc({ before: { format: 'markdown', content: 'a' }, after: { format: 'markdown', content: 'b' }, link: ' ' }))
      .toThrow(TypeError)
    let failure: unknown
    try { parseDocx(new Uint8Array([1, 2, 3])) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(DocParseError)
    expect((failure as DocParseError).code).toBe('notZip')
  })
})