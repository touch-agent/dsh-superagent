# Sheet previewer fixtures

These files are fixed inputs: `tests/preview-sheet.spec.ts` asserts the exact change list, so changing a file means
updating the expected result with it.

| Files | What they exercise |
| --- | --- |
| `ledger-before.csv`, `ledger-after.csv` | CSV quoting, a plain value change, a formula change, an added cell, a removed cell and an added row |
| `ledger-before.xlsx`, `ledger-after.xlsx` | A real workbook with two sheets before and two after: shared strings, an inline string, a shared formula expanded from its master, a formula change with the same cached value, a formula change whose cached value also moved, a value change under the same formula, a plain value change, an added row, a removed column, and a whole sheet added and removed |
| `stored.xlsx` | A valid package whose worksheet XML is ZIP-stored rather than deflated |
| `large-before.xlsx`, `large-after.xlsx` | Two 10,001-row sheets with one changed value, for the under-two-second acceptance |
| `broken-before.xlsx`, `broken-after.xlsx` | Text files with an `.xlsx` name; the previewer cannot read them as a ZIP and degrades to a line diff of the decoded text |
| `no-workbook.xlsx`, `missing-sheet.xlsx` | A package without `xl/workbook.xml`, and a workbook that names a sheet the archive does not hold; the two structured parse failures |

The `.xlsx` files were written by Python's `zipfile` with the minimal package parts a workbook needs
(`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/sharedStrings.xml`,
`xl/styles.xml` and the worksheet parts). They are committed as binaries so the parser is tested against a genuinely
deflated workbook, not one the test itself packs.

The parser compares stored cell values; number formats and styles are presentation and are not applied, and a chart
sheet is skipped because it has no cells. A formula is compared by its cell-relative references, so a row or column
insertion that shifts a copied formula does not read as a formula edit; a changed reference or operator still does.