---
'@superagent/dsh': minor
---

Add the sheet previewer: CSV and `.xlsx` workbooks are read as sparse cells and compared by row and column. A formula change is reported as `formula` even when its cached value moved with it, and a cached value under the same formula is reported as `value`, so a formula edit is never counted as a numeric edit. Inserted or removed rows and columns are listed as structure instead of being spread across every later cell, shared formulas are expanded for their followers, and formulas are compared by cell-relative references so a copied formula shifted by an inserted row is not a formula edit. A workbook that cannot be parsed degrades to a generic line diff of the best available text and keeps the original link and the coded parse failure (D4). The previewer registry that stores the preview and gives the Deliverable its `PreviewRef` comes with the review surface.
