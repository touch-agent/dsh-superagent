/** Renders the management API's published JSON Schema artifact from the route contract. */
interface RouteShape {
  params?: Readonly<Record<string, unknown>>
  query?: unknown
  requiredQuery?: true
  body?: unknown
  public?: true
}
/**
 * One JSON Schema document keyed by `METHOD path`. Request slots come straight from the contract; response shapes
 * stay in the route handlers and are deliberately absent here.
 */
export function renderApiSchema(routes: Readonly<Record<string, RouteShape>>): string {
  const properties: Record<string, unknown> = {}
  for (const [route, contract] of Object.entries(routes)) {
    const slots: Record<string, unknown> = {}
    const required: string[] = []
    if (contract.params) {
      slots.params = { type: 'object', additionalProperties: false, properties: contract.params, required: Object.keys(contract.params) }
      required.push('params')
    }
    if (contract.query) {
      slots.query = contract.query
      if (contract.requiredQuery) required.push('query')
    }
    if (contract.body) {
      slots.body = contract.body
      required.push('body')
    }
    properties[route] = { type: 'object', additionalProperties: false, properties: slots,
      ...required.length ? { required } : {}, ...contract.public ? { 'x-public': true } : {} }
  }
  return `${JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/touch-agent/dsh-superagent/api.schema.json',
    title: 'dsh-superagent management API request contract',
    description: 'Generated from packages/dsh/src/app/api-contract.ts by scripts/check-api-schema.mjs; do not hand-edit. '
      + 'Response shapes are the route handlers\' return types, not part of this document.',
    type: 'object',
    additionalProperties: false,
    properties,
    required: Object.keys(routes),
  }, null, 2)}\n`
}
