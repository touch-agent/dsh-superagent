/**
 * The read-only Goals surface: one Goal per Ticket, derived by the kernel and exposed by `GET goals` / `GET goals/:id`.
 * Nothing here writes, authorizes or persists: the routes are a view over Tickets that already exist, and the same
 * projection feeds the main Session's result card and the task row.
 */
import { goalOf, type Goal, type Ticket } from '@superagent/kernel'

/** A Goal plus the read resource a caller can fetch for the same projection. */
export interface GoalView extends Goal { read: string }

/** One request's goal list: root Tickets, newest first, with the counts a person scans. */
export interface GoalBoardView {
  generatedAt: string
  goals: GoalView[]
  totals: { goals: number; open: number; attention: number }
}

/** The Store reads the projection needs; every other Store capability stays out of this module. */
export interface GoalReadHost {
  readonly store: { tickets: { allList(): Ticket[]; get(id: string): Ticket | undefined } }
}

/** The same Goal shape everywhere, so a card and a task row cannot describe one Ticket differently. */
export const goalView = (ticket: Ticket): GoalView => ({ ...goalOf(ticket), read: `ticket/${ticket.id}` })

/** Every root Ticket's Goal, newest update first; child Tickets stay reachable by id and in their root's E1 tree. */
export function goalBoard(host: GoalReadHost, now = new Date()): GoalBoardView {
  const roots = host.store.tickets.allList().filter(ticket => !ticket.parentTicketId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
  const goals = roots.map(goalView)
  return { generatedAt: now.toISOString(), goals,
    totals: { goals: goals.length, open: roots.filter(ticket => !ticket.ended).length,
      attention: goals.filter(goal => goal.decision !== undefined).length } }
}

/** One Ticket's Goal, including a child Ticket; `undefined` only when no such Ticket exists. */
export function goalDetail(host: GoalReadHost, id: string): GoalView | undefined {
  const ticket = host.store.tickets.get(id)
  return ticket ? goalView(ticket) : undefined
}