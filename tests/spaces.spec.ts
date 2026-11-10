/** The space model: canonical locators, write leases, flat child directories, and legacy display. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ticket } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { SpaceLeases, locatorKeyOf, spaceName, spaceOf } from '@superagent/dsh/app/spaces.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

const roots: string[] = []
const temp = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'spaces-test-'))
  roots.push(directory)
  return directory
}
const fake = (id: string, directory: string, extra: Partial<Ticket> = {}): Ticket => ({
  id, title: `Ticket ${id}`, form: 'tracked', execution: { name: `${id}-abc123def456`, directory, assignment: '' },
  assignments: [], inputs: [], undelivered: [], channels: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  origin: { triggerId: 'tr1' }, ...extra,
} as Ticket)

describe('space locator and projection', () => {
  it('canonicalizes the parent so two spellings of one directory are one space', async () => {
    const directory = temp(), real = join(directory, 'real'), link = join(directory, 'link')
    mkdirSync(real); symlinkSync(real, link)
    expect(await locatorKeyOf(join(link, 'worktree'))).toBe(join(realpathSync(real), 'worktree'))
  })

  it('removes the ticket suffix from a display name but keeps a child suffix', () => {
    expect(spaceName('fix-login-abc123def456', '/srv/work/fix-login-abc123def456')).toBe('fix-login')
    expect(spaceName('fix-login-abc123def456-child-1', '/srv/work/fix-login-abc123def456-child-1')).toBe('fix-login-child-1')
  })

  it('marks a child directory nested inside its parent as legacy without moving it', async () => {
    const store = new Store(join(temp(), 'state.sqlite'))
    const parentDir = join(temp(), 'parent-abc123def456'), childDir = join(parentDir, 'child-1')
    mkdirSync(childDir, { recursive: true })
    const parent = fake('parent', parentDir), child = fake('child', childDir, { parentTicketId: 'parent', rootTicketId: 'parent',
      execution: { name: 'parent-abc123def456-child-1', directory: childDir, assignment: '' } })
    const space = spaceOf(store, child, { parent })
    expect(space).toMatchObject({ name: 'parent-child-1', state: 'legacy', legacy: true })
    expect(space).not.toHaveProperty('path')
    store.close()
  })

  it('gives a lightweight Ticket no space', () => {
    const store = new Store(join(temp(), 'state.sqlite'))
    expect(spaceOf(store, fake('light', '/srv/work/light', { form: 'lightweight' }))).toBeUndefined()
    store.close()
  })
})

describe('space leases', () => {
  let directory: string, store: Store
  beforeEach(() => { directory = temp(); store = new Store(join(directory, 'state.sqlite')) })
  afterEach(() => { store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  it('reserves before prepare, activates after verification, and releases at the end', async () => {
    const leases = new SpaceLeases(store, 10), ticket = fake('t1', join(directory, 't1'))
    const reserved = await leases.reserve({ ticket, live: () => false })
    expect(reserved.lease).toMatchObject({ ticketId: 't1', state: 'reserved', epoch: 1 })
    const active = leases.activate(reserved.lease!)
    expect(active.state).toBe('active')
    expect(leases.current((await locatorKeyOf(join(directory, 't1'))))).toMatchObject({ state: 'active', epoch: 1 })
    leases.release('t1', join(directory, 't1'))
    expect(leases.current((await locatorKeyOf(join(directory, 't1'))))).toBeUndefined()
    expect(leases.all()).toEqual([expect.objectContaining({ state: 'released', releasedAt: expect.any(String) })])
    // Releasing again is a no-op, not a second history row.
    leases.release('t1', join(directory, 't1'))
    expect(leases.all()).toHaveLength(1)
  })

  it('lets the same Ticket re-enter its lease and queues a different live Ticket', async () => {
    const leases = new SpaceLeases(store, 10), directoryOfOne = join(directory, 'one')
    const first = fake('t1', directoryOfOne), second = fake('t2', directoryOfOne)
    const one = await leases.reserve({ ticket: first, live: () => false })
    const again = await leases.reserve({ ticket: first, live: () => false })
    expect(again.lease).toMatchObject({ epoch: one.lease!.epoch, ticketId: 't1' })
    const held = await leases.reserve({ ticket: second, live: () => false })
    expect(held.lease).toBeUndefined()
    expect(held.heldBy).toBeDefined()
    expect(leases.all()).toHaveLength(1)
  })

  it('reserves a locator once under concurrent launches', async () => {
    const leases = new SpaceLeases(store, 10), target = join(directory, 'shared')
    const results = await Promise.all([leases.reserve({ ticket: fake('a', target), live: () => false }),
      leases.reserve({ ticket: fake('b', target), live: () => false })])
    expect(results.filter(result => result.lease)).toHaveLength(1)
    expect(leases.all()).toHaveLength(1)
  })

  it('takes over a stale lease only when its holder has no live Session', async () => {
    const target = join(directory, 'held')
    const old = new SpaceLeases(store, 1)
    expect((await old.reserve({ ticket: fake('old', target), live: () => false })).lease).toBeDefined()
    const current = new SpaceLeases(store, 2)
    expect((await current.reserve({ ticket: fake('new', target), live: () => false })).lease).toMatchObject({ ticketId: 'new', epoch: 2 })
    expect(current.all().map(row => row.state).sort()).toEqual(['reserved', 'stale'])
    // A live holder is never silently preempted, even after a restart.
    const other = new SpaceLeases(store, 3)
    expect((await other.reserve({ ticket: fake('third', target), live: () => true })).lease).toBeUndefined()
  })

  it('gives a resuming Ticket a fresh lease after its own lease went stale', async () => {
    const target = join(directory, 'resume')
    const old = new SpaceLeases(store, 1)
    expect((await old.reserve({ ticket: fake('t1', target), live: () => false })).lease).toMatchObject({ epoch: 1 })
    const resumed = new SpaceLeases(store, 2)
    expect((await resumed.reserve({ ticket: fake('t1', target), live: () => false })).lease).toMatchObject({ ticketId: 't1', epoch: 2, state: 'reserved' })
    expect(resumed.current(await locatorKeyOf(target))).toMatchObject({ ticketId: 't1', epoch: 2, state: 'reserved' })
    expect(resumed.all().map(row => row.state).sort()).toEqual(['reserved', 'stale'])
  })
})

describe('spaces in the runtime', () => {
  let h: Host
  beforeEach(async () => { h = await startRuntime() })
  afterEach(async () => { await h.stop() })

  it('releases the lease when prepare fails', async () => {
    const settings = h.runtime.store.settings()
    h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, prepare: 'false' } })
    h.hooks.prepareExit = 1
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await h.runtime.idle()
    const rows = h.runtime.spaces.all().filter(row => row.ticketId === ticket.id)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(row => row.state === 'released')).toBe(true)
    expect(h.runtime.store.tickets.get(ticket.id)?.execution?.directory).toBe(ticket.execution!.directory)
  })

  it('releases the lease when a person ends the Ticket', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一'))
    expect(h.runtime.spaces.all().filter(row => row.ticketId === ticket.id).map(row => row.state)).toEqual(['active'])
    await h.runtime.engine.stopTicket(ticket.id)
    await h.runtime.idle()
    expect(h.runtime.spaces.all().filter(row => row.ticketId === ticket.id).map(row => row.state)).toEqual(['released'])
  })

  it('places a child directory beside its root, not inside its parent', async () => {
    const { ticket } = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const child = h.runtime.engine.delegate(ticket.id, { goal: 'separate the login helper', title: 'Login helper' })
    await h.runtime.idle()
    expect(dirname(child.execution!.directory)).toBe(dirname(ticket.execution!.directory))
    expect(basename(child.execution!.directory)).toBe(`${ticket.execution!.name}-child-1`)
  })

  it('marks an old-process lease stale on restart when its holder is not live', async () => {
    await h.stop()
    h = await startRuntime(store => {
      store.db.prepare(`INSERT INTO space_lease (locator_key, ticket_id, process_epoch, epoch, state, reserved_at, updated_at)
        VALUES (?, ?, 1, 1, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`).run('/srv/work/old', 'gone')
    })
    expect(h.runtime.spaces.all()).toEqual([expect.objectContaining({ locatorKey: '/srv/work/old', state: 'stale' })])
    // A stale row stays visible to E2 even though it no longer owns the locator.
    expect(h.runtime.spaces.current('/srv/work/old')).toMatchObject({ ticketId: 'gone', state: 'stale' })
  })
})