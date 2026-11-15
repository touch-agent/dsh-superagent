import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Mandate, ProfileSnapshot, Ticket } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { projectDetail, taskBoard } from '@superagent/dsh/app/tasks.ts'
import type { ViewHost } from '@superagent/dsh/app/views/records.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-projects-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const mandate = (capabilities: ('create-task' | 'assign-worker')[] = ['create-task', 'assign-worker']): Mandate => ({
  strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' },
  scope: 'project work', capabilities })

const profile = (id = 'worker-default'): ProfileSnapshot => ({ id, revision: 1, hash: 'h', role: 'worker',
  selection: { by: 'code', source: 'builtin', reason: 'test', moving: false, valid: true }, model: { mode: 'inherit' }, tools: ['read'],
  toolsMode: 'inherit', prompt: { mode: 'live', revision: 1, hash: 'p' },
  effective: { promptRevision: 1, promptHash: 'p', toolsHash: 't', model: { provider: 'test', model: 'test' }, dshVersion: 'test',
    policyVersion: 'v', skillsHash: 's', hash: 'e' }, boundAt: '2026-09-22T00:00:00Z', reason: 'test' })

const ticket = (fields: Partial<Ticket> & { id: string; title: string }): Ticket => ({
  decisionId: 'd1', mandate: mandate(), kind: 'task', channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', origin: { triggerId: 'x', triggerIds: ['x'] }, ...fields })

const projectTicket = (fields: Partial<Ticket> & { id: string; title: string }): Ticket =>
  ticket({ kind: 'project', goal: 'Ship it', profile: profile(), ...fields, mandate: fields.mandate ?? mandate() })

const host = (store: Store): ViewHost => ({ store, sources: { kind: () => undefined } as never, links: () => ({}) as never })
const seed = (store: Store, tickets: Ticket[]): void => { for (const item of tickets) store.tickets.save(item) }

describe('project board projection', () => {
  it('moves projects out of the task rows and groups their tasks beside unassigned work', () => {
    const store = new Store(join(directory, 'projects.sqlite'))
    const p1 = projectTicket({ id: 'p1', title: 'Project one' })
    const p2 = projectTicket({ id: 'p2', title: 'Project two', archivedAt: '2026-09-22T03:00:00Z' })
    const t1 = ticket({ id: 't1', title: 'Task in p1', projectTicketId: 'p1', updatedAt: '2026-09-22T04:00:00Z' })
    const t2 = ticket({ id: 't2', title: 'Loose task', updatedAt: '2026-09-22T02:00:00Z' })
    const broken = ticket({ id: 't3', title: 'Orphan link', projectTicketId: 'missing' })
    const archivedTask = ticket({ id: 't4', title: 'Archived project task', projectTicketId: 'p2' })
    const child = ticket({ id: 'c1', title: 'Subtask', parentTicketId: 't1', rootTicketId: 't1', projectTicketId: 'p1' })
    seed(store, [p1, p2, t1, t2, broken, archivedTask, child])
    const board = taskBoard(host(store), new Date('2026-09-22T12:00:00Z'))
    // The flat list is still root tasks only; a project never appears there, and a child stays below its task.
    expect(board.tasks.map(task => task.id).sort()).toEqual(['t1', 't2', 't3', 't4'])
    expect(board.tasks.find(task => task.id === 't1')).toMatchObject({ ticketKind: 'task', projectTicketId: 'p1' })
    expect(board.tasks.find(task => task.id === 't3')).toMatchObject({ ticketKind: 'task', projectBroken: true })
    expect(board.milestones.flatMap(milestone => milestone.children)).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'p1' })]))
    // Default filter: active projects only, with their direct root tasks; unassigned work sits beside them.
    expect(board.projects?.map(project => project.id)).toEqual(['p1'])
    expect(board.projects?.[0]).toMatchObject({ name: 'Project one', goal: 'Ship it', state: 'active',
      coordinator: { sessionId: 'worker-p1' }, owner: { profile: { id: 'worker-default', revision: 1 } },
      counts: { tasks: 1, open: 1 } })
    expect(board.projects?.[0]?.tasks.map(task => task.id)).toEqual(['t1'])
    expect(board.unassigned?.map(task => task.id).sort()).toEqual(['t2', 't3'])
    expect(board.totals).toMatchObject({ tickets: 4, projects: 1, archivedProjects: 1, unassigned: 2 })
    // Archived projects are opt-in and keep their tasks; archiving changes no task row or count.
    const archived = taskBoard(host(store), new Date('2026-09-22T12:00:00Z'), { projects: 'archived' })
    expect(archived.projects?.map(project => project.id)).toEqual(['p2'])
    expect(archived.projects?.[0]).toMatchObject({ name: 'Project two', state: 'archived', tasks: [{ id: 't4' }], counts: { tasks: 1 } })
    expect(taskBoard(host(store), new Date('2026-09-22T12:00:00Z'), { projects: 'all' }).projects?.map(project => project.id).sort()).toEqual(['p1', 'p2'])
    // The rollback flag restores the pre-project response shape.
    const legacy = taskBoard(host(store), new Date('2026-09-22T12:00:00Z'), { projects: 'off' })
    expect(legacy.projects).toBeUndefined()
    expect(legacy.unassigned).toBeUndefined()
    expect(legacy.totals).not.toHaveProperty('projects')
    expect(legacy.tasks.map(task => task.id).sort()).toEqual(['t1', 't2', 't3', 't4'])
  })

  it('reads one project with its task hierarchy and refuses to read a task as a project', () => {
    const store = new Store(join(directory, 'projects-detail.sqlite'))
    const p1 = projectTicket({ id: 'p1', title: 'Project one' })
    const t1 = ticket({ id: 't1', title: 'Task', projectTicketId: 'p1' })
    const child = ticket({ id: 'c1', title: 'Subtask', parentTicketId: 't1', rootTicketId: 't1', projectTicketId: 'p1' })
    const loose = ticket({ id: 'other', title: 'Other task' })
    seed(store, [p1, t1, child, loose])
    const detail = projectDetail(host(store), 'p1', 2)!
    expect(detail.project.tasks.map(task => task.id)).toEqual(['t1'])
    expect(detail.tasks[0]).toMatchObject({ id: 't1', ticketKind: 'task', projectTicketId: 'p1', children: [{ id: 'c1', ticketKind: 'subtask' }] })
    expect(projectDetail(host(store), 'other')).toBeUndefined()
    expect(projectDetail(host(store), 'missing')).toBeUndefined()
  })

  it('shows a project-level worker problem when no usable owner profile is bound', () => {
    const store = new Store(join(directory, 'projects-attention.sqlite'))
    const p1 = projectTicket({ id: 'p1', title: 'No worker', profile: undefined })
    seed(store, [p1])
    const project = taskBoard(host(store), new Date('2026-09-22T12:00:00Z')).projects?.[0]
    expect(project?.attention).toMatchObject({ kind: 'worker' })
    expect(project?.owner).toBeUndefined()
  })

  it('shows a capability problem without hiding the project tasks', () => {
    const store = new Store(join(directory, 'projects-capability.sqlite'))
    const p1 = projectTicket({ id: 'p1', title: 'Human accept only', mandate: mandate([]) })
    const t1 = ticket({ id: 't1', title: 'Task', projectTicketId: 'p1' })
    seed(store, [p1, t1])
    const project = taskBoard(host(store), new Date('2026-09-22T12:00:00Z')).projects?.[0]
    expect(project?.attention).toMatchObject({ kind: 'capability', detail: expect.stringContaining('create-task') })
    expect(project?.tasks.map(task => task.id)).toEqual(['t1'])
  })
})