# Doc previewer fixtures

These files are fixed inputs: `tests/preview-doc.spec.ts` asserts the exact change list, so changing a file means
updating the expected result with it.

| Files | What they exercise |
| --- | --- |
| `handbook-before.md`, `handbook-after.md` | Markdown paragraphs, headings, lists, a changed paragraph with an inline redline, a moved list item, an added list item and a removed section |
| `notes-before.docx`, `notes-after.docx` | The same changes in a real Word package: Title and Heading1 paragraph styles, numbered-list paragraphs and body paragraphs |
| `broken-before.docx`, `broken-after.docx` | Text files with a `.docx` name; the previewer cannot read them as a ZIP and degrades to a line diff of the decoded text |
| `stored.docx` | A valid package whose `word/document.xml` is ZIP-stored rather than deflated |
| `textbox.docx` | A paragraph with an embedded text box; the box is not read and the paragraph around it survives |
| `no-document.docx`, `no-body.docx`, `malformed.docx` | A package without `word/document.xml`, a document with no body, and a document with an unclosed body; the structured parse failures |

The Word files were written by Python's `zipfile` with the minimal package parts a `.docx` needs
(`[Content_Types].xml`, `_rels/.rels` and `word/document.xml`). They are committed as binaries so the parser is tested
against a genuinely deflated document, not one the test itself packs.