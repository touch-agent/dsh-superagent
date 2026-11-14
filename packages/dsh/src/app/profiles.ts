/**
 * The AgentProfile registry: immutable, versioned execution configurations, their mutable heads, the built-in compatible
 * profile, and the immutable snapshot a Ticket binds. A profile describes only execution — role, model policy, work-tool
 * policy, prompt reference and an evaluation-baseline declaration. It is never authorization: it has no action level,
 * approval, sender, Mandate or credential field, and the strict schema rejects those names rather than ignoring them.
 *
 * Definitions and heads live in KV, so the strict `SettingsSchema` is untouched and an older binary still starts. Phase 1
 * writes no new table and changes no schema version.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { UserError, type AgentProfile, type ProfileHead, type ProfileModelPolicy, type ProfileResolvedModel, type ProfileRunEffective,
  type ProfileSelection, type ProfileSnapshot, type Ticket } from '@superagent/kernel'
import { KV, type ProfilesConfig } from '../kv.ts'
import { policyVersion, type Settings } from '../policy.ts'
import type { PromptVersion, Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { SUBAGENT_CONTROL, WORK_TOOL_NAMES } from './work-tools.ts'

const require = createRequire(import.meta.url)
/** The installed DSH version, recorded in every effective hash; `unknown` when the host package exposes no package.json. */
function installedDshVersion(): string {
  for (const name of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-agent/package.json']) {
    try {
      const value = require(name) as { version?: unknown }
      if (typeof value.version === 'string' && value.version) return value.version
    } catch { /* try the next package, then fall back */ }
  }
  return 'unknown'
}
export const DSH_VERSION = installedDshVersion()

export const PROFILE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ModelSchema = z.union([
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('pinned'), provider: z.string().trim().min(1), model: z.string().trim().min(1),
    reasoningEffort: z.string().trim().min(1).optional() }).strict(),
])
const ToolsSchema = z.union([
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('list'), names: z.array(z.string()) }).strict(),
])
const PromptSchema = z.union([
  z.object({ mode: z.literal('live') }).strict(),
  z.object({ mode: z.literal('pinned'), revision: z.number().int().nonnegative() }).strict(),
])
/** What a profile draft may contain. `.strict()` is the authorization boundary: an unknown field is refused, not dropped. */
export const ProfileDraftSchema = z.object({
  id: z.string().regex(PROFILE_ID),
  role: z.enum(['worker', 'orchestrator']).default('worker'),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  model: ModelSchema,
  tools: ToolsSchema,
  prompt: PromptSchema,
  evalBaseline: z.object({ evalSet: z.string().trim().min(1), revision: z.number().int().nonnegative() }).strict().optional(),
}).strict()
export type ProfileDraft = z.infer<typeof ProfileDraftSchema>
const ProvenanceSchema = z.object({ by: z.string().trim().min(1), at: z.string().min(1),
  reason: z.string().trim().min(1), source: z.enum(['builtin', 'panel', 'tool', 'import']) }).strict()
