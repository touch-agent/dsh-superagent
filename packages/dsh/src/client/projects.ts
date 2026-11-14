/**
 * Read-only project projection for the Tasks page. A project is the server's `ProjectView` over Ticket records; this
 * module never writes, invents a parent, or keeps a second task list. Everything here is derived from the contract
 * fields the board already returns (`kind`, `parentTicketId`, `goal`, owner profile, archive state), so a missing field
 * reads as unknown instead of being filled from a title, a plan id or a Session.
 */
import type { ApiResponse } from '../app/api.ts'
import type { TaskBoardView, TaskView } from '../app/tasks.ts'
import { when, type T } from './text.ts'

/** The optional fields the project projection adds to the existing board; absent on a host that has not upgraded. */
export interface ProjectBoardView extends Omit<TaskBoardView, 'totals'> {
  projects?: ProjectView[]
  /** Root Tickets with no project; the server may send this, otherwise it is derived from `projectTicketId`. */
  unassigned?: TaskView[]
  /** Project counts the server sums with the same filter as `projects`; absent on a board without the layer. */
  totals: TaskBoardView['totals'] & { projects?: number; archivedProjects?: number; unassigned?: number }
}

/** The project Ticket's bound owner profile snapshot; its title comes only from the read-only profile registry. */
export interface ProjectOwnerView {
  profile?: { id: string; revision: number }
}

/** Counts the server may project; a missing value is derived from the project's top-level tasks. */
export interface ProjectCountsView {
  tasks?: number
  open?: number
  working?: number
  waiting?: number
  review?: number
  done?: number
  attention?: number
  blocked?: number
  failed?: number
}

/** Why a project itself needs a person, as the server derives it from the bound worker and Mandate. */
export interface ProjectAttentionView {
  kind: 'worker' | 'capability' | 'question'
  detail?: string
  at?: string
}

/** One project Ticket as the project list and detail read it. */
export interface ProjectView {
  id: string
  /** The project Ticket's title; no fallback derives a name from tasks or plan ids. */
  title?: string
  goal?: string
  owner?: ProjectOwnerView
  state?: 'active' | 'archived'
  archivedAt?: string
  archived?: boolean
  createdAt?: string
  updatedAt?: string
  /** A project-level problem (worker, capability or question), counted once on top of task attention. */
  attention?: ProjectAttentionView
  counts?: ProjectCountsView
  lastActivityAt?: string
  /** Top-level tasks; the server excludes review rows and children load through `GET tasks/:id`. */
  tasks?: TaskView[]
}

/** The hierarchy fields a TaskView carries after the project layer is enabled. */
export interface ProjectTaskFields {
  projectTicketId?: string | null
}

export type ProfileRow = ApiResponse<'GET profiles'>['profiles'][number]

export interface ProjectTotals {
  tasks: number
  open: number
  done: number
  attention: number
  blocked: number
  failed: number
  progress: number
}

export type ProjectAction = 'review' | 'answer' | 'retry' | 'view'

/** The project navigation the Tasks page keeps inside its own tab, never in a host URL. */
export type ProjectScreen =
  | { view: 'list' }
  | { view: 'all' }
  | { view: 'unassigned' }
  | { view: 'project'; id: string }
  | { view: 'task'; taskId: string; projectId?: string; from: 'project' | 'all' | 'unassigned' }

export interface ProjectAttentionItem {
  project: ProjectView
  task: TaskView
  action: ProjectAction
  at?: string
}

export interface ProjectActivityItem {
  task: TaskView
  at?: string
  text: string
}

export interface ProjectIssueItem {
  project: ProjectView
  attention: ProjectAttentionView
  at?: string
}

/** The project Ticket's title; no fallback derives a name from tasks or plan ids. */
export const projectTitle = (project: ProjectView): string => project.title ?? ''

export const projectBoard = (board: TaskBoardView): ProjectBoardView => board as ProjectBoardView

/** Whether the server sent the project projection at all; absent means an older host, not an empty project list. */
export const hasProjects = (board: TaskBoardView): boolean => Array.isArray(projectBoard(board).projects)

export const isArchived = (project: ProjectView): boolean => project.archivedAt !== undefined || project.archived === true
  || project.state === 'archived'

/** The project's top-level tasks; when the server omitted them, contract `projectTicketId` is the only fallback. */
export function tasksOfProject(project: ProjectView, board: TaskBoardView): TaskView[] {
  if (Array.isArray(project.tasks)) return project.tasks.filter(task => task.kind !== 'review')
  return board.tasks.filter(task => task.kind !== 'review' && (task as TaskView & ProjectTaskFields).projectTicketId === project.id)
}

