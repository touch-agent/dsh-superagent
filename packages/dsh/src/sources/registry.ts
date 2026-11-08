/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceManifest, SourceScope, Trigger } from '@superagent/kernel'
import type { Commands } from '../infra/commands.ts'
import type { ConversationHost } from './host.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import type { ChannelLink, ChannelLinks, ProbeAnswer, SourceAdapter, SourceDefinition, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'
import { manifestForm, type SourceForm } from './manifest-form.ts'
import { parseSourceManifest } from './manifest-schema.ts'

/** One registered Source: the adapter, plus the manifest it was registered with or the flat kind it still registers as until T1-10. */
interface Registration<C extends Record<string, unknown> = Record<string, unknown>> {
  id: string
  adapter: SourceAdapter<C>
  manifest?: SourceManifest
  kind?: SourceKind<C>
}

/**
 * Manages registered Sources, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * A Source registers either as a manifest with its adapter or, while kinds migrate, as a flat SourceKind; both are stored as
 * one registration; `kind()` presents either as the flat view runtime consumers read, and `form()` presents the panel model
 * derived from the manifest. Claims each registration's health entries on HealthBoard and mediates access to source channels,
 * links, environment variables and thread context readers for Runtime, Settings, Outbox and MasterAssessor.
 */
export class SourceRegistry implements SourceScope {
  private readonly registrations = new Map<string, Registration>()
  private readonly views = new Map<string, SourceKind>()
  private readonly health = new Map<string, HealthEntry>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {},
    /** Delivery into the main Session, used by the built-in conversation Channel; absent outside the runtime. */
    private readonly deliver: ConversationHost['deliver'] = async () => { throw new Error('Conversation delivery is unavailable in this context') }) {}

  /** Registers a flat SourceKind (the pre-manifest path T1-10 retires), claims its health entries and returns an unregister disposer. */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    return this.add({ id: kind.kind, adapter: kind, kind })
  }

  /** Registers a manifest with the adapter that implements it; the manifest is validated here, so a broken Source fails at load rather than in the panel. */
  registerDefinition<C extends Record<string, unknown>>(definition: SourceDefinition<C>): () => void {
    const manifest = parseSourceManifest(definition.manifest)
    return this.add({ id: manifest.id, adapter: definition.adapter, manifest })
  }

  private add<C extends Record<string, unknown>>(registration: Registration<C>): () => void {
    const { id } = registration
    if (this.registrations.has(id)) throw new Error(`Source kind already registered: ${id}`)
    const declared = registration.manifest?.health ?? registration.kind!.health
    const refused = (name: string) => new Error(`Source kind ${id} declares the health entry ${name}, which another part reports`)
    const synced = declared.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const release = () => { for (const [name, entry] of entries) { entry.release(); this.health.delete(name) } }
    for (const name of declared) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.registrations.set(id, registration)
    const unregistered = this.registered(this.kind(id)!)
    return () => { this.registrations.delete(id); this.views.delete(id); release(); unregistered() }
  }

  /**
   * Returns the active health entries for `names`. A Source context writes through the entries it received when built,
   * so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(names: readonly string[]): Map<string, HealthEntry> {
    return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
  }
  /** The registered Source as the flat view its consumers read; a definition is rendered from its manifest and adapter. */
  kind(id: string): SourceKind | undefined {
    const cached = this.views.get(id)
    if (cached) return cached
    const registration = this.registrations.get(id)
    if (!registration) return undefined
    const view = registration.kind ?? this.viewOf(registration)
    this.views.set(id, view)
    return view
  }
  private viewOf(registration: Registration): SourceKind {
    const manifest = registration.manifest!
    return { ...registration.adapter, kind: registration.id, title: manifest.title, description: manifest.description,
      fields: [...manifest.fields], health: [...manifest.health] } as SourceKind
  }
  /**
   * The panel model a registered Source yields: its manifest projected by `manifestForm`, so the panel reads fields, sign-in
   * fields, health entries and polling defaults from the declaration rather than from the flat kind view. A kind still
   * registering the pre-manifest way presents the equivalent form with no sign-in fields and no declared limits.
   */
  form(id: string): SourceForm | undefined {
    const registration = this.registrations.get(id)
    if (!registration) return undefined
    if (registration.manifest) return manifestForm(registration.manifest)
    const kind = registration.kind!
    return { id: kind.kind, title: kind.title, description: kind.description, fields: kind.fields,
      auth: { kind: 'none', fields: [] }, health: kind.health, limits: undefined }
  }
  /** Every registered kind's instance ordered by ID, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const installed = [...this.registrations.values()].sort((a, b) => a.id.localeCompare(b.id))
      .map(registration => ({ ...this.resolve(registration, settings.sources[registration.id]), installed: true }))
    const orphaned = Object.entries(settings.sources).filter(([id]) => !this.registrations.has(id))
      .map(([id, stored]) => ({ id, kind: id, enabled: stored.enabled, config: stored.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const registration = this.registrations.get(id)
    return registration ? this.resolve(registration, settings.sources[id]) as SourceInstance<C> : undefined
  }
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const registration = this.registrations.get(id)
    if (!registration) throw new Error(`Source kind not installed: ${id}`)
    return { enabled: value.enabled, config: registration.adapter.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy against its adapter; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.registrations.get(id)?.adapter.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.registrations.get(id)?.adapter.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  /** Whether a kind is a built-in local Source whose authenticated user needs no roster. */
  trusted(id: string): boolean {
    return this.registrations.get(id)?.adapter.trusted === true
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const registration = this.registrations.get(channel.source)
    if (!registration) return false
    const instance = this.resolve(registration, settings.sources[channel.source])
    return instance.enabled && (registration.adapter.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.registrations.values()].sort((a, b) => a.id.localeCompare(b.id))
      .flatMap(registration => registration.adapter.environment ? [{ kind: registration.id, variables: registration.adapter.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return [...this.registrations.values()].sort((a, b) => a.id.localeCompare(b.id)).flatMap(registration => {
      const instance = this.resolve(registration, settings.sources[registration.id])
      const environment = registration.adapter.environment
      return environment && instance.enabled ? [{ kind: this.kind(registration.id)!, environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its Channel's kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const registration = this.registrations.get(message.channel.source)
    if (!registration) return 'waiting'
    const conversation: ConversationHost = { deliver: (requestId, text) => this.deliver(requestId, text) }
    return registration.adapter.channel ? registration.adapter.channel.send({ commands, conversation }, message) : 'gone'
  }
  /**
   * Asks a message's Channel whether it is already at the remote service, before a retry whose earlier attempt may have
   * reached it. Answers nothing when the kind has no probe, so the caller retries as before.
   */
  async probe(message: OutboundMessage, commands: Commands): Promise<ProbeAnswer | undefined> {
    return this.registrations.get(message.channel.source)?.adapter.channel?.probe?.({ commands }, message)
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const link = this.registrations.get(channel.source)?.adapter.channel?.link(channel.address, links)
    return link ?? { url: '', label: { zh: channel.source, en: channel.source } }
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.registrations.values()].flatMap(registration => registration.adapter.find ? [registration.adapter.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.registrations.get(trigger.source)?.adapter.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const registration = this.registrations.get(trigger.source)
    const context = registration?.adapter.threadContext
    if (!registration || !context) return undefined
    const { config } = this.resolve(registration, settings.sources[registration.id])
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${registration.id} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const registration = this.registrations.get(input.source)
    const stored = settings.sources[input.source]
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!registration) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(registration, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return registration.adapter.scope ? registration.adapter.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(registration: Registration, stored: { enabled: boolean; config: Record<string, unknown> } | undefined): SourceInstance {
    const parsed = registration.adapter.schema.safeParse(stored?.config ?? {})
    return { id: registration.id, kind: registration.id, enabled: parsed.success && (stored?.enabled ?? true),
      config: parsed.success ? parsed.data : registration.adapter.schema.parse({}) }
  }
}