/** One stored revision as the registry returns it. */
export const AgentProfileSchema = ProfileDraftSchema.extend({ revision: z.number().int().positive(), provenance: ProvenanceSchema,
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict()
export const ProfilesConfigSchema = z.object({ enabled: z.boolean().default(false), resolve: z.enum(['snapshot', 'legacy']).default('snapshot'),
  telemetry: z.boolean().default(true), defaultProfile: z.string().regex(PROFILE_ID).optional(),
  updatedBy: z.string().trim().min(1).optional(), updatedAt: z.string().min(1).optional(),
  updatedReason: z.string().trim().min(1).optional() }).strict()

/** Canonical JSON: keys sorted recursively, so equal content always hashes equally. */
export function canonicalJson(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort)
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
      .map(key => [key, sort((item as Record<string, unknown>)[key])]))
    return item
  }
  return JSON.stringify(sort(value))
}
/** Hash arbitrary canonical content as `sha256:<hex>`. */
export function hashContent(value: unknown): string { return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}` }
/** Hash a prompt's text and skills, never only the revision number, so two revisions with identical text cannot share a hash. */
export function promptHashOf(prompts: Pick<Prompts, 'compose' | 'skills'>, version: PromptVersion): string {
  return hashContent({ text: prompts.compose(version.config, 'worker', []), skills: prompts.skills(version.config) })
}
/** The runtime policy a snapshot records, shaped like the definition's model/tools/prompt fields. */
export function snapshotPolicy(snapshot: Pick<ProfileSnapshot, 'model' | 'tools' | 'toolsMode' | 'prompt'>): Pick<ProfileDraft, 'model' | 'tools' | 'prompt'> {
  return { model: snapshot.model, tools: snapshot.toolsMode === 'inherit' ? { mode: 'inherit' } : { mode: 'list', names: [...snapshot.tools] },
    prompt: snapshot.prompt.mode === 'live' ? { mode: 'live' } : { mode: 'pinned', revision: snapshot.prompt.revision } }
}
/** The profile's effective hash input; title/description, provenance and `evalBaseline` are deliberately absent. */
export function effectiveHashInput(profile: Pick<ProfileDraft, 'model' | 'tools' | 'prompt'>, fields: {
  promptRevision: number; promptHash: string; toolsHash: string; model: ProfileResolvedModel; dshVersion: string
  policyVersion: string; skillsHash: string }): Record<string, unknown> {
  return { profile: { model: profile.model, tools: profile.tools, prompt: profile.prompt }, ...fields }
}
/** `GET profiles` returns these identity rows and the independent flags, never prompt text or ticket content. */
export interface ProfileListView { generatedAt: string; config: ProfilesConfig; profiles: ReturnType<Profiles['list']> }
/** `GET profiles/:id` returns one identity, its head and every immutable revision. */
export interface ProfileDetailView { profile: AgentProfile; head: ProfileHead; revisions: AgentProfile[] }
/** A launch the profile cannot start: a missing work tool or a pinned prompt revision that no longer resolves. */
export class ProfileLaunchBlocked extends Error {
  constructor(readonly summary: string) { super(summary); this.name = 'ProfileLaunchBlocked' }
}
/**
 * Recompute a run's effective fields from what actually ran. A moving profile is grouped by this hash, not by the
 * binding snapshot; an actual model that differs from a pinned policy is recorded as non-compliant instead of hidden.
 */
export function runEffective(snapshot: ProfileSnapshot, version: PromptVersion, prompts: Pick<Prompts, 'compose' | 'skills'>,
  settings: Settings, tools: string[], actualModel?: ProfileResolvedModel): ProfileRunEffective {
  const pinned = snapshot.model.mode === 'pinned' ? { provider: snapshot.model.provider, model: snapshot.model.model,
    ...snapshot.model.reasoningEffort ? { reasoningEffort: snapshot.model.reasoningEffort } : {} } : undefined
  const configured = settings.executor.model
  const model = actualModel ?? pinned ?? (configured ? { provider: configured.provider, model: configured.model,
    ...configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {} } : { provider: 'host-default', model: 'host-default' })
  const fields = { promptRevision: version.revision, promptHash: promptHashOf(prompts, version), toolsHash: hashContent([...tools].sort()),
    model, dshVersion: DSH_VERSION, policyVersion: policyVersion(settings), skillsHash: skillsHashOf(prompts, version) }
  const modelCompliant = pinned === undefined ? undefined : pinned.provider === model.provider && pinned.model === model.model
    && (pinned.reasoningEffort ?? undefined) === (model.reasoningEffort ?? undefined)
  return { ...fields, hash: hashContent(effectiveHashInput(snapshotPolicy(snapshot), fields)), at: new Date().toISOString(),
    ...modelCompliant === undefined ? {} : { modelCompliant } }
}
/** An optimistic-concurrency or validation failure while saving a profile revision. */
export class ProfileConflict extends Error {
  constructor(message: string) { super(message); this.name = 'ProfileConflict' }
}
/** A selected profile that resolved to legacy, kept as a snapshot so telemetry can show the fallback beside its peers. */
const LEGACY_HASH = hashContent({ profile: 'legacy', revision: 0 })
const DEFAULT_CONFIG: ProfilesConfig = { enabled: false, resolve: 'snapshot', telemetry: true }
const BUILTIN_AT = '2026-11-10T00:00:00.000Z'

/** What the registry needs from the Store and the prompt service; it reads the current settings for policy/model. */
export interface ProfilesHost {
  readonly store: Store
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  /** Fixed clock for tests; defaults to the real one. */
  now?(): string
}

/**
 * The profile registry. Reads are always non-throwing: a corrupt or unavailable profile resolves to a legacy fallback
 * snapshot, because a profile failure must never roll back an accept or make a Ticket impossible to create.
 */
export class Profiles {
  constructor(private readonly host: ProfilesHost) {}

  /** The independent flags; an unreadable record falls back to the conservative defaults rather than breaking startup. */
  config(): ProfilesConfig {
    const raw = this.host.store.get(KV.profiles.config)
    if (raw === undefined) return { ...DEFAULT_CONFIG }
    const parsed = ProfilesConfigSchema.safeParse(raw)
    return parsed.success ? parsed.data : { ...DEFAULT_CONFIG }
  }
  /** Save the flags. This is an operator action; no worker tool calls it. */
  saveConfig(patch: Partial<ProfilesConfig>, by = 'operator', reason?: string): ProfilesConfig {
    const next = ProfilesConfigSchema.parse({ ...this.config(), ...patch, updatedBy: by,
      updatedAt: this.host.now?.() ?? new Date().toISOString(), updatedReason: reason })
    this.host.store.set(KV.profiles.config, next)
    return next
  }
  /**
   * Save the flags after checking the default profile can actually serve new Tickets. Fallback is a deliberate operator
   * choice: `enabled=false` or `resolve=legacy` still save, but selecting a profile that is missing, disabled or invalid
   * does not. This is a configuration check, not authorization; it never reads a Mandate or an Approval.
   */
  saveOperatorConfig(patch: Partial<ProfilesConfig>, by: string, reason?: string): ProfilesConfig {
    const candidate = ProfilesConfigSchema.parse({ ...this.config(), ...patch })
    if (candidate.defaultProfile) {
      const head = this.head(candidate.defaultProfile), definition = head ? this.revision(candidate.defaultProfile, head.activeRevision) : undefined
      if (!head || !definition || head.disabled || definition.role !== 'worker' || runtimeProblem(definition, this.host.prompts)) {
        throw new UserError('profileDefaultUnavailable')
      }
      this.assertModelApproved(definition)
    } else if (candidate.enabled) {
      const head = this.head('worker-default'), definition = head ? this.revision('worker-default', head.activeRevision) : undefined
      if (!head || !definition || head.disabled || runtimeProblem(definition, this.host.prompts)) throw new UserError('profileDefaultUnavailable')
    }
    return this.saveConfig(candidate, by, reason)
  }
  /** A startup/activation health problem; `undefined` means the built-in compatible profile resolves. */
  problem(): string | undefined {
    const check = (id: string, label: string): string | undefined => {
      const head = this.head(id), definition = head ? this.revision(id, head.activeRevision) : undefined
      if (!head || !definition) return `${label} profile ${id} is missing`
      if (head.disabled) return `${label} profile ${id} is disabled`
      const issue = runtimeProblem(definition, this.host.prompts)
      return issue ? `${label} profile ${id}@${head.activeRevision} is unusable: ${issue}` : undefined
    }
    const builtin = check('worker-default', 'The built-in')
    if (builtin) return builtin
    const config = this.config()
    return config.enabled && config.defaultProfile && config.defaultProfile !== 'worker-default'
      ? check(config.defaultProfile, 'The selected') : undefined
  }
  /** The ids this registry knows, sorted. */
  ids(): string[] { return [...(this.host.store.get(KV.profiles.index) ?? [])].sort() }
  /** A profile's head, or undefined when no such profile is registered. */
  head(id: string): ProfileHead | undefined { return this.host.store.get(KV.profiles.head(id)) }
  /** One immutable revision. */
  revision(id: string, revision: number): AgentProfile | undefined { return this.host.store.get(KV.profiles.revision(id, revision)) }
  /** The currently offered revision. */
  active(id: string): AgentProfile | undefined {
    const head = this.head(id)
    return head ? this.revision(id, head.activeRevision) : undefined
  }
  /** Every revision of `id`, oldest first. */
  revisions(id: string): AgentProfile[] {
    const head = this.head(id)
    if (!head) return []
    const highest = Math.max(head.activeRevision, ...head.retiredRevisions, 0)
    return Array.from({ length: highest }, (_, index) => highest - index)
      .map(revision => this.revision(id, revision)).filter((item): item is AgentProfile => item !== undefined)
      .sort((left, right) => left.revision - right.revision)
  }
  /** The read-only list the management API returns: identity, head and a moving marker; no prompt or ticket content. */
  list() {
    return this.ids().flatMap(id => {
      const head = this.head(id), definition = this.active(id)
      if (!head || !definition) return []
      return [{ id, title: definition.title, description: definition.description, role: definition.role,
        activeRevision: definition.revision, previousActiveRevision: head.previousActiveRevision, disabled: head.disabled === true,
        retiredRevisions: [...head.retiredRevisions], lastBoundAt: head.lastBoundAt, updatedBy: head.updatedBy,
        contentHash: definition.contentHash, moving: movingPolicy(definition) }]
    })
  }
  /** One profile with its head and every immutable revision, for `GET profiles/:id`. */
  detail(id: string) {
    const head = this.head(id), revisions = this.revisions(id)
    const profile = head ? this.revision(id, head.activeRevision) : undefined
    if (!head || !profile || !revisions.length) return undefined
    return { profile, head, revisions }
  }

  /**
   * Seed the one built-in compatible profile. It reproduces today's worker exactly (`inherit` model and work tools,
   * live prompt) and is the only profile allowed those moving modes. Idempotent and repair-oriented: a missing head or a
   * lost index entry is restored without changing an existing revision.
   */
  seed(): AgentProfile {
    const id = 'worker-default', at = BUILTIN_AT
    const draft: ProfileDraft = { id, role: 'worker', title: 'Default worker',
      description: 'The compatible worker: follows the role model and work-tool ceiling and reads the live prompt revision.',
      model: { mode: 'inherit' }, tools: { mode: 'inherit' }, prompt: { mode: 'live' } }
    const existing = this.revision(id, 1)
    const definition: AgentProfile = existing ?? this.seal(draft, 1, { by: 'dsh-superagent', at, reason: 'builtin compatible worker', source: 'builtin' })
    if (!existing) this.host.store.set(KV.profiles.revision(id, 1), definition)
    const head = this.head(id)
    if (!head) this.host.store.set(KV.profiles.head(id), { activeRevision: 1, retiredRevisions: [], updatedBy: 'dsh-superagent' })
    const index = this.host.store.get(KV.profiles.index) ?? []
    if (!index.includes(id)) this.host.store.set(KV.profiles.index, [...index, id].sort())
    return definition
  }

  /**
   * Save the next immutable revision of `draft.id`. `baseRevision` must equal the current active pointer, which makes a
   * concurrent save an explicit conflict instead of a lost update. A custom profile must pin model and prompt and list
   * its work tools; only the built-in compatible profile may inherit.
   */
  save(draft: unknown, baseRevision: number, provenance: Omit<AgentProfile['provenance'], 'at'> & { at?: string }): AgentProfile {
    const parsed = this.validateDraft(draft)
    const current = this.head(parsed.id)
    const active = current?.activeRevision ?? 0
    if (baseRevision !== active) throw new ProfileConflict(`Profile ${parsed.id} is at revision ${active}; compare the latest before saving`)
    // A retired higher revision is never reused: rollback moves the head, it does not free a number.
    const revision = Math.max(active, ...current?.retiredRevisions ?? [], 0) + 1
    const definition = this.seal(parsed, revision, { ...provenance, at: provenance.at ?? this.host.now?.() ?? new Date().toISOString() })
    const head: ProfileHead = { activeRevision: revision, retiredRevisions: current?.retiredRevisions ?? [], lastBoundAt: current?.lastBoundAt,
      updatedBy: provenance.by, updatedReason: provenance.reason, disabled: current?.disabled === true,
      ...active ? { previousActiveRevision: active } : {} }
    this.host.store.set(KV.profiles.revision(parsed.id, revision), definition)
    this.host.store.set(KV.profiles.head(parsed.id), head)
    const index = this.host.store.get(KV.profiles.index) ?? []
    if (!index.includes(parsed.id)) this.host.store.set(KV.profiles.index, [...index, parsed.id].sort())
    return definition
  }

  /**
   * Point `id`'s active head at an existing revision and record the previously active one as retired. This is the
   * one-step rollback: already-bound Tickets keep their snapshot, and only new tickets see the new active pointer.
   */
  activate(id: string, revision: number, by: string, allowRetired = false, reason?: string): ProfileHead {
    const head = this.head(id)
    if (!head) throw new UserError('profileNotFound')
    const definition = this.revision(id, revision)
    if (!definition) throw new UserError('profileRevisionNotFound', { revision: String(revision) })
    if (!allowRetired && head.retiredRevisions.includes(revision)) {
      throw new UserError('profileRevisionRetired', { revision: String(revision) })
    }
    this.assertModelApproved(definition)
    const issue = runtimeProblem(definition, this.host.prompts)
    if (issue) throw new UserError('profileActivationUnusable', { revision: String(revision), issue })
    const retired = new Set(head.retiredRevisions)
    if (revision !== head.activeRevision) retired.add(head.activeRevision)
    retired.delete(revision)
    const next: ProfileHead = { ...head, activeRevision: revision, retiredRevisions: [...retired].sort((a, b) => a - b),
      updatedBy: by, updatedReason: reason, disabled: false,
      previousActiveRevision: revision === head.activeRevision ? head.previousActiveRevision : head.activeRevision }
    this.host.store.set(KV.profiles.head(id), next)
    return next
  }
  /** Retire a revision without letting a later bind select it; the active revision cannot be retired this way. */
  retire(id: string, revision: number, by: string, reason?: string): ProfileHead {
    const head = this.head(id)
    if (!head) throw new UserError('profileNotFound')
    if (revision === head.activeRevision) throw new ProfileConflict('Activate another revision before retiring the active one')
    if (!this.revision(id, revision)) throw new UserError('profileRevisionNotFound', { revision: String(revision) })
    const next: ProfileHead = { ...head, retiredRevisions: [...new Set([...head.retiredRevisions, revision])].sort((a, b) => a - b),
      updatedBy: by, updatedReason: reason,
      ...head.previousActiveRevision === revision ? { previousActiveRevision: undefined } : {} }
    this.host.store.set(KV.profiles.head(id), next)
    return next
  }
  /** Activate the revision that was active before the latest activation; bound Tickets keep their snapshots. */
  rollback(id: string, by: string, reason?: string): ProfileHead {
    const head = this.head(id)
    if (!head) throw new UserError('profileNotFound')
    const target = head.previousActiveRevision
    if (target === undefined || target === head.activeRevision || !this.revision(id, target)) throw new UserError('profileNoRollbackTarget')
    // The revision replaced by the latest activation is marked retired by `activate`; rolling back to it is the one
    // deliberate exception, and it clears that automatic retirement marker so the next save still gets a fresh number.
    return this.activate(id, target, by, true, reason)
  }
  /** Stop or resume binding a profile to new Tickets. Its immutable revisions and the active pointer stay unchanged. */
  setEnabled(id: string, enabled: boolean, by: string, reason?: string): ProfileHead {
    if (!enabled && id === 'worker-default') throw new UserError('profileBuiltinImmutable')
    const head = this.head(id)
    if (!head) throw new UserError('profileNotFound')
    if (!enabled) {
      const next: ProfileHead = { ...head, updatedBy: by, updatedReason: reason, disabled: true }
      this.host.store.set(KV.profiles.head(id), next)
      return next
    }
    return this.activate(id, head.activeRevision, by, false, reason)
  }

  /**
   * The snapshot a new root ticket binds, or undefined when profiles are off (the ticket stays legacy). A missing or
   * unusable selected profile returns a legacy-fallback snapshot whose `selection.fallback` marks it for telemetry; a
   * profile that exists but demands a missing prompt or tool keeps its binding with `selection.valid=false` so launch can
   * fail closed. It never throws and never touches the Decision or Mandate.
   */
  bindRoot(ticket: Pick<Ticket, 'id'>): ProfileSnapshot | undefined {
    try {
      if (!this.config().enabled) return undefined
      const selected = this.config().defaultProfile ?? 'worker-default'
      const head = this.head(selected), definition = head ? this.revision(selected, head.activeRevision) : undefined
      if (!head || !definition) return this.legacySnapshot(`profileUnavailable:${selected}`, ticket.id)
      if (head.disabled) return this.legacySnapshot(`profileDisabled:${selected}`, ticket.id)
      const snapshot = this.snapshot(definition, ticket.id, { by: this.config().defaultProfile ? 'human' : 'code',
        source: this.config().defaultProfile ? 'manual' : 'builtin', reason: `profile:${definition.id}@${definition.revision}` })
      if (snapshot.selection.valid) this.host.store.set(KV.profiles.head(definition.id),
        { ...head, lastBoundAt: snapshot.boundAt })
      return snapshot
    } catch (error) {
      // A profile failure must leave a creatable Ticket, not fail the accept. A legacy snapshot can itself be
      // unreadable in a damaged store; then the Ticket stays legacy and the failure does not escape the binder.
      try { return this.legacySnapshot(`profileError:${error instanceof Error ? error.message : String(error)}`, ticket.id) }
      catch { return undefined }
    }
  }
  /**
   * The snapshot a named worker Profile binds, for a project owner or a task's assigned worker. A missing, disabled or
   * unusable Profile returns undefined instead of the legacy fallback: a project without its owner must fail closed and
   * show project-level attention rather than silently run as someone else. It never changes a Mandate or Decision.
   */
  bindNamed(ticket: Pick<Ticket, 'id'>, profileId: string, reason?: string): ProfileSnapshot | undefined {
    try {
      if (!this.config().enabled) return undefined
      const head = this.head(profileId)
      if (!head || head.disabled) return undefined
      const definition = this.revision(profileId, head.activeRevision)
      if (!definition) return undefined
      const snapshot = this.snapshot(definition, ticket.id, { by: 'code', source: 'manual',
        reason: reason ?? `profile:${definition.id}@${definition.revision}` })
      if (!snapshot.selection.valid) return undefined
      this.host.store.set(KV.profiles.head(definition.id), { ...head, lastBoundAt: snapshot.boundAt })
      return snapshot
    } catch { return undefined }
  }
  /**
   * The snapshot a child copies from its parent. It is the parent's snapshot unchanged, so a child has no profile
   * parameter that could widen its work tools or change its model; the Session layer further removes child-only tools.
   */
  bindChild(parent: Pick<Ticket, 'profile'>, _child: Pick<Ticket, 'id'>): ProfileSnapshot | undefined {
    return parent.profile
  }

  /** Build the immutable snapshot for one definition and ticket, resolving the actual prompt/model/tools. */
  private snapshot(definition: AgentProfile, ticketId: string, selection: Omit<ProfileSelection, 'moving' | 'valid'>): ProfileSnapshot {
    const invalid = runtimeProblem(definition, this.host.prompts)
    const current = (() => { try { return this.host.prompts.current() } catch { return undefined } })()
    const pinnedRevision = definition.prompt.mode === 'pinned' ? definition.prompt.revision : undefined
    const prompt = pinnedRevision === undefined ? current : (() => {
      try { return this.host.prompts.version(pinnedRevision) } catch { return undefined }
    })()
    const promptRevision = prompt?.revision ?? pinnedRevision ?? 0
    const promptHash = prompt ? promptHashOf(this.host.prompts, prompt) : 'sha256:unavailable'
    const tools = effectiveTools(definition)
    const model = resolvedModel(definition, this.host.store.settings())
    const settings = this.host.store.settings()
    const fields = { promptRevision, promptHash, toolsHash: hashContent([...tools].sort()), model, dshVersion: DSH_VERSION,
      policyVersion: policyVersion(settings), skillsHash: skillsHashOf(this.host.prompts, prompt ?? current) }
    const effective = { ...fields, hash: hashContent(effectiveHashInput(definition, fields)) }
    return { id: definition.id, revision: definition.revision, hash: definition.contentHash, role: 'worker',
      selection: { ...selection, moving: movingPolicy(definition), valid: invalid === undefined, ...invalid === undefined ? {} : { reason: invalid } },
      model: definition.model, tools, toolsMode: definition.tools.mode, prompt: { mode: definition.prompt.mode, revision: promptRevision, hash: promptHash },
      effective, boundAt: this.host.now?.() ?? new Date().toISOString(), reason: selection.reason }
  }

  /** A legacy fallback snapshot: not a registry revision, marked so telemetry keeps it out of profile comparisons. */
  legacySnapshot(reason: string, _ticketId: string): ProfileSnapshot {
    const current = (() => { try { return this.host.prompts.current() } catch { return undefined } })()
    const promptRevision = current?.revision ?? 0
    const promptHash = current ? promptHashOf(this.host.prompts, current) : 'sha256:unavailable'
    const settings = this.host.store.settings()
    const model = resolvedModel({ model: { mode: 'inherit' } }, settings)
    const tools = [...WORK_TOOL_NAMES]
    const fields = { promptRevision, promptHash, toolsHash: hashContent(tools), model, dshVersion: DSH_VERSION,
      policyVersion: policyVersion(settings), skillsHash: skillsHashOf(this.host.prompts, current) }
    const effective = { ...fields, hash: hashContent(effectiveHashInput({ model: { mode: 'inherit' }, tools: { mode: 'inherit' },
      prompt: { mode: 'live' } }, fields)) }
    return { id: 'legacy', revision: 0, hash: LEGACY_HASH, role: 'worker',
      selection: { by: 'code', source: 'legacy', reason, moving: true, valid: true, fallback: true }, model: { mode: 'inherit' },
      tools, toolsMode: 'inherit', prompt: { mode: 'live', revision: promptRevision, hash: promptHash }, effective,
      boundAt: this.host.now?.() ?? new Date().toISOString(), reason }
  }

  /** Validate a draft, including the built-in-only inherit rule and the role work-tool ceiling. */
  validateDraft(value: unknown): ProfileDraft {
    const draft = ProfileDraftSchema.parse(value)
    if (draft.id === 'worker-default') throw new UserError('profileBuiltinImmutable')
    if (draft.role !== 'worker') throw new UserError('profileRoleUnsupported', { role: draft.role })
    if (draft.model.mode !== 'pinned') throw new UserError('profileModelMustPin')
    if (draft.prompt.mode !== 'pinned') throw new UserError('profilePromptMustPin')
    if (draft.tools.mode !== 'list') throw new UserError('profileToolsMustList')
    this.assertModelApproved(draft)
    if (draft.prompt.mode === 'pinned') {
      try { this.host.prompts.version(draft.prompt.revision) } catch { throw new UserError('unknownPromptRevision', { revision: String(draft.prompt.revision) }) }
    }
    if (draft.tools.mode === 'list') {
      const names = draft.tools.names
      if (names.some(name => !name.trim())) throw new UserError('profileToolNameEmpty')
      if (new Set(names).size !== names.length) throw new UserError('profileToolDuplicate')
      const outside = names.filter(name => !WORK_TOOL_NAMES.includes(name))
      if (outside.length) throw new UserError('profileToolOutsideRole', { tools: outside.join(', ') })
    }
    return draft
  }
  /**
   * A profile may pin only the worker model the deployment already configured in Executor settings. A write route
   * cannot use a profile to switch to another (stronger) model: changing the approved model is a separate operator
   * action on the existing Executor settings, and then a profile can freeze that model.
   */
  private assertModelApproved(definition: Pick<ProfileDraft, 'model'> & { id?: string }): void {
    if (definition.model.mode !== 'pinned') return
    const approved = this.host.store.settings().executor.model
    if (!approved) throw new UserError('profileModelNotConfigured')
    const same = definition.model.provider === approved.provider && definition.model.model === approved.model
      && (definition.model.reasoningEffort ?? undefined) === (approved.reasoningEffort ?? undefined)
    if (!same) throw new UserError('profileModelUnapproved', { provider: approved.provider, model: approved.model,
      requested: `${definition.model.provider}/${definition.model.model}` })
  }
  /** Attach revision, provenance and content hash to a validated draft. */
  private seal(draft: ProfileDraft, revision: number, provenance: AgentProfile['provenance']): AgentProfile {
    const content = { ...draft, revision, provenance, ...(draft.tools.mode === 'list' ? { tools: { ...draft.tools, names: [...draft.tools.names].sort() } } : {}) }
    return { ...content, contentHash: hashContent(content) }
  }
}

/** Whether a profile's model, tools or prompt can move after binding. */
function movingPolicy(definition: Pick<AgentProfile, 'model' | 'tools' | 'prompt'>): boolean {
  return definition.model.mode === 'inherit' || definition.tools.mode === 'inherit' || definition.prompt.mode === 'live'
}
/** The effective work tools: the role ceiling for `inherit`, or the listed subset. Protocol tools are never here. */
function effectiveTools(definition: Pick<AgentProfile, 'tools' | 'model'>): string[] {
  const names = definition.tools.mode === 'inherit' ? [...WORK_TOOL_NAMES] : [...new Set(definition.tools.names)].sort()
  // A pinned model cannot force a subagent's model, so those control tools are not effective work tools.
  return definition.model.mode === 'pinned' ? names.filter(name => !SUBAGENT_CONTROL.has(name)) : names
}
/** The actual model a snapshot records; `host-default` is honest when the role settings name none. */
function resolvedModel(definition: { model: ProfileModelPolicy }, settings: Settings): ProfileResolvedModel {
  if (definition.model.mode === 'pinned') return { provider: definition.model.provider, model: definition.model.model,
    ...definition.model.reasoningEffort ? { reasoningEffort: definition.model.reasoningEffort } : {} }
  const configured = settings.executor.model
  return configured ? { provider: configured.provider, model: configured.model,
    ...configured.reasoningEffort ? { reasoningEffort: configured.reasoningEffort } : {} } : { provider: 'host-default', model: 'host-default' }
}
function skillsHashOf(prompts: Pick<Prompts, 'skills'>, version: PromptVersion | undefined): string {
  if (!version) return 'sha256:unavailable'
  try { return hashContent(prompts.skills(version.config)) } catch { return 'sha256:unavailable' }
}
/** Why a definition cannot run, or undefined. It is recorded on the snapshot but does not fail the binding. */
function runtimeProblem(definition: AgentProfile, prompts: Pick<Prompts, 'version'>): string | undefined {
  if (!AgentProfileSchema.safeParse(definition).success) return 'contentInvalid'
  if (definition.role !== 'worker') return `roleUnsupported:${definition.role}`
  if (definition.model.mode === 'pinned' && (!definition.model.provider.trim() || !definition.model.model.trim())) return 'modelIncomplete'
  if (definition.tools.mode === 'list') {
    const outside = definition.tools.names.filter(name => !WORK_TOOL_NAMES.includes(name))
    if (outside.length) return `toolsOutsideRole:${outside.join(',')}`
    if (new Set(definition.tools.names).size !== definition.tools.names.length) return 'toolsDuplicate'
  }
  if (definition.prompt.mode === 'pinned') {
    try { prompts.version(definition.prompt.revision) } catch { return `promptRevisionMissing:${definition.prompt.revision}` }
  }
  return undefined
}