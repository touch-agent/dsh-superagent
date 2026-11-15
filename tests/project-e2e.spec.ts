/**
 * End-to-end project layer through the real Runtime: a person's message is accepted as a project container by the main
 * Session's `orchestrator_route`, the project coordination Session admits a root task and assigns it to another worker,
 * the main Session archives the project, and `GET tasks` / `GET projects/:id` show the active/archived views and the
 * drill-down. The data is written through the real Decision, Mandate, Profile and coordination paths, not injected into
 * a response.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { ProfileDraft } from '@superagent/dsh/app/profiles.ts'
import type { TaskView } from '@superagent/dsh/app/tasks.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host

beforeEach(async () => { host = await startRuntime() })
afterEach(async () => { await host.stop() })

/** A second worker Profile, so the admitted task is visibly assigned to someone other than the project owner. */
const docsWorker: ProfileDraft = { id: 'worker-docs', title: 'Docs worker', description: 'Writes the project documentation.',
  model: { mode: 'pinned', provider: 'deepseek', model: 'deepseek-v4.1' },
  tools: { mode: 'list', names: ['read', 'grep'] }, prompt: { mode: 'pinned', revision: 0 } } as ProfileDraft

interface Card { ticket_id: string; title: string }

it('creates a project, admits an assigned task, archives it, and projects both views for the panel', async () => {
  // Profiles are off by default; a project must bind a real owner worker, so an operator turns them on first.
  host.runtime.profiles.saveOperatorConfig({ enabled: true }, 'test', 'project E2E')
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
    model: { provider: 'deepseek', model: 'deepseek-v4.1' } } })
  host.runtime.profiles.save(docsWorker, 0, { by: 'test', source: 'panel', reason: 'project E2E' })

  const request = feishu('901', '<at user_id="ou_bot">助手</at> 做一个项目视图的真实项目')
  host.runtime.receive(request)
  await host.runtime.idle()
  const accepted = await host.route({ kind: 'accept', trigger_id: request.id, title: '项目视图真实链路',
    worktree_name: 'project-view-e2e', acknowledgement: '收到，建立项目。',
    project: { goal: '用一个真实项目跑通项目视图与归档', owner_profile_id: 'worker-default' } })
  const projectId = (accepted.ticket as Card).ticket_id
  await host.runtime.idle()
  const project = host.runtime.store.tickets.get(projectId)!
  expect(project).toMatchObject({ kind: 'project', goal: '用一个真实项目跑通项目视图与归档',
    profile: { id: 'worker-default' } })
  expect(project.assignments).toEqual([])
  expect(host.agents.has(`worker-${projectId}`)).toBe(true)

  // The project coordination Session admits a task and assigns a different worker in the same request.
  const created = await host.runTool(`worker-${projectId}`, 'orchestrator_create_task', {
    title: '补上无项目空态', goal: '没有项目时也要说清当前是项目视图', scope: '只改任务页空态与测试',
    owner_profile_id: 'worker-docs', idempotency_key: `${request.id}/item-0` })
  const taskId = (created.ticket as Card).ticket_id
  await host.runtime.idle()
  const task = host.runtime.store.tickets.get(taskId)!
  expect(task).toMatchObject({ kind: 'task', projectTicketId: projectId, profile: { id: 'worker-docs' } })
  expect(task.parentTicketId).toBeUndefined()

  // Before archiving, the default board carries the project and its task.
  const active = await host.api('GET', 'tasks')
  const activeProjects = active.body.projects as { id: string; name: string; owner?: { profile?: { id: string } }; tasks?: TaskView[] }[]
  expect(activeProjects.map(item => item.id)).toEqual([projectId])
  expect(activeProjects[0]).toMatchObject({ name: '项目视图真实链路', owner: { profile: { id: 'worker-default' } } })
  expect(activeProjects[0]?.tasks?.map(item => item.id)).toEqual([taskId])
  expect((active.body.totals as { projects: number; unassigned: number })).toMatchObject({ projects: 1 })

  // The main Session archives the project on the person's explicit request.
  await host.runTool(host.runtime.masterId, 'orchestrator_project_archive', { project_id: projectId, archived: true })
  const archivedProject = host.runtime.store.tickets.get(projectId)!
  expect(archivedProject.archivedAt).toEqual(expect.any(String))
  expect(archivedProject.ended).toBeUndefined()
  expect(host.runtime.store.tickets.get(taskId)!.ended).toBeUndefined()

  // The default view no longer lists it; the archived view and the project detail still carry the task.
  const after = await host.api('GET', 'tasks')
  expect(after.body.projects).toEqual([])
  expect((after.body.totals as { archivedProjects: number }).archivedProjects).toBe(1)
  const archived = await host.api('GET', 'tasks?projects=archived')
  expect((archived.body.projects as { id: string; state: string; tasks?: TaskView[] }[])[0]).toMatchObject({ id: projectId,
    state: 'archived', tasks: [{ id: taskId }] })
  const detail = await host.api('GET', `projects/${projectId}?depth=2`)
  expect(detail.body).toMatchObject({ project: { id: projectId, state: 'archived', name: '项目视图真实链路' },
    tasks: [{ id: taskId, projectTicketId: projectId, ticketKind: 'task' }] })
  // Restoring brings it back to the active view; archiving changes only the project marker, never the task.
  await host.runTool(host.runtime.masterId, 'orchestrator_project_archive', { project_id: projectId, archived: false })
  const restored = await host.api('GET', 'tasks')
  expect((restored.body.projects as { id: string }[]).map(item => item.id)).toEqual([projectId])
})