/**
 * Which task a Ticket belongs to, shared by the Tickets board and the Events tab.
 *
 * A Ticket already carries the facts that place it: its title or Mandate scope can name a task-plan id, a review
 * Ticket's title names the pull request it reviews, and a Ticket's reports publish the pull request it opened. The
 * derivation below reads those facts once per request; it stores nothing, so it works on records written before the
 * task board existed and cannot drift from the records it describes. It is display-only: it grants nothing, and no
 * authorization path reads it.
 */
import type { Ticket } from '@superagent/kernel'

/** The task-plan task a Ticket implements, read from its title or Mandate scope. */
export interface PlanRef {
  /** The milestone the task id names, such as `M2` for `T2-03`. */
  milestone: string
  /** The task id, such as `T2-03`. */
  task: string
  /** The Ticket title without the plan tag, used as the task's human name. */
  title: string
}

/** Where one Ticket sits in the task tree. */
export interface TicketOwnership {
  /** The Ticket this one is part of, such as a review under the Ticket that opened the pull request. */
  parent?: string
  /** The task-plan task it implements, from its own title or scope, else inherited from its parent. */
  plan?: PlanRef
  /** The pull request this Ticket reviews, when its title says so. */
  reviews?: { number: number }
}

/** A task id such as `T2-03`, in a title's parentheses or anywhere in a Mandate scope. */
const PLAN_TITLE = /[（(]\s*T(\d+)-(\d+)\s*[）)]/
const PLAN_SCOPE = /\bT(\d+)-(\d+)\b/
/** A review Ticket's title: `review PR #8`, `复核 PR #11`, `审查 PR #3`; a round suffix is ignored. */
const REVIEW_TITLE = /^(?:review|复核|审查)\s+(?:of\s+)?PR\s*#\s*(\d+)/i
/** A pull request URL in a report or scope; the repository is kept out because a review title names only the number. */
const PR_URL = /github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/gi

const stripPlanTag = (title: string): string => title.replace(PLAN_TITLE, '').replace(/[（(]\s*[）)]/g, '')
  .replace(/[\s:：,，;；\-—]+$/u, '').trim()

/** The task-plan reference a Ticket's own title or Mandate scope names. */
export function planOf(ticket: Ticket): PlanRef | undefined {
  const titled = PLAN_TITLE.exec(ticket.title)
  const scoped = titled ? undefined : PLAN_SCOPE.exec(ticket.mandate.scope ?? '')
  const match = titled ?? scoped
  if (!match) return undefined
  const [, milestone, task] = match
  const title = stripPlanTag(ticket.title)
  return { milestone: `M${milestone}`, task: `T${milestone}-${task}`, title: title || `T${milestone}-${task}` }
}

/** The pull request a review Ticket's title names. */
export function reviewedPr(ticket: Pick<Ticket, 'title'>): { number: number } | undefined {
  const match = REVIEW_TITLE.exec(ticket.title)
  return match ? { number: Number(match[1]) } : undefined
}

/** Whether a Ticket is a review of a pull request rather than the work that opened it. */
export const isReviewTicket = (ticket: Pick<Ticket, 'title'>): boolean => reviewedPr(ticket) !== undefined

/**
 * The pull requests a Ticket published in its latest report or Mandate scope. Reports link the pull request the Ticket
 * opened; a review Ticket links the review it posted there too, which is why reviews never enter this index.
 */
function publishedPrs(ticket: Ticket): number[] {
  const reports = ticket.assignments.flatMap(assignment => assignment.report ? [assignment.report.summary] : []).join('\n')
  const sources = `${reports}\n${ticket.mandate.scope ?? ''}`
  const numbers = new Set<number>()
  for (const match of sources.matchAll(PR_URL)) numbers.add(Number(match[1]))
  return [...numbers]
}

/**
 * One request's ownership index: the task plan reference of every Ticket, the Ticket that opened each pull request,
 * and the parent of every review Ticket. Built once so a page of events or one task tree does not rescan the store.
 */
export class OwnershipIndex {
  private readonly ownership = new Map<string, TicketOwnership>()
  private readonly children = new Map<string, Ticket[]>()
  constructor(readonly tickets: readonly Ticket[]) { this.build() }
  /** Where the Ticket sits; a Ticket with no facts that place it has an empty placement, never a guess. */
  of(id: string): TicketOwnership { return this.ownership.get(id) ?? {} }
  /** The Ticket whose task a record belongs to: the reviewed Ticket for a review, otherwise the Ticket itself. */
  owner(ticket: Pick<Ticket, 'id'>): Ticket | undefined {
    const parent = this.of(ticket.id).parent
    return this.tickets.find(item => item.id === (parent ?? ticket.id))
  }
  /** The review Tickets that belong to a Ticket, newest first. */
  reviewsOf(id: string): Ticket[] {
    return [...this.children.get(id) ?? []].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }
  private build(): void {
    const plans = new Map(this.tickets.map(ticket => [ticket.id, planOf(ticket)]))
    const byPr = new Map<number, Ticket[]>()
    for (const ticket of this.tickets) {
      if (isReviewTicket(ticket)) continue
      for (const number of publishedPrs(ticket)) byPr.set(number, [...byPr.get(number) ?? [], ticket])
    }
    const place = new Map<string, TicketOwnership>()
    for (const ticket of this.tickets) {
      const reviewed = reviewedPr(ticket)
      const candidates = reviewed ? (byPr.get(reviewed.number) ?? []) : []
      // A pull request number can repeat across repositories; only a sole Ticket that published it is unambiguous.
      const parent = candidates.length === 1 ? candidates[0]
        : reviewed ? soleSameTask(ticket, this.tickets, plans) : undefined
      place.set(ticket.id, { ...parent ? { parent: parent.id } : {}, ...reviewed ? { reviews: reviewed } : {} })
    }
    for (const ticket of this.tickets) {
      const parent = place.get(ticket.id)?.parent
      const plan = plans.get(ticket.id) ?? (parent === undefined ? undefined : plans.get(parent))
      this.ownership.set(ticket.id, { ...place.get(ticket.id)!, ...plan ? { plan } : {} })
      if (parent) this.children.set(parent, [...this.children.get(parent) ?? [], ticket])
    }
  }
}

/** The only non-review Ticket of a review Ticket's own task, when no pull request published the number. */
function soleSameTask(ticket: Ticket, tickets: readonly Ticket[], plans: Map<string, PlanRef | undefined>): Ticket | undefined {
  const plan = plans.get(ticket.id)
  if (!plan) return undefined
  const siblings = tickets.filter(item => item.id !== ticket.id && !isReviewTicket(item) && plans.get(item.id)?.task === plan.task)
  return siblings.length === 1 ? siblings[0] : undefined
}

export const ownershipIndex = (tickets: readonly Ticket[]): OwnershipIndex => new OwnershipIndex(tickets)