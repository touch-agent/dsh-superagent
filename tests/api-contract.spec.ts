/**
 * X-04: the management API has one source. These tests prove the contract covers every handler, the runtime
 * rejects invalid requests, the panel's request types follow the schema, and the committed JSON Schema artifact
 * is the one this contract renders today.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { PUBLIC_ROUTES, ROUTES, type RouteKey } from '@superagent/dsh/app/api-contract.ts'
import { parseBody, parseQuery } from '@superagent/dsh/app/api-parser.ts'
import { registerHttp, type RouteHandlers } from '@superagent/dsh/app/http.ts'
import type { ApiRequest } from '@superagent/dsh/app/api.ts'
import { renderApiSchema } from '../scripts/api-schema.ts'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type HandlerKeysMatch = Equal<keyof RouteHandlers, RouteKey>
const handlersMatchContract: HandlerKeysMatch = true

type Handler = (req: unknown, res: unknown) => Promise<void>
/** Mount the routes against an empty runtime, like `tests/http.spec.ts`, for requests rejected before business code. */
function mount(runtime: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>()
  const ctx = { webServer: { host: '127.0.0.1', port: 3082,
    register: (route: { kind: string; path: string; handler: Handler }) => { handlers.set(`${route.kind}:${route.path}`, route.handler); return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as never)
  return async (method: string, path: string, body?: unknown) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' },
      async *[Symbol.asyncIterator]() { yield* chunks } }
    await handlers.get('prefix:/orchestrator')!(req, { writeHead: (code: number) => { status = code },
      end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('has exactly one handler for every contract route', () => {
  expect(handlersMatchContract).toBe(true)
  expect(Object.keys(ROUTES).every(route => /^(GET|POST|PUT) \S/.test(route))).toBe(true)
  expect(PUBLIC_ROUTES.every(route => route in ROUTES)).toBe(true)
})

it('serves every contract route and nothing that is not in the contract', async () => {
  const call = mount()
  for (const route of Object.keys(ROUTES)) {
    const [method, path] = route.split(' ') as [string, string]
    const answer = await call(method, path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, 'x'))
    expect(answer.body.error).not.toBe('Unknown operation')
  }
  expect(await call('GET', 'not-a-route')).toMatchObject({ status: 404, body: { error: 'Unknown operation' } })
})

it('keeps the lenient query contract the panel and callers already rely on', () => {
  expect(parseQuery('GET tickets', {})).toEqual({ state: 'open', offset: 0, limit: 20 })
  expect(parseQuery('GET tickets', { state: 'bogus', origin: 'NOT A SLUG', offset: 'x', limit: '5000' })).toEqual(
    { state: 'open', offset: 0, limit: 1000 })
  expect(parseQuery('GET tasks/:id', { depth: '9' })).toEqual({ depth: 1, projects: 'active' })
  expect(parseQuery('GET tasks/:id', { depth: '3', projects: 'archived' })).toEqual({ depth: 3, projects: 'archived' })
  expect(parseQuery('GET tasks', { projects: 'bogus' })).toEqual({ depth: 1, projects: 'active' })
  expect(parseQuery('GET activity', { after: '', level: 'loud', limit: '500' })).toEqual({ after: 0, limit: 200 })
  expect(parseQuery('GET search', {})).toEqual({ q: '' })
  expect(parseQuery('GET threads', { filter: 'subscribed' })).toEqual({ filter: 'subscribed', offset: 0, limit: 20 })
  expect(parseQuery('GET prompts', {})).toEqual({ offset: 0 })
  expect(() => parseQuery('GET prompts', { revision: 'x' })).toThrow(z.ZodError)
  expect(() => parseQuery('GET prompts', { offset: 'x' })).toThrow(z.ZodError)
})

it('rejects invalid bodies and constrained path parameters with the old issue payload', async () => {
  expect(() => parseBody('POST tickets/:id/approve', {})).toThrow(z.ZodError)
  expect(() => parseBody('POST tickets/:id/approve', { reviewRevision: '' })).toThrow(z.ZodError)
  expect(() => parseBody('POST executor/pause', { paused: 'yes' })).toThrow(z.ZodError)
  try { parseBody('PUT settings/:block', { value: {}, revision: -1 }) } catch (error) {
    expect((error as z.ZodError).issues[0]?.path).toEqual(['revision'])
  }
  const call = mount({ settings: { pause: () => ({}) } })
  expect(await call('POST', 'executor/pause', { paused: 'yes' })).toMatchObject({ status: 400,
    body: { issues: [{ path: 'paused' }] } })
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400,
    body: { issues: [{ path: '' }] } })
  expect(await call('GET', 'prompts?revision=x')).toMatchObject({ status: 400, body: { issues: [{ path: 'revision' }] } })
})

it('derives the panel request type from the same schema', () => {
  const valid: ApiRequest<'GET tickets'> = { query: { state: 'ended', origin: 'conversation', limit: 10 } }
  // @ts-expect-error the filter list comes from the contract, not a second union
  const wrongFilter: ApiRequest<'GET tickets'> = { query: { state: 'bogus' } }
  // @ts-expect-error offset is a number in the contract
  const wrongType: ApiRequest<'GET tickets'> = { query: { offset: '0' } }
  const approval: ApiRequest<'POST tickets/:id/approve'> = { id: 't1', body: { reviewRevision: 'rev-1' } }
  // @ts-expect-error reviewRevision is required by the body schema
  const missingRevision: ApiRequest<'POST tickets/:id/approve'> = { id: 't1', body: {} }
  expect(valid.query?.state).toBe('ended')
  expect([wrongFilter, wrongType, approval, missingRevision]).toHaveLength(4)
})

it('checks the committed JSON Schema artifact against the contract', () => {
  const artifact = fileURLToPath(new URL('../packages/dsh/src/app/api.schema.json', import.meta.url))
  expect(readFileSync(artifact, 'utf8')).toBe(renderApiSchema(ROUTES))
})
