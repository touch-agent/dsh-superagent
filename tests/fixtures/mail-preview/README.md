# Mail previewer fixtures

These files are fixed inputs: `tests/preview-mail.spec.ts` asserts the exact four-section result, so changing a file
means updating the expected result with it.

| Files | What they exercise |
| --- | --- |
| `draft-before.json`, `draft-after.json` | One draft pair with a To recipient moved to Bcc (the accident-prone change), a To recipient added, a Bcc recipient added, an unchanged To and Cc recipient, a changed subject, one changed body line, a same-named attachment whose digest and size changed, a removed attachment and an added attachment |

The draft is JSON, not raw MIME: the mail previewer takes the structured draft a Source adapter hands it, and the body
is the readable text. `tests/preview-mail.spec.ts` builds byte-level attachment and address cases inline where a fixed
file would not add anything.

The fixture deliberately leaves Bob in To before and Bcc after, so the change is one `changed` recipient with
`before: [to]` and `after: [bcc]`, never a removal and a hidden addition. The audience keeps Bob and Dave under Bcc, and
the warnings name the hidden and moved recipients.