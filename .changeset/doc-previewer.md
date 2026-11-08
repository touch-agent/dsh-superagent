---
'@superagent/dsh': minor
---

Add the doc previewer: Markdown and Word `.docx` documents are read as paragraph blocks and compared into added, removed, changed (with an inline token comparison) and moved paragraphs. A document that cannot be parsed degrades to a generic line diff of the best available text, keeps the original link and names the coded parse failure (D4), so a review can still fall back to what a person can read. The previewer registry that stores the preview and gives the Deliverable its `PreviewRef` comes with the review surface.