---
'@superagent/dsh': patch
---

Make the management API's request contract one JSON Schema source. The route
table, query/path/body types and the panel's request types now derive from
`api-contract.ts`; runtime parsing keeps the existing lenient query behavior and
the strict 400 issue payload. A generated JSON Schema artifact is committed and
checked by `pnpm check:api`, while response types stay derived from the route
handlers. No request or response shape, error code or business rule changes. The runtime entry grows by about 4.6 kB for the schema compiler, so its bundle budget moves from 814000 to 820000 bytes.
