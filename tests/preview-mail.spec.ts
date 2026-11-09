import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { previewMail, type MailAttachmentChange, type MailBodyChange, type MailDraft, type MailPreview,
  type MailRecipientChange } from '@superagent/dsh/app/preview/mail.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'mail-preview')
const draft = (name: string): MailDraft => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as MailDraft
const link = 'https://example.test/mail/drafts/42'
/** A recipient change reduced to what a reviewer reads: the kind, the address and both sets of fields. */
const recipientShape = (changes: readonly MailRecipientChange[]) => changes.map(change => [change.kind, change.address.key,
  change.before.map(ref => `${ref.role}:${ref.address.display}`),
  change.after.map(ref => `${ref.role}:${ref.address.display}`)])
/** The audience reduced to the address, its fields and whether it is blind-copied. */
const audienceShape = (preview: MailPreview) => preview.recipients.audience
  .map(entry => [entry.address.key, entry.roles, entry.bcc])
/** A body change reduced to the kind, both line numbers and both texts. */
const bodyShape = (changes: readonly MailBodyChange[]) => changes.map(change => [change.kind,
  change.before?.line ?? null, change.after?.line ?? null, change.before?.text ?? null, change.after?.text ?? null])
/** An attachment change reduced to the kind, the name, the revision fields and why it changed. */
const attachmentShape = (changes: readonly MailAttachmentChange[]) => changes.map(change => [change.kind, change.name,
  change.before === undefined ? null : [change.before.digest, change.before.size, change.before.contentType, change.before.inline],
  change.after === undefined ? null : [change.after.digest, change.after.size, change.after.contentType, change.after.inline],
  change.fields ?? []])

