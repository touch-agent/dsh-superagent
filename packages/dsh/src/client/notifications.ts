/**
 * UX batch 1's notice projection: the same `GET overview` the panel already reads, turned into at most a few actionable
 * notices grouped by "needs you / progress / system". Nothing here writes, creates an entity or grants an action: a
 * notice is a view of an Approval, a Ticket, a delivery or a health problem that already exists. When the underlying
 * problem clears, its notice disappears on the next poll.
 */
import type { OverviewView, Problem, TicketRow } from './api.ts'
import type { Route } from './route.ts'
import { featureEnabled } from './features.ts'
import { healthText, localized, reasonLabel, valueLabel, when, type T } from './text.ts'

export type NoticeKind = 'attention' | 'progress' | 'system'
export type NoticeActionKey = 'approve' | 'deny' | 'retry' | 'view' | 'route' | 'disable-source' | 'open-source'
  | 'requeue' | 'dismiss'

/** One in-place action; the id it carries is the record the action changes, never a second source of truth. */
export interface NoticeAction {
  key: NoticeActionKey
  label: string
  approvalId?: string
  ticketId?: string
  sourceId?: string
  triggerId?: string
  decisionId?: string
  route?: Route
  tone?: 'primary' | 'danger'
}

/** One derived notice. `what`, `next` and `consequence` answer the three E0 questions; none names an internal Session. */
export interface Notice {
  id: string
  kind: NoticeKind
  title: string
  what: string
  next: string
  consequence: string
  at: string
  actions: NoticeAction[]
  /** Expanded detail lines; a folded system notice keeps every underlying problem readable here. */
  details?: string[]
  /** Consecutive automatic retries (a Source poll) or delivery attempts, when the projection carries them. */
  attempts?: number
  /** The latest time the underlying problem or delivery last tried. */
  lastAt?: string
  /** Whether a newly seen notice may interrupt with a floating card. */
  pop: boolean
}

const newest = (...values: (string | undefined)[]): string =>
  values.filter((value): value is string => !!value).sort().at(-1) ?? ''

const countOf = (health: { values?: Record<string, string> }): number | undefined => {
  const value = Number(health.values?.count)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** One line for a folded problem; the raw detail stays a detail, not a substitute for the human sentence. */
function detailOf(problem: Problem, t: T): string {
  switch (problem.kind) {
    case 'setup': return t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup')
    case 'no-source': return t('problemNoSource')
    case 'no-allowed': return t('problemNoAllowed')
    case 'executor-paused': return t('problemPaused')
    case 'runtime-error': return t('problemRuntime', { name: valueLabel(t, 'health', problem.name) })
    case 'source-error': return `${t('sourceError', { source: localized(t, problem.source.title) })} · ${healthText(t,
      problem.source.health)}`
    case 'eval-overdue': return t('problemEvalOverdue', { thread: problem.thread.title })
    case 'eval-unavailable': return `${t('problemEvalUnavailable', { thread: problem.thread.title })} · ${reasonLabel(t,
      problem.reason)}`
    case 'outgoing': return t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts })
  }
}

const failedTask = (ticket: TicketRow): boolean =>
  ticket.stage === 'person' && (ticket.action === 'failed' || ticket.action === 'blocked')

const questionOf = (ticket: TicketRow): string | undefined => ticket.attention?.question?.trim() || undefined
/** The list row is a union of plan and Ticket rows; only a person-stage row carries the action this slice reads. */
const actionOf = (ticket: TicketRow): string | undefined => 'action' in ticket ? ticket.action : undefined

/** A stable identity for a folded problem, so the aggregate notice changes only when its members do. */
function problemKey(problem: Problem): string {
  switch (problem.kind) {
    case 'source-error': return `source:${problem.source.id}`
    case 'eval-overdue': return `overdue:${problem.thread.key}`
    case 'eval-unavailable': return `unavailable:${problem.decisionId}`
    case 'outgoing': return `outgoing:${problem.outgoing.id}`
    case 'runtime-error': return `runtime:${problem.name}`
    case 'setup': return `setup:${problem.place ?? ''}`
    default: return problem.kind
  }
}

