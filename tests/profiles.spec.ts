import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProfileRunEffective, Ticket } from '@superagent/kernel'
import { KV } from '@superagent/dsh/kv.ts'
import { Store } from '@superagent/dsh/app/store.ts'
import { Prompts } from '@superagent/dsh/app/prompts.ts'
import { Profiles, ProfileConflict, ProfileDraftSchema, runEffective, type ProfileDraft } from '@superagent/dsh/app/profiles.ts'
import { profileWorkTools } from '@superagent/dsh/app/sessions.ts'
import { profileMetrics } from '@superagent/dsh/app/profile-metrics.ts'
import { WORK_TOOL_NAMES } from '@superagent/dsh/app/work-tools.ts'

const NOW = '2026-11-10T12:00:00.000Z'
const draft = (extra: Partial<ProfileDraft> = {}): ProfileDraft => ({ id: 'worker-docs', title: 'Docs worker',
  description: 'Tests and documentation only.', model: { mode: 'pinned', provider: 'deepseek', model: 'deepseek-v4.1' },
  tools: { mode: 'list', names: ['read', 'grep', 'bash'] }, prompt: { mode: 'pinned', revision: 0 }, ...extra } as ProfileDraft)
function withProfiles(body: (store: Store, profiles: Profiles, prompts: Prompts) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'profiles-'))
  const store = new Store(join(dir, 'db'))
  try {
    const prompts = new Prompts(store, () => 100_000, () => undefined, () => false)
    const profiles = new Profiles({ store, prompts, now: () => NOW })
    body(store, profiles, prompts)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
}
const ticket = (id: string, profile?: ReturnType<Profiles['bindRoot']>): Ticket => ({ id, form: 'tracked', assignments: [], inputs: [],
  createdAt: NOW, updatedAt: NOW, origin: { triggerId: 'trigger' }, ...(profile ? { profile } : {}) } as unknown as Ticket)

it('seeds exactly the compatible worker-default@1 and keeps it idempotent', () => {
  withProfiles((store, profiles) => {
    const builtin = profiles.seed()
    expect(builtin).toMatchObject({ id: 'worker-default', revision: 1, role: 'worker', model: { mode: 'inherit' },
      tools: { mode: 'inherit' }, prompt: { mode: 'live' }, provenance: { source: 'builtin' } })
    expect(profiles.ids()).toEqual(['worker-default'])
    expect(profiles.seed()).toEqual(builtin)
    expect(profiles.head('worker-default')).toMatchObject({ activeRevision: 1, retiredRevisions: [] })
    expect(profiles.list()).toMatchObject([{ id: 'worker-default', activeRevision: 1, moving: true }])
    expect(profiles.problem()).toBeUndefined()
    expect(store.get(KV.store.schema)).toBe(16)
  })
})

