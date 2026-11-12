/** Plain value lists the panel may import from `api.ts` without pulling host code into the browser bundle. */
export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
/** A Ticket list narrowed by where the accepted request came from. */
export type TicketOrigin = 'conversation'
export type ThreadFilter = typeof THREAD_FILTERS[number]
