/** Builds the application's collaborators in one explicit dependency order, so `Runtime` keeps only lifecycle and its SourceHost surface. */
import type { Context } from '@deepseek-ai/cordis'
import { Engine, key, type EngineForSettings, type Ticket, type Trigger } from '@superagent/kernel'
import { settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { Machine } from '../deployment.ts'
import { environmentOf, type Variable } from './execution-environment.ts'
import { DshExecutor } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import type { Health, SourceContext } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

/** What the composition root lends the assembly: live host state and the few operations that stay on `Runtime`. */
export interface AssemblyHost {
  readonly ctx: Context
  readonly machine: Machine
  /** The health entries every collaborator claims, owned by the Runtime so they outlive a restart of any one part. */
  readonly board: HealthBoard
  /** The `runtime` health entry, which setup and the pass loop report through. */
  readonly runtimeHealth: HealthEntry
  /** Aborted when dsh-superagent stops or loses its state directory lock. */
  readonly lifetime: AbortSignal
  readonly restart: () => void
  closing(): boolean
  /** True while paused or awaiting setup: evaluation, dispatch and outbound delivery wait, Sources keep recording. */
  paused(): boolean
  /** True while a main-Session tool runs an Engine command, which suppresses self-caused event notices. */
  quiet(): boolean
  quietly<T>(run: () => T): T
  /** The startup promise; resolved after setup, session creation and Policy sync. */
  ready(): Promise<void>
  requestPass(): void
  context(kind: { kind: string; health: readonly string[] }): SourceContext
  ticketEnvironment(ticket: Ticket): Variable[]
}

interface Parts {
  setup: Setup
  prompts: Prompts
  effects: Effects
  sources: SourceRegistry
  commands: Commands
  sessions: Sessions
  settings: Settings
  executor: DshExecutor
  assessor: MasterAssessor
  outbox: Outbox
  engine: Engine
  passes: Passes
  masterId: string
  sourceLinks: TextCache
  links: LinkHost
  resources: ResourceHost
  link: (trigger: Trigger, signal?: AbortSignal) => ReturnType<typeof sourceLink>
  environment: (ticket: Ticket) => Variable[]
  sourceDeps: SourceContextDeps
  toolHost: MainToolsHost & ExecutorToolsHost
}

/** The collaborators, in the order they were built; every field is assigned before anyone reads it. */
export type Assembled = Readonly<Parts>

/**
 * Assembles the domain Engine, the five host-side services, the Executor and the Assessor around an open `Store`.
 * The order is the dependency order: a collaborator is constructed only after everything its constructor reads exists,
 * and the few genuine cycles (the Engine's events reach Sessions; Sessions reach the tool host) stay late-bound.
 */
export function assemble(host: AssemblyHost, store: Store): Assembled {
  const parts = {} as Parts
  const { ctx, machine, board, lifetime } = host
  const setup = parts.setup = new Setup({ context: ctx, machine, lifetime, restart: host.restart })
  const deployed = () => setup.configured()
    ? environmentOf({ deployment: setup.deployment, sources: parts.sources, settings: store.settings() }) : undefined
  const feishu = () => setup.configured() && !!setup.deployment.feishu
  const prompts = parts.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
  const masterId = parts.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
  store.set(KV.runtime.masterId, masterId)
  const commands = parts.commands = new Commands(() => setup.deployment, setup.commandEnvironment, lifetime)
  const effects = parts.effects = new Effects(store, board)
  const sources = parts.sources = new SourceRegistry(() => store.settings(), board, kind => {
    // Sync source member lists once startup completes when a source plugin loads dynamically.
    if (kind.policy?.sync) void host.ready().then(() => parts.settings.syncable().includes(kind.kind) ? parts.settings.sync(kind.kind) : undefined)
      .catch(() => { /* sync() records its failure in health. */ })
    return () => {}
  })
  const sourceLinks = parts.sourceLinks = new TextCache(200_000)
  const links = parts.links = { store, links: sourceLinks, commands, sources, lifetime }
  const link = parts.link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
  const environment = parts.environment = (ticket: Ticket) => host.ticketEnvironment(ticket)
  const resources = parts.resources = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
    promptVersion: id => parts.sessions.promptVersion(id), mayRead: (id, revision) => parts.sessions.mayRead(id, revision),
    feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
  const sessions = parts.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
    lifetime,
    closing: () => host.closing(), environment,
    tools: (agent, ticket) => ticket ? executorTools(parts.toolHost, ticket) : mainTools(parts.toolHost, agent) })
  const policyChanged: EngineForSettings['policyChanged'] = (from, to, changed) => { parts.engine.policyChanged(from, to, changed) }
  const settings = parts.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime, sessions,
    sourceHost: { sources, context: kind => sourceContextOf(parts.sourceDeps, kind) }, setup, requestPass: () => { host.requestPass() } })
  const executor = parts.executor = new DshExecutor({ context: ctx, get engine() { return parts.engine }, store, effects,
    health: board.claim('worker'), machine, lifetime, sessions, closing: () => host.closing(), paused: () => host.paused(), environment,
    sourceLink: link, repliedTo: trigger => repliedTo({ store, sources }, trigger) })
  const assessor = parts.assessor = new MasterAssessor({ get engine() { return parts.engine }, commands, get deployment() { return setup.deployment },
    effects, settings: () => store.settings(), paused: () => host.paused(), threadContext: trigger => sources.threadContext(trigger),
    deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
  const outbox = parts.outbox = new Outbox({ store, effects, sources, commands, paused: () => host.paused() })
  const policy = () => settingsPolicy(store.settings(), sources)
  const engine = parts.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, outbox,
    prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
      // Notify the main Session only about domain events it did not initiate itself.
      const notice = host.quiet() ? undefined : eventNotice(event, id => store.tickets.get(id))
      if (notice) sessions.notify(...notice)
      // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
      // and of one for an ended ticket once it resumes, unless it routed the message there itself.
      const followed = !host.quiet() && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
      const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
      if (followup) sessions.relay(followup.id, followup.text)
      // Notify the ticket's conversations whenever it ends via a pull request.
      const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
      if (ended && setup.configured()) {
        const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
        for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
      }
    } })
  // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
  const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
  const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
  const passes = parts.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
    health: host.runtimeHealth, lifetime, configured: () => setup.configured(), closing: () => host.closing() })
  parts.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return host.ready() },
    get deployment() { return setup.deployment }, configured: () => setup.configured(),
    get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
  parts.toolHost = { context: ctx, engine, store, prompts, sessions, settings, assessor, resources,
    get github() { return host.context({ kind: 'github', health: ['github'] }) },
    requestPass: () => { host.requestPass() }, sendReplies: () => outbox.sent(),
    quietly: run => host.quietly(run) }
  return parts
}
