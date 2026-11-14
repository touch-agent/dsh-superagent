import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, isProjectArchived, isProjectTicket, isUnassignedTask, key, projectCoordinator,
  projectOfTask, ticketKindOf } from '@superagent/kernel'
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Policy, ProfileSnapshot, Ticket, Trigger }
  from '@superagent/kernel'

const member = { source: 'chat', id: 'alice' }
const ownerProfile = 'worker-default'
let clock = 0
const now = () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString()

function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: `t${id}` }], actor: member, human: true,
    at: `2026-09-23T00:00:${id.padStart(2, '0').slice(-2)}Z`, text: `message ${id}`,
    channel: { source: 'chat', thread: `t${id}`, address: { message: id } }, meta: {}, ...overrides }
}

function snapshot(id: string, revision = 1): ProfileSnapshot {
  return { id, revision, hash: `hash-${id}-${revision}`, role: 'worker',
    selection: { by: 'code', source: 'builtin', reason: 'test', moving: false, valid: true },
    model: { mode: 'inherit' }, tools: ['read'], toolsMode: 'inherit', prompt: { mode: 'live', revision: 1, hash: 'prompt' },
    effective: { promptRevision: 1, promptHash: 'prompt', toolsHash: 'tools', model: { provider: 'test', model: 'test' },
      dshVersion: 'test', policyVersion: 'v1', skillsHash: 'skills', hash: 'effective' },
    boundAt: now(), reason: 'test' }
}

interface Hooks {
  profile?: EngineOptions['profile']
  prepareTicket?: EngineOptions['prepareTicket']
  emit?: EngineOptions['emit']
}

function harness({ profile, prepareTicket, emit }: Hooks = {}) {
  const repo = new MemoryRepositories()
  const outbox: OutboundMessage[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn(candidate => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const started: string[] = []
  const deliveries: string[] = []
  const stopped: string[] = []
  const executor: Executor = { start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }),
    deliver: vi.fn(ticket => { deliveries.push(ticket.id) }), stop: vi.fn((ticket, assignment, reason) => { stopped.push(`${ticket.id}:${assignment.id}:${reason}`) }) }
  const coordination = { start: vi.fn((project: Ticket) => { started.push(project.id) }),
    deliver: vi.fn((project: Ticket) => { deliveries.push(project.id) }) }
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: t => t.human && t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : { admissible: false, reason: 'not a member' },
    revalidate: () => ({ ok: true }),
    mandateLimits: () => ({ maxActionLevel: 'send' }),
    admitsInferred: () => false,
  }
  const scope: EngineOptions['scope'] = { scope: () => ({ listened: true, observed: false }) }
  const queued: EngineOptions['outbox'] = {
    send: message => { const id = message.action.idempotencyKey
      if (!outbox.some(item => item.id === id)) outbox.push({ ...message, id }) },
    status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
    withdraw: () => {}, recall: () => 'recalled',
  }
  const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox: queued, coordination,
    ...(profile ? { profile } : { profile: { bindRoot: () => snapshot(ownerProfile), bindChild: parent => parent.profile,
      bindNamed: (_ticket, id) => id === ownerProfile ? snapshot(ownerProfile) : undefined } }),
    ...(prepareTicket ? { prepareTicket } : {}), ...(emit ? { emit } : {}), now })
  const pump = () => engine.evaluateDue()
  /** Accept one trigger as a project or a flat task. */
  function accept(outcome: Omit<Extract<Parameters<Engine['decide']>[1], { kind: 'accept' }>, 'kind' | 'title' | 'scope' | 'reason'> = {},
    details: { triggerId?: string; title?: string } = {}) {
    const id = details.triggerId ?? '1'
    engine.receive(trigger(id))
    pump()
    const candidate = requests.at(-1)!
    return engine.decide(candidate.triggers[0]!.id, { kind: 'accept', title: details.title ?? 'Work', scope: 'small', reason: 'requested',
      name: `work-${id}`, ...outcome })
  }
  const project = (overrides: { goal?: string; ownerProfileId?: string; capabilities?: ('create-task' | 'assign-worker')[] } = {}) =>
    accept({ project: { goal: overrides.goal ?? 'Ship the project', ownerProfileId: overrides.ownerProfileId ?? ownerProfile,
      ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}) } }, { triggerId: '1', title: 'Project' })
  return { repo, engine, outbox, requests, launches, started, deliveries, stopped, coordination, executor, pump, accept, project }
}

