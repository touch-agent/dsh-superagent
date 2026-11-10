/**
 * The DSH tools an Executor Session may work with, independent of which profile selects them. The list is the role's
 * capability ceiling; a profile may narrow it, never widen it. Protocol tools registered by the executor (such as
 * `orchestrator_report`) are not in this list: a worker always keeps them, because it must be able to report and end.
 */
export const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** A child Ticket's owner may not start or message other Sessions: it reports only to its parent owner through the Engine. */
export const CHILD_DENIED = new Set(['subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent'])
/** The work tools a profile may list: the role ceiling, sorted and de-duplicated for a stable schema and hash. */
export const WORK_TOOL_NAMES: readonly string[] = [...new Set(WORK_TOOLS)].sort()