/** One line for a failed or blocked task folded into the system notice. */
function taskDetailOf(ticket: TicketRow, t: T): string {
  const reason = ticket.note?.text?.trim()
  const stage = t(actionOf(ticket) === 'blocked' ? 'stage.blocked' : 'stage.failed')
  return reason ? `${ticket.title} · ${stage} · ${reason}` : `${ticket.title} · ${stage}`
}

/**
 * Build the notices the panel shows. Approvals and a person's answer/review stay separate because each is one decision;
 * system problems and failed tasks fold into one row so a noisy Source cannot bury the rest. A recovered problem is
 * simply absent from the next answer, which is how its card and row disappear.
 */
export function noticeItems(data: OverviewView, t: T): Notice[] {
  const items: Notice[] = []
  for (const approval of data.approvals) items.push({
    id: `approval:${approval.id}`, kind: 'attention', pop: true, at: approval.requestedAt,
    title: t('noticeApprovalTitle', { task: approval.ticket.title }),
    what: t('noticeApprovalWhat', { task: approval.ticket.title, level: valueLabel(t, 'level', approval.action.level),
      source: valueLabel(t, 'source', approval.action.source) }),
    next: t('noticeApprovalNext', { effect: valueLabel(t, 'levelEffect', approval.action.level) }),
    consequence: t('noticeApprovalConsequence'),
    actions: [
      { key: 'approve', label: t('approve'), approvalId: approval.id, tone: 'primary' },
      { key: 'deny', label: t('deny'), approvalId: approval.id, tone: 'danger' },
      { key: 'view', label: t('noticeViewTask'), ticketId: approval.ticket.id },
    ],
  })
  for (const ticket of data.person.filter(ticket => !failedTask(ticket))) {
    const action = actionOf(ticket)
    const answer = action === 'answer'
    const review = action === 'review'
    const what = answer ? t('noticeAnswerWhat', { task: ticket.title, question: questionOf(ticket) ?? t('noticeNoQuestion') })
      : review ? t('noticeReviewWhat', { task: ticket.title, summary: ticket.note?.text?.trim() || ticket.summary || t('noticeNoSummary') })
      : t('noticeDeliveryWhat', { task: ticket.title })
    items.push({
      id: `ticket:${ticket.id}`, kind: 'attention', pop: true, at: ticket.updatedAt,
      title: answer ? t('noticeAnswerTitle', { task: ticket.title })
        : review ? t('noticeReviewTitle', { task: ticket.title }) : t('noticeDeliveryTitle', { task: ticket.title }),
      what, next: t('noticePersonNext'), consequence: t('noticePersonConsequence'),
      actions: [{ key: 'view', label: t('noticeViewTask'), ticketId: ticket.id, tone: 'primary' }],
    })
  }
  for (const ticket of data.recent) {
    const outcome = ticket.ended?.outcome
    items.push({
      id: `result:${ticket.id}`, kind: 'progress', pop: true, at: ticket.ended?.at ?? ticket.updatedAt,
      title: t('noticeResultTitle', { task: ticket.title }),
      what: t('noticeResultWhat', { task: ticket.title, outcome: outcome ? t(`outcome.${outcome}`) : t('noticeDone') }),
      next: t('noticeResultNext'), consequence: t('noticeResultConsequence'),
      actions: [{ key: 'view', label: t('noticeViewResult'), ticketId: ticket.id }],
    })
  }
  const sourceErrors = data.problems.filter((problem): problem is Extract<Problem, { kind: 'source-error' }> =>
    problem.kind === 'source-error')
  const otherProblems = data.problems.filter(problem => problem.kind !== 'source-error')
  const failed = data.person.filter(failedTask)
  if (!sourceErrors.length && !otherProblems.length && !failed.length) return items
  const attempts = Math.max(0, ...sourceErrors.map(problem => countOf(problem.source.health) ?? 0),
    ...otherProblems.map(problem => problem.kind === 'outgoing' ? problem.outgoing.attempts : 0))
  const lastAt = newest(...sourceErrors.map(problem => problem.source.health.at), ...failed.map(ticket => ticket.updatedAt),
    ...otherProblems.map(problem => problem.kind === 'eval-overdue' || problem.kind === 'eval-unavailable'
      ? problem.thread.lastAt : undefined))
  const sources = [...new Map(sourceErrors.map(problem => [problem.source.id, problem.source])).values()]
  const details = [
    ...sourceErrors.map(problem => detailOf(problem, t)),
    ...failed.map(ticket => taskDetailOf(ticket, t)),
    ...otherProblems.map(problem => detailOf(problem, t)),
  ]
  const actions: NoticeAction[] = []
  // One in-place recovery action is enough for a folded row; every other task stays in the details list with its own buttons.
  const firstFailed = failed[0]
  if (firstFailed) actions.push(firstFailed.actions.retry
    ? { key: 'retry', label: t('noticeRetryTask', { task: firstFailed.title }), ticketId: firstFailed.id, tone: 'primary' }
    : { key: 'view', label: t('noticeViewTask', { task: firstFailed.title }), ticketId: firstFailed.id, tone: 'primary' })
  if (sources[0]) actions.push({ key: 'disable-source', label: t('noticeDisableSource', { source: localized(t, sources[0].title) }),
    sourceId: sources[0].id, tone: 'danger' })
  if (sources[0]) actions.push({ key: 'open-source', label: t('noticeOpenSource'), sourceId: sources[0].id })
  const unavailable = otherProblems.find(problem => problem.kind === 'eval-unavailable')
  if (unavailable?.kind === 'eval-unavailable') {
    actions.push({ key: 'requeue', label: t('requeue'), triggerId: unavailable.triggerId })
    actions.push({ key: 'dismiss', label: t('dismiss'), decisionId: unavailable.decisionId })
  }
  actions.push({ key: 'route', label: t('noticeViewProblems'), route: { page: 'overview' } })
  items.push({
    // The id follows the underlying records, so a newly failing Source or task is a new notice while a health update is not.
    id: `system:${[...sourceErrors.map(problem => `source:${problem.source.id}`), ...failed.map(ticket => `task:${ticket.id}`),
      ...otherProblems.map(problem => problemKey(problem))].join('|')}`, kind: 'system', pop: true, at: lastAt,
    title: t('noticeSystemTitle', { count: details.length }),
    what: lastAt ? t('noticeSystemWhat', { sources: sources.length, tasks: failed.length, problems: otherProblems.length,
      time: when(lastAt, t('lang')) }) : t('noticeSystemWhatNoTime', { sources: sources.length, tasks: failed.length,
      problems: otherProblems.length }),
    next: attempts ? t('noticeSystemNext', { attempts }) : t('noticeSystemNextNoAttempts'),
    consequence: t('noticeSystemConsequence'),
    actions, details, ...attempts ? { attempts } : {}, ...lastAt ? { lastAt } : {},
  })
  return items
}

/** Unread means "not in this browser's read set"; results still count once a person has read or acted on them. */
export const unreadOf = (items: readonly Notice[], read: ReadonlySet<string>): number =>
  items.filter(item => !read.has(item.id)).length

/** Keep every notice id this browser has seen, so a reload does not interject cards for old work. */
export const seenIds = (read: ReadonlySet<string>, items: readonly Notice[]): ReadonlySet<string> =>
  new Set([...read, ...items.map(item => item.id)])

/** The feature switches read once per mount; a change takes effect on refresh, like the other panel switches. */
export const notificationFlags = () => ({ drawer: featureEnabled('ux.notifyDrawer.v1'), overlay: featureEnabled('ux.notifyOverlay.v1'),
  aggregate: featureEnabled('ux.errorAggregate.v1'), hierarchy: featureEnabled('ux.taskHierarchy.v1') })