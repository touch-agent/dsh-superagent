import { expect, it } from 'vitest'
import type { Ticket } from '@superagent/kernel'
import { executorTools } from '@superagent/dsh/app/tools/executor.ts'

const base = (fields: Partial<Ticket> & { id: string }): Ticket => ({ title: fields.id, kind: 'task', decisionId: 'd',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: 's' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z',
  origin: { triggerId: 'x', triggerIds: ['x'] }, ...fields })

it('gives a project only its coordination tools, never the task work, report, end or child tools', () => {
  const names = executorTools({} as never, base({ id: 'p1', kind: 'project', goal: 'Ship it' })).map(tool => tool.name)
  expect(names).toEqual(['orchestrator_read', 'orchestrator_create_task', 'orchestrator_assign_worker',
    'orchestrator_thread_unrelated', 'orchestrator_thread_follow'])
  expect(names).not.toEqual(expect.arrayContaining(['orchestrator_report', 'orchestrator_delegate', 'orchestrator_child', 'orchestrator_ack', 'write']))
})

it('keeps a task without the project-only create and assign tools', () => {
  const names = executorTools({ github: { deployment: { github: { login: 'touch-agent' } } } } as never, base({ id: 't1' })).map(tool => tool.name)
  expect(names).toEqual(expect.arrayContaining(['orchestrator_read', 'orchestrator_report', 'orchestrator_ack']))
  expect(names).not.toEqual(expect.arrayContaining(['orchestrator_create_task', 'orchestrator_assign_worker']))
})