/** Root Tickets outside every project; a missing `projectTicketId` is the contract's "not in a project" default. */
export function unassignedTasks(board: TaskBoardView): TaskView[] {
  const projected = projectBoard(board).unassigned
  if (Array.isArray(projected)) return projected.filter(task => task.kind !== 'review')
  return board.tasks.filter(task => task.kind !== 'review' && (task as TaskView & ProjectTaskFields).projectTicketId == null)
}

/** Whether the project has no usable owner profile; that is a project-level issue, not a task's owner. */
export function ownerMissing(project: ProjectView): boolean {
  return project.owner?.profile === undefined
}

const sum = (values: readonly (number | undefined)[]): number => values.reduce<number>((total, value) => total + (value ?? 0), 0)

/** Top-level progress and pending counts; projected counts win, missing values come from the visible task rows. */
export function totalsOf(project: ProjectView, tasks: readonly TaskView[]): ProjectTotals {
  const roots = tasks.filter(task => task.kind !== 'review')
  // The projected count covers task attention; a project-level worker/capability/question issue counts once more.
  const projectIssue = project.attention !== undefined || ownerMissing(project) ? 1 : 0
  const taskAttention = project.counts?.attention ?? roots.filter(task => task.attention).length
  const derivedBlocked = roots.filter(task => task.status === 'blocked').length
    + sum(roots.map(task => (task.childSummary?.blocked ?? 0) + (task.childSummary?.failed ?? 0) + (task.childSummary?.orphaned ?? 0)))
  const derivedFailed = roots.filter(task => task.status === 'failed').length
  const done = project.counts?.done ?? roots.filter(task => task.status === 'done').length
  const total = project.counts?.tasks ?? roots.length
  return {
    tasks: total,
    open: project.counts?.open ?? roots.filter(task => task.status !== 'done').length,
    done,
    attention: projectIssue ? taskAttention + 1 : taskAttention,
    blocked: project.counts?.blocked ?? derivedBlocked,
    failed: project.counts?.failed ?? derivedFailed,
    progress: total ? Math.round(done / total * 100) : 0,
  }
}

/** The latest instant a project moved: its projected last activity, else the newest top-level task event. */
export function lastActivityOf(project: ProjectView, tasks: readonly TaskView[]): string | undefined {
  const values = [project.lastActivityAt, project.updatedAt, ...tasks.flatMap(task => [task.lastEventAt, task.endedAt, task.startedAt])]
    .filter((value): value is string => !!value)
    .sort()
  return values.at(-1)
}

/** Project-level issues, one per project, shown above its task attention and kept when the project is archived. */
export function projectIssueItems(projects: readonly ProjectView[]): ProjectIssueItem[] {
  return projects.flatMap(project => project.attention
    ? [{ project, attention: project.attention, at: project.attention.at ?? project.updatedAt }]
    : ownerMissing(project) ? [{ project, attention: { kind: 'worker' as const }, at: project.updatedAt }] : [])
    .sort((left, right) => (Date.parse(right.at ?? '') || 0) - (Date.parse(left.at ?? '') || 0))
}

export function sortedProjects(projects: readonly ProjectView[], board: TaskBoardView): ProjectView[] {
  const row = (project: ProjectView) => {
    const tasks = tasksOfProject(project, board)
    return { project, totals: totalsOf(project, tasks), at: Date.parse(lastActivityOf(project, tasks) ?? '') || 0 }
  }
  return projects.map(row).sort((left, right) => right.totals.attention - left.totals.attention
    || right.totals.blocked - left.totals.blocked || right.at - left.at || projectTitle(left.project).localeCompare(projectTitle(right.project)))
    .map(item => item.project)
}

/** One human action a pending root task asks for; derived from the existing decision/status, never a new state. */
export function actionOf(task: TaskView): ProjectAction {
  const decision = task.goal.decision?.kind
  if (decision === 'review' || task.status === 'review') return 'review'
  if (decision === 'answer' || task.status === 'answer') return 'answer'
  if (decision === 'delivery' || task.status === 'delivery' || task.status === 'failed' || task.status === 'blocked') return 'retry'
  return 'view'
}

/** Every pending root task across active and archived projects; archived items stay visible and are labelled. */
export function attentionItems(projects: readonly ProjectView[], board: TaskBoardView): ProjectAttentionItem[] {
  return projects.flatMap(project => tasksOfProject(project, board)
    .filter(task => task.attention)
    .map(task => ({ project, task, action: actionOf(task), at: task.lastEventAt ?? task.startedAt })))
    .sort((left, right) => (Date.parse(right.at ?? '') || 0) - (Date.parse(left.at ?? '') || 0))
}

