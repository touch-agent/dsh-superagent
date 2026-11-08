# Sheet previewer fixtures

These files are fixed inputs: `tests/preview-sheet.spec.ts` asserts the exact change list, so changing a file means
updating the expected result with it.

| Files | What they exercise |
| --- | --- |
| `ledger-before.csv`, `ledger-after.csv` | CSV quoting, a plain value change, a formula change, an added cell, a removed cell and an added row |
| `ledger-before.xlsx`, `ledger-after.xlsx` | A real workbook with two sheets before and two after: shared strings, an inline string, a shared formula expanded from its master, a formula change with the same cached value, a formula change whose cached value also moved, a value change under the same formula, a plain value change, an added row, a removed column, and a whole sheet added and removed |
| `stored.xlsx` | A valid package whose worksheet XML is ZIP-stored rather than deflated |
| `empty-shared-string.xlsx` | Shared strings include a self-closing empty `<si/>`, so later string indices must not shift |
| `bad-shared-string.xlsx` | A cell names a shared-string index past the table; the workbook is a parse failure rather than silently empty |
| `shared-formula-up.xlsx` | A shared-formula follower appears above its master, so resolution must not depend on document order |
| `large-before.xlsx`, `large-after.xlsx` | Two 10,001-row sheets with one changed value, for the under-two-second acceptance |
| `broken-before.xlsx`, `broken-after.xlsx` | Text files with an `.xlsx` name; the previewer cannot read them as a ZIP and degrades to a line diff of the decoded text |
| `no-workbook.xlsx`, `missing-sheet.xlsx`, `missing-relationship.xlsx` | A package without `xl/workbook.xml`, a workbook that names a sheet the archive does not hold, and a workbook whose relationships part does not name the sheet it lists; the three structured parse failures |

The `.xlsx` files were written by Python's `zipfile` with the minimal package parts a workbook needs
(`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`,
`xl/styles.xml` and the worksheet parts). They are committed as binaries so the parser is tested against a genuinely
deflated workbook, not one the test itself packs. The reader expects the standard Excel package layout
(`xl/workbook.xml` and its relationships); a package that names the workbook part elsewhere is a parse failure, not a
silent empty preview.

The parser compares stored cell values; number formats and styles are presentation and are not applied, and a chart
sheet is skipped because it has no cells. A formula is compared by its cell-relative references, so a row insertion
that shifts a copied formula does not read as a formula edit. A column insertion that changes the relative column
offset between the formula and its references does read as a formula edit, because the formula text itself changed; a
changed reference or operator still does.
Whole-column and whole-row references (`A:A`, `1:1`) are not shifted by a shared formula; they keep the text they were
written with.