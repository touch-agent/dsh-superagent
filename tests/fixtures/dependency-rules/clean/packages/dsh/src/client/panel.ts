import type { ApiRequest } from '../app/api.ts'
import { TICKET_FILTERS } from '../app/api.ts'
import type { TaskView } from '../app/tasks.ts'
import { HEALTH_TEXT } from '../sources/host.ts'
import { local } from './local.ts'

export const panel = (task: TaskView, request: ApiRequest): string =>
  `${local}:${TICKET_FILTERS[0]}:${HEALTH_TEXT}:${task.id}:${request.path}`
