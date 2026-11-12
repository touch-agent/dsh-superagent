/**
 * The single source of the management API's HTTP surface: every route, its path parameters, query and body,
 * written as JSON Schema.
 *
 * `api.ts` derives the route keys, request types and panel binding from this file at compile time;
 * `api-parser.ts` turns the same schemas into the runtime validators; `http.ts` keys its handler table by the
 * route names below. `packages/dsh/src/app/api.schema.json` is generated from this contract and checked in CI.
 *
 * Response shapes are not duplicated here: each handler's return type stays the one response definition, and
 * `Api` reads it from the handler table. A response schema beside every handler would be a second truth.
 */
import type { FromSchema, JSONSchema } from 'json-schema-to-ts'
import { ACTION_LEVELS } from '@superagent/kernel'
import { THREAD_FILTERS, TICKET_FILTERS } from './api-filters.ts'
import type { PromptConfig } from './prompts.ts'

/** The JSON Schema subset this contract uses: object properties, primitives, enums, patterns and bounds. */
export interface Schema {
  type?: 'object' | 'string' | 'integer' | 'number' | 'boolean' | 'array'
  properties?: Readonly<Record<string, Schema>>
  required?: readonly string[]
  items?: Schema
  enum?: readonly (string | number | boolean)[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  additionalProperties?: boolean | Schema
  /** A query value is replaced by this when the field is absent or invalid; the parser, not the schema, applies it. */
  default?: unknown
  /** Query-only: clamp an accepted integer above this bound instead of treating the value as invalid. */
  'x-dsh-clamp'?: number
  /** Query-only: an invalid value raises `ZodError` instead of falling back, preserving the old strict fields. */
  'x-dsh-strict'?: true
}

/** One route's request slots. The route key carries the method and path, as the panel's `Api` types already do. */
interface RouteSpec {
  readonly params?: Readonly<Record<string, Schema>>
  readonly query?: Schema
  /** A query is optional in the client contract unless this is set (`GET search` is the only required one). */
  readonly requiredQuery?: true
  readonly body?: Schema
  readonly public?: true
}

const Offset = { type: 'integer', minimum: 0, default: 0 } as const satisfies Schema
/** A list size: non-positive or non-integer values fall back, and a large accepted value is clamped. */
const limit = (fallback: number, clamp: number) =>
  ({ type: 'integer', minimum: 1, default: fallback, 'x-dsh-clamp': clamp }) as const satisfies Schema

const TicketsQuery = { type: 'object', properties: {
  state: { type: 'string', enum: TICKET_FILTERS, default: 'open' },
  origin: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
  offset: Offset,
  limit: limit(20, 1000),
} } as const satisfies Schema
const ThreadsQuery = { type: 'object', properties: {
  filter: { type: 'string', enum: THREAD_FILTERS, default: 'subscribed' },
  offset: Offset,
  limit: limit(20, 1000),
} } as const satisfies Schema
const TasksQuery = { type: 'object', properties: {
  depth: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
} } as const satisfies Schema
const ThreadQuery = { type: 'object', properties: {
  limit: limit(50, 100),
  before: { type: 'string' },
  around: { type: 'string' },
} } as const satisfies Schema
const DecisionsQuery = { type: 'object', properties: {
  kind: { type: 'string', default: '' },
  window: { type: 'string', enum: ['24h'] },
  offset: Offset,
  limit: limit(30, 200),
} } as const satisfies Schema
const ActivityQuery = { type: 'object', properties: {
  after: { type: 'integer', minimum: 0, default: 0 },
  limit: limit(50, 200),
  level: { type: 'string', enum: ['quiet', 'feed', 'notice'] },
} } as const satisfies Schema
const SearchQuery = { type: 'object', properties: { q: { type: 'string', default: '' } },
  required: ['q'] } as const satisfies Schema
const PromptsQuery = { type: 'object', properties: {
  revision: { type: 'integer', minimum: 0, 'x-dsh-strict': true },
  offset: { type: 'integer', minimum: 0, default: 0, 'x-dsh-strict': true },
} } as const satisfies Schema

const ReviewApproval = { type: 'object', properties: { reviewRevision: { type: 'string', minLength: 1 } },
  required: ['reviewRevision'] } as const satisfies Schema
const ApprovalDecision = { type: 'object', properties: {
  level: { type: 'string', enum: ACTION_LEVELS },
} } as const satisfies Schema
const ExecutorPause = { type: 'object', properties: { paused: { type: 'boolean' } },
  required: ['paused'] } as const satisfies Schema
/** The settings value is validated by its block owner; the route only fixes the save envelope. */
const SaveRequest = { type: 'object', properties: { value: {}, revision: { type: 'integer', minimum: 0 } },
  required: ['revision'] } as const satisfies Schema
/** Prompt configuration is validated by `Prompts.validate`; the route only fixes the envelope. */
const PromptsSave = { type: 'object', properties: { config: {}, baseRevision: { type: 'integer', minimum: 0 } },
  required: ['baseRevision'] } as const satisfies Schema
const BlockParams = { block: { type: 'string',
  pattern: '^(?:policy|eval|dispatch|executor|source:[a-z][a-z0-9-]*)$' } } as const satisfies Record<string, Schema>
const ProfileParams = { id: { type: 'string', pattern: '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' } } as const satisfies Record<string, Schema>
/** A profile draft is validated by `Profiles.validateDraft`; the route fixes only the envelope and an audit reason. */
const profileReason = { type: 'string', minLength: 1, maxLength: 500 } as const satisfies Schema
const ProfileCreate = { type: 'object', properties: { profile: {}, reason: profileReason },
  required: ['profile', 'reason'] } as const satisfies Schema
const ProfileRevision = { type: 'object', properties: { profile: {}, baseRevision: { type: 'integer', minimum: 0 },
  reason: profileReason }, required: ['profile', 'baseRevision', 'reason'] } as const satisfies Schema
const ProfileActivate = { type: 'object', properties: { revision: { type: 'integer', minimum: 1 },
  reason: profileReason }, required: ['revision', 'reason'] } as const satisfies Schema
const ProfileEnabled = { type: 'object', properties: { enabled: { type: 'boolean' }, reason: profileReason },
  required: ['enabled', 'reason'] } as const satisfies Schema
const ProfileRetire = { type: 'object', properties: { revision: { type: 'integer', minimum: 1 },
  reason: profileReason }, required: ['revision', 'reason'] } as const satisfies Schema
const ProfileConfig = { type: 'object', properties: { enabled: { type: 'boolean' },
  resolve: { type: 'string', enum: ['snapshot', 'legacy'] }, telemetry: { type: 'boolean' },
  defaultProfile: { type: 'string', pattern: '^$|^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$' },
  reason: profileReason }, required: ['reason'] } as const satisfies Schema

export const ROUTES = {
  'GET state': { public: true },
  'GET overview': {},
  'GET metrics': {},
  'GET activity': { query: ActivityQuery },
  'GET tasks': {},
  'GET goals': {},
  'GET goals/:id': {},
  'GET spaces': {},
  'GET contexts/groups': {},
  'GET profiles': {},
  'GET profiles/:id': { params: ProfileParams },
  'GET profiles/:id/metrics': { params: ProfileParams },
  'POST profiles': { body: ProfileCreate },
  'POST profiles/:id/revisions': { params: ProfileParams, body: ProfileRevision },
  'POST profiles/:id/activate': { params: ProfileParams, body: ProfileActivate },
  'POST profiles/:id/enabled': { params: ProfileParams, body: ProfileEnabled },
  'POST profiles/:id/retire': { params: ProfileParams, body: ProfileRetire },
  'POST profiles/:id/rollback': { params: ProfileParams, body: { type: 'object', properties: { reason: profileReason },
    required: ['reason'] } },
  'PUT profiles/config': { body: ProfileConfig },
  'GET tasks/:id': { query: TasksQuery },
  'GET search': { query: SearchQuery, requiredQuery: true },
  'GET sources': { public: true },
  'GET settings': { public: true },
  'POST sources/:id/labels': {},
  'GET threads': { query: ThreadsQuery },
  'GET threads/:key': { query: ThreadQuery },
  'POST threads/:key/unsubscribe': {},
  'GET triggers/:id/trace': {},
  'POST triggers/:id/requeue': {},
  'GET decisions': { query: DecisionsQuery },
  'POST decisions/:id/dismiss': {},
  'GET tickets': { query: TicketsQuery },
  'GET tickets/:id': {},
  'GET tickets/:id/timeline': {},
  'POST tickets/:id/retry': { public: true },
  'POST tickets/:id/stop': { public: true },
  'POST tickets/:id/approve': { body: ReviewApproval, public: true },
  'POST outbox/:id/recall': { public: true },
  'POST approvals/:id/approve': { body: ApprovalDecision, public: true },
  'POST approvals/:id/deny': { public: true },
  'POST executor/pause': { body: ExecutorPause, public: true },
  'PUT settings/:block': { params: BlockParams, body: SaveRequest, public: true },
  'GET policy/history': {},
  'POST policy-sync/:id': { public: true },
  'POST setup/check': { public: true },
  'GET models': {},
  'GET prompts': { query: PromptsQuery, public: true },
  'PUT prompts': { body: PromptsSave, public: true },
  'POST prompts/preview': { body: {} },
} as const satisfies Readonly<Record<string, RouteSpec>>

export type RouteContracts = typeof ROUTES
export type RouteKey = keyof RouteContracts
type Empty = Record<never, never>
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : Empty
/** The decoded path parameters a route key names, as the panel's request type and the handlers use them. */
export type RouteParams<K extends RouteKey> = Params<Path<K>>
/** The routes agents may rely on, documented in the Management API table of `docs/006-deployment.md`. */
export const PUBLIC_ROUTES: readonly RouteKey[] = (Object.keys(ROUTES) as RouteKey[])
  .filter(route => 'public' in ROUTES[route] && ROUTES[route].public === true)

type Properties<S> = S extends { properties: infer P extends Readonly<Record<string, JSONSchema>> } ? P : Empty
type RequiredKeys<S> = S extends { required: infer R extends readonly string[] } ? R[number] : never
type DefaultedKeys<S> = { [K in keyof Properties<S>]:
  Properties<S>[K] extends { default: unknown } ? K : never }[keyof Properties<S>]
type ValueAt<S, K extends keyof Properties<S>> = Properties<S>[K] extends JSONSchema ? FromSchema<Properties<S>[K]> : never
/** A query or body as the panel may send it: optional unless the schema lists it as required. */
type InputObject<S> = { [K in keyof Properties<S> as K extends RequiredKeys<S> ? K : never]: ValueAt<S, K> }
  & { [K in keyof Properties<S> as K extends RequiredKeys<S> ? never : K]?: ValueAt<S, K> }
/** A parsed query as a handler receives it: a schema default makes the field always present. */
type OutputObject<S> = { [K in keyof Properties<S> as K extends RequiredKeys<S> | DefaultedKeys<S> ? K : never]: ValueAt<S, K> }
  & { [K in keyof Properties<S> as K extends RequiredKeys<S> | DefaultedKeys<S> ? never : K]?: ValueAt<S, K> }

export type QuerySchema<K extends RouteKey> = RouteContracts[K] extends { query: infer S } ? S
  : { readonly type: 'object'; readonly properties: Empty }
export type BodySchema<K extends RouteKey> = RouteContracts[K] extends { body: infer S } ? S : never
export type QueryInput<K extends RouteKey> = InputObject<QuerySchema<K>>
export type QueryOutput<K extends RouteKey> = OutputObject<QuerySchema<K>>
/**
 * Opaque payloads whose validator lives in business code keep the TypeScript type they already had; the envelope
 * around them still comes from the route schema. This binds a field type, it does not restate the request.
 */
interface OpaqueBodies {
  'PUT settings/:block': { value: unknown }
  'PUT prompts': { config: PromptConfig }
  'POST profiles': { profile: unknown }
  'POST profiles/:id/revisions': { profile: unknown }
}
export type BodyInput<K extends RouteKey> = K extends 'POST prompts/preview' ? PromptConfig
  : BodySchema<K> extends JSONSchema
    ? InputObject<BodySchema<K>> & (K extends keyof OpaqueBodies ? OpaqueBodies[K] : unknown)
    : never
