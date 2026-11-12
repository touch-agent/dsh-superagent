/**
 * Runtime validation from the same JSON Schema contract the types come from.
 *
 * Query fields keep the pre-existing lenient behavior: a value is coerced to the schema's number type, an invalid
 * value falls back to the schema default (or is omitted), a list size above `x-dsh-clamp` is clamped, and unknown
 * keys are dropped. Bodies and constrained path parameters stay strict and raise `ZodError`, which `http.ts` maps
 * to the same 400 payload as before.
 */
import { z } from 'zod'
import { ROUTES, type BodyInput, type QueryOutput, type RouteKey, type RouteParams, type Schema } from './api-contract.ts'

type Contract = { params?: Readonly<Record<string, Schema>>; query?: Schema; body?: Schema }
const validators = new WeakMap<object, z.ZodType>()
function validator(schema: Schema): z.ZodType {
  let compiled = validators.get(schema)
  if (!compiled) { compiled = z.fromJSONSchema(schema as never); validators.set(schema, compiled) }
  return compiled
}
const contract = (route: RouteKey): Contract => ROUTES[route] as Contract
/** Coerce a query scalar the way `z.coerce` did, then validate it against the field's schema. */
function queryValue(schema: Schema, raw: string | undefined, name: string): unknown {
  if (raw === undefined) return schema.default
  let value: unknown = raw
  if (schema.type === 'integer' || schema.type === 'number') value = Number(raw)
  else if (schema.type === 'boolean') value = raw === 'true' ? true : raw === 'false' ? false : raw
  const parsed = validator(schema).safeParse(value)
  if (!parsed.success) {
    if (schema['x-dsh-strict']) throw new z.ZodError(parsed.error.issues.map(issue => ({ ...issue, path: [name, ...issue.path] })))
    return schema.default
  }
  const clamp = schema['x-dsh-clamp']
  return typeof clamp === 'number' && typeof parsed.data === 'number' ? Math.min(parsed.data, clamp) : parsed.data
}
/** Parse a route's query string; never throws, because a malformed query field keeps its old fallback. */
export function parseQuery<K extends RouteKey>(route: K, raw: Readonly<Record<string, string>>): QueryOutput<K> {
  const { query } = contract(route)
  if (!query?.properties) return {} as QueryOutput<K>
  const parsed: Record<string, unknown> = {}
  const issues: z.ZodError['issues'] = []
  for (const [name, schema] of Object.entries(query.properties)) {
    try {
      const value = queryValue(schema, raw[name], name)
      if (value !== undefined) parsed[name] = value
    } catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      issues.push(...error.issues)
    }
  }
  if (issues.length) throw new z.ZodError(issues)
  return parsed as QueryOutput<K>
}
/** Parse a decoded path parameter object; a schema-constrained segment raises `ZodError` like the old route parser. */
export function parseParams<K extends RouteKey>(route: K, raw: Readonly<Record<string, string>>): RouteParams<K> {
  const { params } = contract(route)
  const parsed: Record<string, string> = { ...raw }
  for (const [name, schema] of Object.entries(params ?? {})) {
    if (raw[name] !== undefined) parsed[name] = validator(schema).parse(raw[name]) as string
  }
  return parsed as RouteParams<K>
}
/** Parse a JSON body lazily, at the point the handler used to call its zod schema. */
export function parseBody<K extends RouteKey>(route: K, value: unknown): BodyInput<K> {
  const { body } = contract(route)
  return (body ? validator(body).parse(value) : undefined) as BodyInput<K>
}