const coordinator = (projectId: string) => projectCoordinator(projectId)

describe('project tickets and hierarchy', () => {
  it('accepts a project as a container: no Assignment, no execution, an owner worker and a coordination Session', () => {
    const h = harness()
    const decision = h.project()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket).toMatchObject({ kind: 'project', goal: 'Ship the project', title: 'Project',
      mandate: { strength: 'explicit', capabilities: ['create-task', 'assign-worker'] }, profile: { id: ownerProfile } })
    expect(ticket.assignments).toEqual([])
    expect(ticket.execution).toBeUndefined()
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: 'text', id: key('input', ticket.id, 'project-brief') })])
    expect(ticket.undelivered).toEqual([key('input', ticket.id, 'project-brief')])
    expect(h.coordination.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: ticket.id }))
    expect(h.executor.start).not.toHaveBeenCalled()
    expect(isProjectTicket(ticket)).toBe(true)
    expect(isProjectArchived(ticket)).toBe(false)
  })

  it('admits a root task through a Decision that records the project admission, and is idempotent by key', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    const request = { title: 'Implement the data layer', goal: 'Data layer ready', scope: 'only the data layer',
      idempotencyKey: 'msg-1/item-0' }
    const task = h.engine.admitProjectTask(project.id, request, coordinator(project.id))
    expect(task).toMatchObject({ kind: 'task', projectTicketId: project.id, title: request.title, goal: request.goal })
    expect(task.parentTicketId).toBeUndefined()
    expect(task.mandate).toMatchObject({ strength: 'explicit', scope: `${project.mandate!.scope}\nTask: only the data layer` })
    expect(task.mandate).not.toHaveProperty('capabilities')
    const decision = h.repo.decisions.get(task.decisionId!)!
    expect(decision).toMatchObject({ kind: 'accept', ticketId: task.id, reason: [{ code: 'projectAdmission' }],
      admission: { projectTicketId: project.id, requestedBy: coordinator(project.id), ownerProfileId: ownerProfile, idempotencyKey: 'msg-1/item-0' } })
    expect(h.repo.tickets.get(task.id)!.assignments).toHaveLength(1)
    expect(h.executor.start).toHaveBeenCalledOnce()
    // A retried request with the same key returns the same task and creates nothing else.
    const again = h.engine.admitProjectTask(project.id, request, coordinator(project.id))
    expect(again.id).toBe(task.id)
    expect(h.repo.tickets.list().filter(item => item.kind === 'task')).toHaveLength(1)
    expect(h.repo.decisions.byThread('chat:t1').filter(item => item.admission)).toHaveLength(1)
  })

  it('links a human-accepted task to a project without changing its owner or authorization', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    const decision = h.accept({ projectTicketId: project.id }, { triggerId: '2', title: 'Human task' })
    const task = h.repo.tickets.get(decision.ticketId!)!
    expect(task).toMatchObject({ kind: 'task', projectTicketId: project.id, title: 'Human task' })
    expect(task.parentTicketId).toBeUndefined()
    expect(task.mandate).toMatchObject({ scope: 'small' })
    expect(task.mandate).not.toHaveProperty('capabilities')
    expect(task.profile?.id).toBe(ownerProfile)
    expect(task.assignments).toHaveLength(1)
    expect(projectOfTask(task, id => h.repo.tickets.get(id))?.id).toBe(project.id)
    expect(isUnassignedTask(task)).toBe(false)
    expect(h.executor.start).toHaveBeenCalledOnce()
  })

  it('refuses a task link to a missing, archived, or combined project container', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    expect(() => h.accept({ projectTicketId: 'missing' }, { triggerId: '2', title: 'Unknown link' }))
      .toThrowError(new UserError('unknownTicket'))
    expect(() => h.accept({ project: { goal: 'Nested', ownerProfileId: ownerProfile }, projectTicketId: project.id },
      { triggerId: '3', title: 'Nested project' })).toThrowError(new UserError('projectInvalid'))
    h.engine.archiveProject(project.id, true, member)
    expect(() => h.accept({ projectTicketId: project.id }, { triggerId: '4', title: 'Archived link' }))
      .toThrowError(new UserError('projectArchived'))
    expect(h.repo.tickets.list().filter(item => item.title === 'Archived link')).toHaveLength(0)
  })

  it('inherits the project link into delegated subtasks and reads legacy tickets as unassigned tasks', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    const task = h.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 't1' }, coordinator(project.id))
    const child = h.engine.delegate(task.id, { goal: 'Subtask' })
    expect(child).toMatchObject({ parentTicketId: task.id, rootTicketId: task.id, projectTicketId: project.id, kind: 'task' })
    // A ticket written before projects existed has no kind or project link; it is a root task and unassigned.
    const legacy = h.repo.tickets.get(h.accept({}, { triggerId: '2', title: 'Legacy' }).ticketId!)!
    expect(ticketKindOf(legacy)).toBe('task')
    expect(isUnassignedTask(legacy)).toBe(true)
    expect(projectOfTask(legacy, id => h.repo.tickets.get(id))).toBeUndefined()
    expect(ticketKindOf(task)).toBe('task')
    expect(projectOfTask(task, id => h.repo.tickets.get(id))?.id).toBe(project.id)
    // A link that names no project never guesses one.
    expect(projectOfTask({ ...task, projectTicketId: 'missing' }, id => h.repo.tickets.get(id))).toBeUndefined()
  })

  it('refuses project operations from another coordinator, from a task, and once the project is archived', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    expect(() => h.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 'x' }, coordinator('another')))
      .toThrow(expect.objectContaining({ code: 'notProjectCoordinator' }))
    const task = h.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 't1' }, coordinator(project.id))
    expect(() => h.engine.admitProjectTask(task.id, { title: 'Nested', idempotencyKey: 'x' }, coordinator(task.id)))
      .toThrow(expect.objectContaining({ code: 'notProject' }))
    h.engine.archiveProject(project.id, true, member)
    expect(() => h.engine.admitProjectTask(project.id, { title: 'Later', idempotencyKey: 'x' }, coordinator(project.id)))
      .toThrow(expect.objectContaining({ code: 'projectArchived' }))
    expect(() => h.engine.dispatchToProject(project.id, 'trigger-x')).toThrow(expect.objectContaining({ code: 'projectArchived' }))
  })

  it('requires the capability a project operation needs and forbids assigning a task to another project', () => {
    const limited = harness()
    const project = limited.repo.tickets.get(limited.project({ capabilities: ['create-task'] }).ticketId!)!
    const task = limited.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 't1' }, coordinator(project.id))
    // create-task may use the project owner, but choosing another owner is an assignment and needs assign-worker.
    expect(() => limited.engine.admitProjectTask(project.id, { title: 'Other owner', ownerProfileId: 'other-worker',
      idempotencyKey: 't2' }, coordinator(project.id))).toThrow(expect.objectContaining({ code: 'projectCapabilityMissing' }))
    expect(() => limited.engine.assignProjectTask(project.id, task.id, ownerProfile, coordinator(project.id)))
      .toThrow(expect.objectContaining({ code: 'projectCapabilityMissing' }))
    const other = limited.repo.tickets.get(limited.accept({ project: { goal: 'Other project', ownerProfileId: ownerProfile,
      capabilities: ['create-task', 'assign-worker'] } }, { triggerId: '2', title: 'Other' }).ticketId!)!
    // The task belongs to the first project, even though the second coordinator is allowed to assign its own tasks.
    expect(() => limited.engine.assignProjectTask(other.id, task.id, ownerProfile, coordinator(other.id)))
      .toThrow(expect.objectContaining({ code: 'taskNotInProject' }))
    expect(() => limited.engine.assignProjectTask(project.id, task.id, 'missing-profile', coordinator(project.id)))
      .toThrow(expect.objectContaining({ code: 'projectCapabilityMissing' }))
  })

  it('lets assign-worker choose a different owner for a new task', () => {
    const h = harness({ profile: { bindRoot: () => snapshot(ownerProfile), bindChild: parent => parent.profile,
      bindNamed: (_ticket, id) => snapshot(id) } })
    const project = h.repo.tickets.get(h.project({ capabilities: ['create-task', 'assign-worker'] }).ticketId!)!
    const task = h.engine.admitProjectTask(project.id, { title: 'Assigned at creation', ownerProfileId: 'other-worker',
      idempotencyKey: 't1' }, coordinator(project.id))
    expect(task.profile).toMatchObject({ id: 'other-worker' })
    const changed = h.engine.assignProjectTask(project.id, task.id, 'third-worker', coordinator(project.id))
    expect(changed.profile).toMatchObject({ id: 'third-worker' })
  })

  it('assigns a worker only before the task starts', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    const task = h.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 't1' }, coordinator(project.id))
    const assignment = task.assignments[0]!
    const changed = h.engine.assignProjectTask(project.id, task.id, ownerProfile, coordinator(project.id))
    expect(changed.profile).toMatchObject({ id: ownerProfile, revision: 1 })
    h.engine.assignmentStarted(task.id, assignment.id)
    expect(() => h.engine.assignProjectTask(project.id, task.id, ownerProfile, coordinator(project.id)))
      .toThrow(expect.objectContaining({ code: 'taskStarted' }))
  })

  it('never ends a project and never gives it an Assignment, a report or a child', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    expect(() => h.engine.stopTicket(project.id)).toThrow(expect.objectContaining({ code: 'projectCannotEnd' }))
    expect(project.ended).toBeUndefined()
    expect(() => h.engine.report(project.id, { state: 'ready', summary: 'done' })).toThrow()
    expect(() => h.engine.delegate(project.id, { goal: 'child' })).toThrow(expect.objectContaining({ code: 'projectHasNoAssignment' }))
  })
})