/** The newest five one-line events for a project detail; the raw report body stays in the task detail. */
export function activityItems(project: ProjectView, tasks: readonly TaskView[], t: T): ProjectActivityItem[] {
  return tasks.filter(task => task.kind !== 'review')
    .map(task => ({ task, at: task.lastEventAt ?? task.endedAt ?? task.startedAt, text: activityText(task, t) }))
    .filter(item => item.at !== undefined)
    .sort((left, right) => Date.parse(right.at!) - Date.parse(left.at!))
    .slice(0, 5)
}

/** A short event sentence from the projected facts; no title or timestamp is invented when the report is absent. */
export function activityText(task: TaskView, t: T): string {
  const summary = task.review?.summary?.trim() || task.blocker?.detail?.trim()
  if (summary) return summary.length > 120 ? `${summary.slice(0, 120)}…` : summary
  return statusLabel(task, t)
}

/** The status vocabulary the project surfaces use, including the child-specific owner wording. */
export function statusLabel(task: Pick<TaskView, 'status' | 'parentTicketId'>, t: T): string {
  if (task.parentTicketId && task.status === 'review') return t('tasksParentReview')
  if (task.parentTicketId && (task.status === 'blocked' || task.status === 'failed')) return t('projectsChildWaitingOwner')
  if (task.status === 'blocked') return t('stage.blocked')
  if (task.status === 'failed') return t('stage.failed')
  return t(`activityStatus.${task.status}`)
}

/** Resolve a profile id through the read-only registry; the id itself never becomes the visible owner name. */
export function profileTitle(profiles: readonly ProfileRow[], profile: { id: string } | undefined): string | undefined {
  if (!profile) return undefined
  return profiles.find(row => row.id === profile.id && row.disabled !== true)?.title
}

/** A task's own owner in human words, with an explicit unknown when the record has no profile. */
export function taskOwnerLabel(task: Pick<TaskView, 'form' | 'owner'>, profiles: readonly ProfileRow[], t: T): string {
  if (task.form === 'lightweight') return t('projectsLightweightOwner')
  const profile = task.owner?.profile
  if (!profile) return t('projectsOwnerUnknown')
  const title = profileTitle(profiles, profile)
  return title ? t('taskDetailOwnerProfile', { title, revision: profile.revision }) : t('projectsOwnerUnknown')
}

/** A project's responsible worker; a missing or unresolved binding is unknown, never a default profile. */
export function projectOwnerLabel(project: ProjectView, profiles: readonly ProfileRow[], t: T): string {
  const profile = project.owner?.profile
  if (!profile) return t('projectsOwnerUnknown')
  const title = profileTitle(profiles, profile)
  return title ? t('taskDetailOwnerProfile', { title, revision: profile.revision }) : t('projectsOwnerUnknown')
}

/** One added owner issue for a project that cannot bind a worker; it is not a task's owner. */
export function ownerIssue(project: ProjectView): boolean {
  return ownerMissing(project)
}

/** Every task under a project's top-level rows, including loaded children, for a task-detail lookup. */
export function findTask(project: ProjectView, board: TaskBoardView, id: string,
  detailOf: (id: string) => { children: TaskView[] } | undefined): TaskView | undefined {
  const visit = (task: TaskView, depth: number): TaskView | undefined => {
    if (task.id === id) return task
    if (depth >= 5) return undefined
    const children = detailOf(task.id)?.children ?? task.children ?? []
    for (const child of children) {
      const found = visit(child, depth + 1)
      if (found) return found
    }
    return undefined
  }
  for (const task of tasksOfProject(project, board)) {
    const found = visit(task, 0)
    if (found) return found
  }
  return board.tasks.find(task => task.id === id)
}

/**
 * The tasks above one node inside its project, root first. A missing parent is reported separately so a breadcrumb can
 * say it is unknown instead of inventing a title; it never guesses from ids or plan labels.
 */
export function ancestorsOf(project: ProjectView, board: TaskBoardView, task: TaskView,
  detailOf: (id: string) => { children: TaskView[] } | undefined): { ancestors: TaskView[]; missingParent?: string } {
  const ancestors: TaskView[] = []
  const seen = new Set([task.id])
  let parentId = task.parentTicketId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = findTask(project, board, parentId, detailOf)
    if (!parent) return { ancestors, missingParent: parentId }
    ancestors.unshift(parent)
    parentId = parent.parentTicketId
  }
  return { ancestors }
}

/** The size of a pending list as a short, stable "n" for a card; the full list stays in the strip. */
export const countText = (count: number): string => String(count)

/** A due/updated time with the existing relative formatter, or an explicit unknown. */
export function updatedText(value: string | undefined, t: T): string {
  return value ? when(value, t('lang')) : t('projectsUnknownTime')
}