it('saves immutable revisions with optimistic concurrency and a reproducible content hash', () => {
  withProfiles((store, profiles) => {
    const first = profiles.save(draft(), 0, { by: 'local-user', source: 'panel', reason: 'docs' })
    expect(first.revision).toBe(1)
    expect(first.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(profiles.revision('worker-docs', 1)).toEqual(first)
    const second = profiles.save(draft({ description: 'Changed' }), 1, { by: 'local-user', source: 'panel', reason: 'edit' })
    expect(second.revision).toBe(2)
    expect(second.contentHash).not.toBe(first.contentHash)
    expect(profiles.revision('worker-docs', 1)).toEqual(first)
    expect(() => profiles.save(draft(), 1, { by: 'local-user', source: 'panel', reason: 'stale' })).toThrow(ProfileConflict)
    // A declaration-only change still changes the auditable content hash.
    const baseline = profiles.save(draft({ evalBaseline: { evalSet: 'docs', revision: 1 } }), 2,
      { by: 'local-user', source: 'panel', reason: 'baseline' })
    expect(baseline.contentHash).not.toBe(second.contentHash)
    expect(store.get(KV.profiles.head('worker-docs'))?.activeRevision).toBe(3)
  })
})

it('rejects forbidden authorization fields and custom profiles that leave model, prompt or tools moving', () => {
  const base = draft()
  for (const forbidden of [{ maxActionLevel: 3 }, { approval: 'required' }, { allowed: ['*'] }, { blocked: ['x'] },
    { permissionPreset: 'read-only' }, { actionLevels: [1, 2] }, { mandateMinutes: 5 }, { undoWindowSeconds: 3 },
    { sources: ['feishu'] }, { token: 'secret' }, { key: 'secret' }]) {
    expect(ProfileDraftSchema.safeParse({ ...base, ...forbidden }).success).toBe(false)
  }
  withProfiles((_store, profiles) => {
    expect(() => profiles.save(draft({ model: { mode: 'inherit' } }), 0, { by: 'local-user', source: 'panel', reason: 'x' })).toThrow('pin its model')
    expect(() => profiles.save(draft({ prompt: { mode: 'live' } }), 0, { by: 'local-user', source: 'panel', reason: 'x' })).toThrow('pin its prompt')
    expect(() => profiles.save(draft({ tools: { mode: 'inherit' } }), 0, { by: 'local-user', source: 'panel', reason: 'x' })).toThrow('list its work tools')
    expect(() => profiles.save(draft({ tools: { mode: 'list', names: ['read', 'orchestrator_route'] } }), 0,
      { by: 'local-user', source: 'panel', reason: 'x' })).toThrow('outside the worker role ceiling')
    expect(() => profiles.save(draft({ tools: { mode: 'list', names: ['read', 'read'] } }), 0,
      { by: 'local-user', source: 'panel', reason: 'x' })).toThrow('only once')
  })
})

it('activates an older revision without touching an already-bound ticket', () => {
  withProfiles((_store, profiles) => {
    profiles.saveConfig({ enabled: true, defaultProfile: 'worker-docs' })
    const first = profiles.save(draft(), 0, { by: 'local-user', source: 'panel', reason: 'v1' })
    const bound = profiles.bindRoot(ticket('t1'))!
    const second = profiles.save(draft({ description: 'v2' }), 1, { by: 'local-user', source: 'panel', reason: 'v2' })
    expect(bound.revision).toBe(first.revision)
    const head = profiles.activate('worker-docs', 1, 'local-user')
    expect(head.activeRevision).toBe(1)
    expect(head.retiredRevisions).toEqual([2])
    expect(profiles.bindRoot(ticket('t2'))?.revision).toBe(1)
    expect(bound.revision).toBe(1)
    expect(profiles.revision('worker-docs', second.revision)?.description).toBe('v2')
    expect(profiles.revisions('worker-docs').map(item => item.revision)).toEqual([1, 2])
    // A retired higher revision keeps its number; the next save is 3, not an overwrite of 2.
    expect(profiles.save(draft({ description: 'v3' }), 1, { by: 'local-user', source: 'panel', reason: 'v3' }).revision).toBe(3)
    expect(profiles.revision('worker-docs', 2)?.description).toBe('v2')
    expect(profiles.detail('worker-docs')?.profile.revision).toBe(3)
  })
})

it('binds a fallback snapshot when the selected profile is missing and keeps an invalid binding for launch', () => {
  withProfiles((store, profiles) => {
    expect(profiles.bindRoot(ticket('off'))).toBeUndefined()
    profiles.saveConfig({ enabled: true, defaultProfile: 'missing' })
    const fallback = profiles.bindRoot(ticket('t1'))!
    expect(fallback).toMatchObject({ id: 'legacy', revision: 0, selection: { fallback: true, valid: true } })
    expect(fallback.effective.hash).toMatch(/^sha256:/)
    // A profile that exists but pins a prompt that no longer resolves keeps the binding with valid=false.
    const bad = { ...draft({ prompt: { mode: 'pinned', revision: 999 } }), role: 'worker', revision: 1,
      provenance: { by: 'local-user', at: NOW, reason: 'bad', source: 'panel' }, contentHash: `sha256:${'0'.repeat(64)}` }
    store.set(KV.profiles.revision('worker-docs', 1), bad)
    store.set(KV.profiles.head('worker-docs'), { activeRevision: 1, retiredRevisions: [], updatedBy: 'local-user' })
    store.set(KV.profiles.index, ['worker-docs'])
    profiles.saveConfig({ defaultProfile: 'worker-docs' })
    const invalid = profiles.bindRoot(ticket('t2'))!
    expect(invalid.id).toBe('worker-docs')
    expect(invalid.selection.valid).toBe(false)
    expect(invalid.selection.reason).toContain('promptRevisionMissing')
    expect(invalid.prompt.revision).toBe(999)
    expect(invalid.prompt.hash).toBe('sha256:unavailable')
  })
})

it('copies the root snapshot to a child and resolves the same effective tools for both', () => {
  withProfiles((_store, profiles) => {
    // The compatible profile inherits the ceiling, so a child is the first narrowing step.
    profiles.seed()
    profiles.saveConfig({ enabled: true, defaultProfile: 'worker-default' })
    const root = ticket('r1', profiles.bindRoot(ticket('r1'))!)
    const child = { ...ticket('c1'), parentTicketId: 'r1', rootTicketId: 'r1' } as Ticket
    child.profile = profiles.bindChild(root, child)
    expect(child.profile).toEqual(root.profile)
    expect(profileWorkTools(root, id => id === 'r1' ? root : undefined)).toContain('subagent')
    expect(profileWorkTools(child, id => id === 'r1' ? root : child)).not.toContain('subagent')
    expect(profileWorkTools(child, id => id === 'r1' ? root : child)).not.toContain('send_message')
    // A pinned model removes subagent controls at the root too, because Phase 1 cannot pin a subagent's model.
    profiles.save(draft(), 0, { by: 'local-user', source: 'panel', reason: 'pinned' })
    profiles.saveConfig({ defaultProfile: 'worker-docs' })
    const pinned = ticket('p1', profiles.bindRoot(ticket('p1'))!)
    expect(profileWorkTools(pinned, id => id === 'p1' ? pinned : undefined)).not.toContain('subagent')
    // An empty list keeps protocol tools; it never claims read-only.
    const empty = ticket('e1', { ...pinned.profile!, tools: [], toolsMode: 'list' })
    expect(profileWorkTools(empty, id => id === 'e1' ? empty : undefined)).toEqual([])
  })
})

it('records a pinned model that does not match the actual request as non-compliant', () => {
  withProfiles((store, profiles, prompts) => {
    profiles.saveConfig({ enabled: true, defaultProfile: 'worker-docs' })
    profiles.save(draft(), 0, { by: 'local-user', source: 'panel', reason: 'pin' })
    const snapshot = profiles.bindRoot(ticket('t1'))!
    const version = prompts.current()
    const matched = runEffective(snapshot, version, prompts, store.settings(), ['read'], snapshot.effective.model)
    expect(matched.modelCompliant).toBe(true)
    const mismatched = runEffective(snapshot, version, prompts, store.settings(), ['read'],
      { provider: 'deepseek', model: 'deepseek-v4.1-flash' })
    expect(mismatched.modelCompliant).toBe(false)
    expect(mismatched.hash).not.toBe(matched.hash)
  })
})

it('groups metrics by effective hash, suppresses small rates, and reports unknown cost and tokens honestly', () => {
  withProfiles((store, profiles) => {
    profiles.seed()
    profiles.saveConfig({ enabled: true, defaultProfile: 'worker-default' })
    const snapshots = Array.from({ length: 5 }, (_, index) => profiles.bindRoot(ticket(`t${index}`))!)
    for (const [index, snapshot] of snapshots.entries()) {
      const at = new Date(Date.parse(NOW) + index * 1000).toISOString()
      store.tickets.save({ id: `t${index}`, form: 'tracked', createdAt: NOW, updatedAt: at, origin: { triggerId: 'trigger' },
        inputs: [], assignments: [{ id: `a${index}`, state: 'ended', createdAt: NOW, startedAt: at, endedAt: at,
          report: { state: index < 3 ? 'completed' : 'blocked', summary: 'result', at } }],
        ...(index < 3 ? { ended: { outcome: 'completed', at, by: 'executor' } } : {}), profile: snapshot } as unknown as Ticket)
    }
    // The compatible profile is moving: a recorded run hash replaces the binding hash for the first ticket.
    store.set(KV.sessions.effective('worker-t0'), { at: NOW, promptRevision: 0, promptHash: 'sha256:p', toolsHash: 'sha256:t',
      model: { provider: 'host-default', model: 'host-default' }, dshVersion: 'test', policyVersion: 'p', skillsHash: 's', hash: 'sha256:run' } as ProfileRunEffective)
    for (const index of [0, 1, 2, 3, 4]) store.set(KV.sessions.usage(`worker-t${index}`), { input: 10, output: 20, cacheRead: 0, cacheWrite: 0,
      reasoning: 0, messages: 1, at: NOW })
    expect(store.tickets.allList()).toHaveLength(5)
    const view = profileMetrics(store, 'worker-default', new Date(NOW))
    expect(view.totals).toMatchObject({ tickets: 5, roots: 5, censored: 2, success: { n: 3, successes: 3, rate: null, suppressed: true } })
    expect(view.totals.cost).toBe('unknown')
    expect(view.totals.tokens).toMatchObject({ state: 'available', input: 50, output: 100, cost: 'unknown' })
    expect(view.groups.map(group => group.effectiveHash)).toEqual(expect.arrayContaining(['sha256:run', snapshots[1]!.effective.hash]))
    expect(view.groups.find(group => group.effectiveHash === 'sha256:run')?.tokens).toMatchObject({ state: 'available', input: 10 })
    expect(view.groups.every(group => group.success.n < 5)).toBe(true)
    // The display is suppressed for a small group, while its counts remain visible.
    for (const group of view.groups) { expect(group.success.rate).toBeNull(); expect(group.success.suppressed).toBe(true) }
  })
})

it('counts child, lightweight, fallback and closed tickets separately from root success', () => {
  withProfiles((store, profiles) => {
    profiles.seed()
    profiles.saveConfig({ enabled: true, defaultProfile: 'worker-default' })
    const root = profiles.bindRoot(ticket('r'))!
    const child = profiles.bindChild(ticket('r', root), ticket('c'))!
    store.tickets.save({ ...ticket('r', root), ended: { outcome: 'closed', at: NOW, by: 'human' }, assignments: [] } as Ticket)
    store.tickets.save({ ...ticket('c', child), parentTicketId: 'r', rootTicketId: 'r', form: 'tracked',
      delegation: { attempt: 1, resolution: { kind: 'accepted' } }, assignments: [] } as unknown as Ticket)
    store.tickets.save({ ...ticket('l', root), form: 'lightweight', assignments: [], ended: { outcome: 'completed', at: NOW, by: 'executor' } } as Ticket)
    const view = profileMetrics(store, 'worker-default', new Date(NOW))
    expect(view.totals).toMatchObject({ roots: 2, children: 1, lightweight: 1, closed: 1, success: { n: 3, successes: 2 } })
  })
})