describe('the mail previewer', () => {
  it('compares the fixture into the four sections and names the explicit audience', () => {
    const preview = previewMail({ before: draft('draft-before.json'), after: draft('draft-after.json'), link })
    expect([preview.kind, preview.unit, preview.link]).toEqual(['mail/draft', 'message', link])
    expect(preview.subject).toEqual({ before: 'Q4 launch plan', after: 'Q4 launch plan — Friday', changed: true })
    expect(recipientShape(preview.recipients.changes)).toEqual([
      ['added', 'erin@example.com', [], ['to:Erin <erin@example.com>']],
      ['changed', 'bob@example.com', ['to:Bob <bob@example.com>'], ['bcc:Bob <bob@example.com>']],
      ['added', 'dave@example.com', [], ['bcc:Dave <dave@example.com>']],
    ])
    expect(audienceShape(preview)).toEqual([
      ['alice@example.com', ['to'], false],
      ['erin@example.com', ['to'], false],
      ['carol@example.com', ['cc'], false],
      ['bob@example.com', ['bcc'], true],
      ['dave@example.com', ['bcc'], true],
    ])
    expect(preview.recipients.before).toEqual({ to: 2, cc: 1, bcc: 0, total: 3 })
    expect(preview.recipients.after).toEqual({ to: 2, cc: 1, bcc: 2, total: 5 })
    expect(preview.recipients.warnings.map(warning => [warning.code, warning.addresses])).toEqual([
      ['bccHidden', ['bob@example.com', 'dave@example.com']],
      ['movedToBcc', ['bob@example.com']],
    ])
    expect(bodyShape(preview.body.changes)).toEqual([
      ['changed', 3, 3, 'The launch is on Thursday.', 'The launch is on Friday.'],
    ])
    expect(preview.body.summary).toEqual({ before: 7, after: 7, added: 0, removed: 0, changed: 1 })
    expect(preview.body.alignment).toBe('lines')
    expect(attachmentShape(preview.attachments.changes)).toEqual([
      ['changed', 'plan.pdf', ['a'.repeat(64), 18234, 'application/pdf', false],
        ['c'.repeat(64), 18300, 'application/pdf', false], ['content', 'size']],
      ['added', 'notes.txt', null, ['d'.repeat(64), 12, 'text/plain', false], []],
      ['removed', 'budget.xlsx', ['b'.repeat(64), 9000,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', false], null, []],
    ])
    expect(preview.attachments.summary).toEqual({ before: 2, after: 2, added: 1, removed: 1, changed: 1 })
    expect(preview.attachments.unverified).toEqual([])
    expect(preview.summary).toEqual({
      recipients: { before: 3, after: 5, added: 2, removed: 0, changed: 1 },
      subject: { changed: true },
      body: { before: 7, after: 7, added: 0, removed: 0, changed: 1 },
      attachments: { before: 2, after: 2, added: 1, removed: 1, changed: 1 },
    })
  })

  it('shows every Cc and Bcc move as one changed recipient, in both directions', () => {
    const preview = previewMail({
      before: { to: ['Alice <alice@example.com>', 'Bob <bob@example.com>'], cc: ['Carol <carol@example.com>'],
        bcc: ['Dave <dave@example.com>'] },
      after: { to: ['Alice <alice@example.com>'], cc: ['Bob <bob@example.com>', 'Dave <dave@example.com>'],
        bcc: ['Carol <carol@example.com>'] },
      link,
    })
    expect(recipientShape(preview.recipients.changes)).toEqual([
      ['changed', 'bob@example.com', ['to:Bob <bob@example.com>'], ['cc:Bob <bob@example.com>']],
      ['changed', 'dave@example.com', ['bcc:Dave <dave@example.com>'], ['cc:Dave <dave@example.com>']],
      ['changed', 'carol@example.com', ['cc:Carol <carol@example.com>'], ['bcc:Carol <carol@example.com>']],
    ])
    expect(audienceShape(preview)).toEqual([
      ['alice@example.com', ['to'], false],
      ['bob@example.com', ['cc'], false],
      ['dave@example.com', ['cc'], false],
      ['carol@example.com', ['bcc'], true],
    ])
    expect(preview.recipients.warnings.map(warning => [warning.code, warning.addresses])).toEqual([
      ['bccHidden', ['carol@example.com']],
      ['movedToBcc', ['carol@example.com']],
    ])
  })

  it('keeps a Bcc copy visible when the address stays in To, without calling it a move', () => {
    const preview = previewMail({
      before: { to: ['a@example.com'] },
      after: { to: ['a@example.com'], bcc: ['a@example.com'] },
      link,
    })
    expect(recipientShape(preview.recipients.changes)).toEqual([
      ['changed', 'a@example.com', ['to:a@example.com'], ['to:a@example.com', 'bcc:a@example.com']],
    ])
    expect(audienceShape(preview)).toEqual([['a@example.com', ['to', 'bcc'], true]])
    expect(preview.recipients.before).toEqual({ to: 1, cc: 0, bcc: 0, total: 1 })
    expect(preview.recipients.after).toEqual({ to: 1, cc: 0, bcc: 1, total: 1 })
    expect(preview.recipients.warnings.map(warning => [warning.code, warning.addresses])).toEqual([
      ['bccHidden', ['a@example.com']],
      ['duplicateRecipient', ['a@example.com']],
    ])
    // The Bcc copy is hidden, but the address is still visible in To, so this is not a move to Bcc.
    expect(preview.recipients.warnings.some(warning => warning.code === 'movedToBcc')).toBe(false)
  })

  it('adds and removes recipients in each field, and keeps a Bcc-only addition explicit', () => {
    const preview = previewMail({
      before: { to: ['a@example.com'], cc: ['b@example.com', 'g@example.com'], bcc: ['c@example.com'] },
      after: { to: ['d@example.com'], cc: ['b@example.com', 'e@example.com'], bcc: ['f@example.com'] },
      link,
    })
    expect(recipientShape(preview.recipients.changes)).toEqual([
      ['added', 'd@example.com', [], ['to:d@example.com']],
      ['added', 'e@example.com', [], ['cc:e@example.com']],
      ['added', 'f@example.com', [], ['bcc:f@example.com']],
      ['removed', 'a@example.com', ['to:a@example.com'], []],
      ['removed', 'g@example.com', ['cc:g@example.com'], []],
      ['removed', 'c@example.com', ['bcc:c@example.com'], []],
    ])
    expect(preview.recipients.before).toEqual({ to: 1, cc: 2, bcc: 1, total: 4 })
    expect(preview.recipients.after).toEqual({ to: 1, cc: 2, bcc: 1, total: 4 })
    expect(preview.recipients.warnings.map(warning => [warning.code, warning.addresses]))
      .toEqual([['bccHidden', ['f@example.com']]])
  })

  it('parses bare and named addresses, compares case-insensitively and keeps display-name changes visible', () => {
    const preview = previewMail({
      before: { to: ['Alice <alice@example.com>', { name: 'Bob', address: 'bob@example.com' },
        '"Doe, John" <john@example.com>', '<solo@example.com>'] },
      after: { to: ['Alice <ALICE@example.com>', 'Bob <bob@example.com>', 'John Doe <john@example.com>', 'solo@example.com'] },
      link,
    })
    expect(audienceShape(preview)).toEqual([
      ['alice@example.com', ['to'], false],
      ['bob@example.com', ['to'], false],
      ['john@example.com', ['to'], false],
      ['solo@example.com', ['to'], false],
    ])
    expect(recipientShape(preview.recipients.changes)).toEqual([
      ['changed', 'john@example.com', ['to:Doe, John <john@example.com>'], ['to:John Doe <john@example.com>']],
    ])
    // The mailbox case changed, but the key is the same; only a display-name change is reported for that address.
    expect(preview.recipients.changes.some(change => change.address.key === 'alice@example.com')).toBe(false)
    expect(preview.recipients.audience[2]!.address.name).toBe('John Doe')
    expect(preview.recipients.audience[3]!.address.name).toBeUndefined()
  })

  it('keeps Bcc visible and warned about when the draft is otherwise unchanged', () => {
    const before: MailDraft = { to: ['a@example.com'], bcc: ['b@example.com'], subject: 'Same', body: 'Same' }
    const preview = previewMail({ before, after: before, link })
    expect(preview.recipients.changes).toEqual([])
    expect(preview.recipients.warnings.map(warning => [warning.code, warning.addresses]))
      .toEqual([['bccHidden', ['b@example.com']]])
    expect(audienceShape(preview)).toEqual([
      ['a@example.com', ['to'], false],
      ['b@example.com', ['bcc'], true],
    ])
    expect([preview.subject.changed, preview.body.changes, preview.attachments.changes])
      .toEqual([false, [], []])
  })

  it('warns when one address appears in more than one field or twice in one field', () => {
    const across = previewMail({ before: {}, after: { to: ['a@example.com'], cc: ['a@example.com'] }, link })
    expect(audienceShape(across)).toEqual([['a@example.com', ['to', 'cc'], false]])
    expect(across.recipients.warnings.map(warning => [warning.code, warning.addresses]))
      .toEqual([['duplicateRecipient', ['a@example.com']]])
    const twice = previewMail({ before: { to: ['a@example.com'] }, after: { to: ['a@example.com', 'A@EXAMPLE.COM'] }, link })
    expect(twice.recipients.changes).toEqual([])
    expect(twice.recipients.warnings.map(warning => [warning.code, warning.addresses]))
      .toEqual([['duplicateRecipient', ['a@example.com']]])
    // A duplicate the after revision fixed is not a warning about what will be sent.
    expect(previewMail({ before: { to: ['a@example.com', 'A@EXAMPLE.COM'] }, after: { to: ['a@example.com'] }, link })
      .recipients.warnings).toEqual([])
  })

  it('warns when the after draft has no recipients at all', () => {
    const preview = previewMail({ before: { to: ['a@example.com'], subject: 'Hi', body: 'Body' }, after: { subject: 'Hi', body: 'Body' }, link })
    expect(preview.recipients.audience).toEqual([])
    expect(preview.recipients.after).toEqual({ to: 0, cc: 0, bcc: 0, total: 0 })
    expect(preview.recipients.warnings).toEqual([
      { code: 'noRecipients', addresses: [], message: 'The draft has no To, Cc or Bcc recipient.' },
    ])
  })

  it('diffs the body by line with editor line numbers, pairing a changed line instead of a delete and an add', () => {
    const preview = previewMail({
      before: { body: 'Alpha\r\nBravo\r\nCharlie\r\nDelta\r\n' },
      after: { body: 'Alpha\nBravo two\nDelta\nEcho\n' },
      link,
    })
    expect(bodyShape(preview.body.changes)).toEqual([
      ['changed', 2, 2, 'Bravo', 'Bravo two'],
      ['removed', 3, null, 'Charlie', null],
      ['added', null, 4, null, 'Echo'],
    ])
    expect(preview.body.summary).toEqual({ before: 4, after: 4, added: 1, removed: 1, changed: 1 })
    // A final newline is not a line, and a trailing-whitespace-only difference is not content.
    expect(previewMail({ before: { body: 'A\n' }, after: { body: 'A' }, link }).body.changes).toEqual([])
    expect(previewMail({ before: { body: 'A  \nB' }, after: { body: 'A\nB' }, link }).body.changes).toEqual([])
  })

  it('keeps a large body bounded and trims common ends before pairing by position', () => {
    const before = Array.from({ length: 1200 }, (_, index) => `line ${index + 1}`).join('\n')
    const replaced = before.replace('line 600', 'line six hundred')
    const replacedPreview = previewMail({ before: { body: before }, after: { body: replaced }, link })
    expect(replacedPreview.body.changes).toHaveLength(1)
    expect(replacedPreview.body.changes[0]).toMatchObject({ kind: 'changed', before: { line: 600 }, after: { line: 600 } })
    expect(replacedPreview.body.summary).toEqual({ before: 1200, after: 1200, added: 0, removed: 0, changed: 1 })
    expect(replacedPreview.body.alignment).toBe('lines')
    // A single insertion above the table limit is still exact after the common prefix and suffix are trimmed.
    const lines = before.split('\n')
    lines.splice(600, 0, 'inserted line')
    const insertedPreview = previewMail({ before: { body: before }, after: { body: lines.join('\n') }, link })
    expect(insertedPreview.body.changes).toEqual([{ kind: 'added', after: { line: 601, text: 'inserted line' } }])
    expect(insertedPreview.body.summary).toEqual({ before: 1200, after: 1201, added: 1, removed: 0, changed: 0 })
    expect(insertedPreview.body.alignment).toBe('lines')
    // A wholly rewritten body has no common ends, so the oversized middle honestly pairs by position.
    const rewritten = Array.from({ length: 1200 }, (_, index) => `other ${index + 1}`).join('\n')
    const rewrittenPreview = previewMail({ before: { body: before }, after: { body: rewritten }, link })
    expect(rewrittenPreview.body.alignment).toBe('position')
    expect(rewrittenPreview.body.summary).toEqual({ before: 1200, after: 1200, added: 0, removed: 0, changed: 1200 })
  })

  it('hashes and measures attachment content so a same-named file with new bytes is not read as unchanged', () => {
    const preview = previewMail({
      before: {
        attachments: [
          { name: 'a.txt', contentType: 'text/plain', content: 'one' },
          { name: 'b.bin', size: 4, digest: ' AAAA ' },
          { name: 'c.png', content: new Uint8Array([1, 2, 3]), inline: true },
        ],
      },
      after: {
        attachments: [
          { name: 'a.txt', contentType: 'text/plain; charset=utf-8', content: 'two' },
          { name: 'b.bin', size: 5, digest: 'aaaa' },
          { name: 'c.png', content: new Uint8Array([1, 2, 3]), inline: false },
          { name: 'd.txt', content: 'new' },
        ],
      },
      link,
    })
    expect(preview.attachments.changes.map(change => [change.kind, change.name, change.fields ?? []]))
      .toEqual([
        ['changed', 'a.txt', ['content', 'contentType']],
        ['changed', 'b.bin', ['size']],
        ['changed', 'c.png', ['inline']],
        ['added', 'd.txt', []],
      ])
    expect(preview.attachments.changes[0]!.before!.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.attachments.changes[0]!.after!.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.attachments.changes[0]!.before!.digest).not.toBe(preview.attachments.changes[0]!.after!.digest)
    expect(preview.attachments.changes[0]!.before!.size).toBe(3)
    expect(preview.attachments.changes[1]!.before!.digest).toBe('aaaa')
    expect(preview.attachments.changes[1]!.after!.digest).toBe('aaaa')
    expect(preview.attachments.summary).toEqual({ before: 3, after: 4, added: 1, removed: 0, changed: 3 })
    expect(preview.attachments.unverified).toEqual([])
  })

  it('does not call an attachment unchanged when only one revision can fingerprint it', () => {
    const preview = previewMail({
      before: { attachments: [{ name: 'x.pdf', size: 3 }, { name: 'y.pdf', size: 3 }] },
      after: { attachments: [{ name: 'x.pdf', size: 3, content: 'new' }, { name: 'y.pdf', size: 3 }] },
      link,
    })
    expect(preview.attachments.changes.map(change => [change.kind, change.name, change.fields ?? []]))
      .toEqual([['changed', 'x.pdf', ['content']]])
    expect(preview.attachments.unverified).toEqual(['x.pdf', 'y.pdf'])
    expect(preview.attachments.summary).toEqual({ before: 2, after: 2, added: 0, removed: 0, changed: 1 })
  })

  it('refuses malformed drafts and attachments as caller errors', () => {
    const base: MailDraft = { to: ['a@example.com'], subject: 'Hi', body: 'Body' }
    const bad = (before: unknown, after: unknown): unknown => ({ before, after, link })
    expect(() => previewMail(bad(base, base) as never)).not.toThrow()
    expect(() => previewMail(null as never)).toThrow(TypeError)
    expect(() => previewMail({ before: base, after: base, link: '' })).toThrow(TypeError)
    expect(() => previewMail({ before: null as never, after: base, link })).toThrow(TypeError)
    expect(() => previewMail(bad({ to: 'a@example.com' }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: [''] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: ['a@example.com, b@example.com'] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: ['Alice <a@example.com>, Bob <b@example.com>'] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: ['Alice <a@example.com>; Bob <b@example.com>'] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: ['a@example.com;b@example.com'] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: ['Alice'] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: ['Alice <a@example.com>\nb@example.com'] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: [{ name: 3, address: 'a@example.com' }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ to: [{ name: 'Alice <a@example.com>', address: 'b@example.com' }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ subject: 3 }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ subject: 'Hi\r\nBcc: eve@evil.test' }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ body: 3 }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: 'a.txt' }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: 'a.txt' }, { name: 'a.txt' }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: '' }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: 'a\r\n.txt' }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: 'a.txt', size: -1 }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: 'a.txt', size: 1.5 }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: 'a.txt', contentType: '' }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: 'a.txt', digest: '' }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: 'a.txt', content: 3 }] }, base) as never)).toThrow(TypeError)
    expect(() => previewMail(bad({ attachments: [{ name: 'a.txt', inline: 'yes' }] }, base) as never)).toThrow(TypeError)
  })

  it('returns plain data that survives a JSON round trip', () => {
    const preview = previewMail({ before: draft('draft-before.json'), after: draft('draft-after.json'), link })
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview)
  })
})