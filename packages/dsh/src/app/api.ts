/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ReplyStatus } from '@superagent/kernel'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { MetricsView } from './metrics.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { TicketTimelineView } from './views/timeline.ts'
import type { TriggerTraceView } from './views/trace.ts'
import type { ActivityFeed, ActivityLevel } from './activity.ts'
import type { TaskBoardView, TaskDetailView } from './tasks.ts'
import type { SpaceRowsView } from './spaces.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
/** A Ticket list narrowed by where the accepted request came from. */
export type TicketOrigin = 'conversation'
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET metrics': { response: MetricsView }
  'GET activity': { query?: { after?: number; limit?: number; level?: ActivityLevel }; response: ActivityFeed }
  'GET tasks': { response: TaskBoardView }
  'GET spaces': { response: SpaceRowsView }
  'GET tasks/:id': { query?: { depth?: number }; response: TaskDetailView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'GET triggers/:id/trace': { response: TriggerTraceView }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter; origin?: TicketOrigin }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'GET tickets/:id/timeline': { response: TicketTimelineView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST tickets/:id/approve': { body: { reviewRevision: string }; response: { approved: true; reviewRevision: string } }
  'POST outbox/:id/recall': { response: { status: ReplyStatus } }
  'POST approvals/:id/approve': { body: { level?: ApprovalRow['action']['level'] };
    response: { state: 'approved'; level: ApprovalRow['action']['level'] } }
  'POST approvals/:id/deny': { response: { state: 'denied' } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
/** One Approval waiting for a person, as `GET overview` returns it. */
export type ApprovalRow = ApiResponse<'GET overview'>['approvals'][number]
