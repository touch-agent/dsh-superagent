/**
 * Type-only management API contract between the web panel and host routes, imported by the panel without bundling
 * host code. The HTTP surface itself is declared once in `api-contract.ts`; this file only turns that contract and
 * the handlers' return types into the request and response types the panel uses.
 */
import type { BodyInput, QueryInput, RouteContracts, RouteKey, RouteParams } from './api-contract.ts'
import type { RouteHandlers } from './http.ts'
export { THREAD_FILTERS, TICKET_FILTERS } from './api-filters.ts'
export type { ThreadFilter, TicketFilter, TicketOrigin } from './api-filters.ts'
export type { RouteParams } from './api-contract.ts'

type Empty = Record<never, never>
type QuerySlot<K extends RouteKey> = RouteContracts[K] extends { query: unknown }
  ? RouteContracts[K] extends { requiredQuery: true } ? { query: QueryInput<K> } : { query?: QueryInput<K> }
  : Empty
type BodySlot<K extends RouteKey> = RouteContracts[K] extends { body: unknown } ? { body: BodyInput<K> } : Empty
/**
 * Every route, its parameters, query, body and response. The request half comes from `api-contract.ts`; the response
 * half is the handler's own return type, so a view shape is never written down twice.
 */
export type Api = { [K in RouteKey]: QuerySlot<K> & BodySlot<K> & RouteParams<K> & {
  response: Awaited<ReturnType<RouteHandlers[K]>>
} }
export type ApiRequest<K extends keyof Api> = Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
/** One Approval waiting for a person, as `GET overview` returns it. */
export type ApprovalRow = ApiResponse<'GET overview'>['approvals'][number]