describe('project dispatch and archive', () => {
  it('dispatches a message to the project coordination Session instead of creating a flat task', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    h.engine.receive(trigger('2'))
    const before = h.repo.tickets.list().length
    const dispatched = h.engine.dispatchToProject(project.id, '2', 'from the main Session')
    expect(h.repo.tickets.list()).toHaveLength(before)
    const updated = h.repo.tickets.get(project.id)!
    expect(updated.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'trigger', triggerId: '2', note: 'from the main Session' })]))
    expect(updated.undelivered.some(id => id.includes('2'))).toBe(true)
    expect(h.repo.threads.get('chat:t2')?.subscriptions).toContain(project.id)
    expect(h.repo.triggers.disposition('2')?.fanout).toContain(project.id)
    expect(dispatched.id).toBe(project.id)
    // Delivering the batch clears the waiting list and records where it went.
    const ids = h.repo.tickets.get(project.id)!.undelivered
    h.engine.projectInputsDelivered(project.id, ids)
    expect(h.repo.tickets.get(project.id)!.undelivered).toEqual([])
    const triggerInput = h.repo.tickets.get(project.id)!.inputs.find(input => input.kind === 'trigger' && ids.includes(input.id))
    expect(triggerInput?.kind === 'trigger' ? triggerInput.deliveredTo : undefined).toBe(`coordinator-${project.id}`)
  })

  it('refuses dispatch to an unknown, task or archived project', () => {
    const h = harness()
    const task = h.repo.tickets.get(h.accept({}, { triggerId: '2', title: 'Task' }).ticketId!)!
    h.engine.receive(trigger('3'))
    expect(() => h.engine.dispatchToProject('missing', '3')).toThrow(expect.objectContaining({ code: 'unknownTicket' }))
    expect(() => h.engine.dispatchToProject(task.id, '3')).toThrow(expect.objectContaining({ code: 'notProject' }))
    const project = h.repo.tickets.get(h.project({ capabilities: ['create-task'] }).ticketId!)!
    h.engine.archiveProject(project.id, true, member)
    expect(() => h.engine.dispatchToProject(project.id, '3')).toThrow(expect.objectContaining({ code: 'projectArchived' }))
  })

  it('archives and restores only the project marker, leaving tasks live and countable', () => {
    const h = harness()
    const events: string[] = []
    const project = h.repo.tickets.get(h.project().ticketId!)!
    const task = h.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 't1' }, coordinator(project.id))
    h.engine.archiveProject(project.id, true, member, 'shipped')
    expect(h.repo.tickets.get(project.id)!.archivedAt).toEqual(expect.any(String))
    expect(h.repo.tickets.get(project.id)!.ended).toBeUndefined()
    expect(h.repo.tickets.get(task.id)!.ended).toBeUndefined()
    h.engine.archiveProject(project.id, true, member)
    expect(h.repo.tickets.get(project.id)!.archivedAt).toBeDefined()
    h.engine.archiveProject(project.id, false, member)
    expect(h.repo.tickets.get(project.id)!.archivedAt).toBeUndefined()
    expect(() => h.engine.archiveProject(task.id, true, member)).toThrow(expect.objectContaining({ code: 'notProject' }))
    expect(events).toEqual([])
  })

  it('emits admission, worker-change and archive events for the activity feed', () => {
    const emitted: { type: string; data: Record<string, unknown> }[] = []
    const h = harness({ emit: event => { emitted.push(event) } })
    const project = h.repo.tickets.get(h.project().ticketId!)!
    const task = h.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 't1' }, coordinator(project.id))
    h.engine.assignProjectTask(project.id, task.id, ownerProfile, coordinator(project.id))
    h.engine.archiveProject(project.id, true, member)
    expect(emitted.map(event => event.type)).toEqual(expect.arrayContaining(['ticket.created', 'project.task.admitted', 'project.worker.changed', 'project.archived']))
    expect(emitted.find(event => event.type === 'project.task.admitted')?.data).toMatchObject({ projectId: project.id, ticketId: task.id })
  })

  it('reports a missing owner worker as a project-level refusal, not a fallback ticket', () => {
    const h = harness({ profile: { bindRoot: () => snapshot(ownerProfile), bindChild: parent => parent.profile, bindNamed: () => undefined } })
    const project = h.repo.tickets.get(h.project().ticketId!)!
    expect(project.profile).toBeUndefined()
    expect(() => h.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 't1' }, coordinator(project.id)))
      .toThrow(expect.objectContaining({ code: 'projectWorkerUnavailable' }))
    // Refusals are UserError with a stable code, so the panel and the model read the same reason.
    try { h.engine.admitProjectTask(project.id, { title: 'Task', idempotencyKey: 't1' }, coordinator(project.id)) }
    catch (error) { expect(error).toBeInstanceOf(UserError) }
  })

  it('keeps a task Mandate within the project ceiling and records its admission Decision', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project().ticketId!)!
    const task = h.engine.admitProjectTask(project.id, { title: 'Task', scope: 'narrow', idempotencyKey: 't1' }, coordinator(project.id))
    expect(task.mandate).toMatchObject({ strength: project.mandate!.strength, maxActionLevel: project.mandate!.maxActionLevel,
      basis: project.mandate!.basis, actor: coordinator(project.id) })
    expect(task.mandate!.scope.startsWith(project.mandate!.scope)).toBe(true)
    expect(h.repo.decisions.get(task.decisionId!)?.admission?.idempotencyKey).toBe('t1')
  })
})
describe('human accept fallback', () => {
  it('lets a project with no capabilities refuse coordination and keeps the ordinary accept path for tasks', () => {
    const h = harness()
    const project = h.repo.tickets.get(h.project({ capabilities: [] }).ticketId!)!
    expect(project.mandate?.capabilities).toEqual([])
    expect(() => h.engine.admitProjectTask(project.id, { title: 'Coordinated task', idempotencyKey: 't1' }, coordinator(project.id)))
      .toThrow(expect.objectContaining({ code: 'projectCapabilityMissing' }))
    // A person can still accept a task directly; it stays a normal root task without a project admission.
    const decision = h.accept({}, { triggerId: '2', title: 'Human accepted' })
    const task = h.repo.tickets.get(decision.ticketId!)!
    expect(task).toMatchObject({ kind: 'task', title: 'Human accepted' })
    expect(task.projectTicketId).toBeUndefined()
    expect(task.decisionId).toBe(decision.id)
    expect(h.repo.decisions.get(decision.id!)?.admission).toBeUndefined()
  })
})
