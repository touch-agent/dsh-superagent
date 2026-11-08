/**
 * Runtime settings schemas, assessment validation, and policy gate evaluation.
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
import { LIMITS } from './limits.ts'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { key, ACTION_LEVELS, DEFAULT_MAX_ACTION_LEVEL, withinActionLevel, type ActionRequest, type AssessmentOutcome, type Mandate, type Policy,
  type PolicyEffect, type Revalidation, type SourceScope, type Strength, type Thread, type Ticket, type Trigger, type ActorRef,
  type GateResult } from '@superagent/kernel'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
  /** Set only when the accepted work is one read-only repository lookup the inline executor can finish. */
  form?: 'lightweight' | null
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}), ...(assessment.form === 'lightweight' ? { form: 'lightweight' } : {}) }
}
const DEFAULT_RULES = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction) }).strict()
export type Rule = z.infer<typeof RuleSchema>
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>

export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
const Weak = z.enum(['inferred', 'ignore'])
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: Weak.optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}) }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
/**
 * Whether `value` is a lower-case domain name with at least two labels: each label at most 63 characters, the whole name
 * at most 253, and a letter in the last label so an IP literal is not mistaken for a domain.
 */
export function isDomainName(value: string): boolean {
  if (value.length > 253) return false
  const labels = value.split('.')
  return labels.length >= 2 && labels.every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    && /[a-z]/.test(labels.at(-1)!)
}
/** A domain an Action's target may belong to: one or more labels, lower-cased for comparison. */
export const DomainSchema = z.string().trim().toLowerCase().refine(isDomainName, 'A domain name such as corp.example')
const TimeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A local time as HH:MM')
/** A local working-hours window: the whole days it covers and a start and end time in its own zone. */
export const WorkHoursSchema = z.object({
  /** Days of the week the window covers, 0 for Sunday through 6 for Saturday. */
  days: z.array(z.number().int().min(0).max(6)).min(1).refine(days => new Set(days).size === days.length, 'Each day at most once'),
  start: TimeOfDaySchema,
  end: TimeOfDaySchema,
  timeZone: z.string().trim().min(1).refine(zone => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
  }, 'An IANA time zone such as Asia/Shanghai'),
}).strict().refine(window => window.end > window.start, { path: ['end'], message: 'The end must be after the start; a window cannot cross midnight' })
export type WorkHours = z.infer<typeof WorkHoursSchema>
/** The internal-domain whitelist for one scope: targets whose domain matches, and when it applies. */
export const AutoApproveRuleSchema = z.object({
  /** Internal domains; a target domain matches one of them or any of its subdomains. Empty disables approval. */
  domains: z.array(DomainSchema).default([]),
  /** The local window in which the rule applies. A rule with domains needs either this or `always: true`. */
  hours: WorkHoursSchema.optional(),
  /** Apply a domains-only rule at any time. Explicit, so omitting `hours` is not silently 24/7 approval. */
  always: z.boolean().optional(),
}).strict()
  .refine(rule => rule.domains.length === 0 || rule.hours !== undefined || rule.always === true,
    { path: ['hours'], message: 'A rule with domains needs working hours, or always: true for any time' })
  .refine(rule => !(rule.always === true && rule.hours !== undefined), { path: ['always'], message: 'Choose working hours or always, not both' })
export type AutoApproveRule = z.infer<typeof AutoApproveRuleSchema>
/** Auto-approval at the tenant level, and per Source overriding it, as TASK-PLAN T2-08 describes. */
export const ApprovalPolicySchema = z.object({
  /** The rule for every Source without one of its own. */
  tenant: AutoApproveRuleSchema.optional(),
  /** Per-Source rules; a Source's own rule replaces the tenant rule instead of adding to it. */
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), AutoApproveRuleSchema).default({}),
}).strict()
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>
export const PolicyConfigSchema = z.object({
  rules: z.array(RuleSchema).refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs').default(DEFAULT_RULES),
  /**
   * The highest action level any Mandate may authorize. A Policy that lowers it refuses higher-level actions on running
   * Tickets at their next action point; raising it never widens a Mandate that recorded a ceiling.
   */
  maxActionLevel: z.enum(ACTION_LEVELS).default(DEFAULT_MAX_ACTION_LEVEL),
  /** How many minutes a new Mandate authorizes actions; 0 keeps it valid until revoked. */
  mandateMinutes: z.number().int().min(LIMITS.mandateMinutes.min).max(LIMITS.mandateMinutes.max).default(0),
  /**
   * How many seconds an outbound message stays recallable before it is sent; 0 delivers at once. The platform default is
   * 30 seconds for mail-like actions, while IM tenants normally set 0 to avoid delaying replies.
   */
  undoWindowSeconds: z.number().int().min(LIMITS.undoWindowSeconds.min).max(LIMITS.undoWindowSeconds.max).default(30),
  /**
   * When an Approval may be decided by this Policy instead of a person: an Action whose target is on the internal-domain
   * whitelist during the configured local working hours. Empty, the default, leaves every decision to a person. Like the
   * undo window, this is not part of the Policy version: it governs later requests, not the Mandates and Evals in flight.
   */
  approval: ApprovalPolicySchema.default(() => ApprovalPolicySchema.parse({})),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({}),
}).strict()
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  model: RoleModelSchema.nullable().default(null),
}).strict()
/**
 * How a dispatched message becomes Tickets, as docs/009 describes. `single` keeps the original behavior, one Ticket at
 * most; `explicit` splits only when the message lists its items explicitly (a numbered or bulleted list, or a launching
 * or confirming phrase followed by items), by deterministic parsing; `auto` takes the main Session's own reading of the
 * message into items, and merges an explicit list when that reading covers fewer items than the list; with no items the
 * parser runs alone, then one Ticket. A parse that is ambiguous, or that yields more than `maxTickets` new tickets,
 * keeps one Ticket, and attach items do not count. Dispatch limits how a person's message is accepted; it does not
 * invalidate existing Mandates and is not part of the Policy version.
 */
export const DispatchConfigSchema = z.object({
  mode: z.enum(['single', 'explicit', 'auto']).default('single'),
  maxTickets: z.number().int().min(LIMITS.dispatchTickets.min).max(LIMITS.dispatchTickets.max).default(5),
}).strict()
export type DispatchConfig = z.infer<typeof DispatchConfigSchema>
export type DispatchMode = DispatchConfig['mode']
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/system/work`), `prepare` command, blocked commands, and whether lightweight tickets may run inline. */
export const ExecutorConfigSchema = z.object({
  model: RoleModelSchema.nullable().default(null),
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  directory: z.string().trim().refine(path => path === '' || path.startsWith('/'), 'An absolute path, or empty for <stateDir>/system/work').default(''),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
  /**
   * Whether an accept may choose the lightweight form. The form itself still defaults to tracked; turning this off is the
   * deployment-wide fallback that keeps every accept tracked with its Assignment, Session and workspace.
   */
  lightweight: z.boolean().default(true),
}).strict()
export const SourceInstanceSchema = z.object({ enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}) }).strict()
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  dispatch: DispatchConfigSchema.default(() => DispatchConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
export type SettingsBlock = 'policy' | 'eval' | 'dispatch' | 'executor' | `source:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync'

export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode,
    maxActionLevel: settings.policy.maxActionLevel, mandateMinutes: settings.policy.mandateMinutes, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, at: string, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate, at).ok && !after.revalidate(ticket.mandate, at).ok) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate, at).ok) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  const { maxActionLevel, mandateMinutes } = settings.policy
  /** A refusal with a code and the values its reason template reads. */
  const refuse = (code: string, values?: Record<string, string>): Revalidation => ({ ok: false, reason: { code, ...values ? { values } : {} } })
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  /** Whether a Mandate's admission basis still holds under this Policy, without its action limits. */
  const holds = (mandate: Mandate): boolean => {
    const { basis } = mandate
    const { source } = basis
    const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
    if (current && !current.listened) return false
    // The conversation's authenticated local user stays explicit while the built-in Source exists.
    if (basis.via === 'local') return !!source && (sources.trusted?.(source) ?? false)
    const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
    // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
    if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
    // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
    if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
    // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
    if (basis.via === 'admission') {
      const { cell } = basis
      const listed = !!allowedSender(settings, mandate.actor)
      // A listed sender who addresses the agent is always explicit and uses no table cell.
      if (cell === 'unlistedAddressed' && listed) return true
      // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
      const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
      if (now === 'listedUnaddressed' && !listed) return false
      const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
      if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
      if (mandate.strength === 'explicit') return true
    } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
    // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
    if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
    return true
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    mandateLimits(at: string) {
      return { maxActionLevel, ...mandateMinutes > 0
        ? { expiresAt: new Date(Date.parse(at) + mandateMinutes * 60_000).toISOString() } : {} }
    },
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      // A built-in local Source authenticates its user itself; it has no roster to consult.
      if (sources.trusted?.(trigger.source)) {
        const own = sources.scope({ source: trigger.source, meta: trigger.meta })
        if (!own.listened) return { admissible: false, reason: own.reason }
        return { admissible: true, strength: 'explicit', basis: { source: trigger.source, scope: trigger.meta, via: 'local',
          ...trigger.addressed ? { addressed: trigger.addressed } : {} } }
      }
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate, at: string, action?: ActionRequest) {
      // An authorization that has reached its expiry authorizes nothing, even at a level it once allowed.
      if (mandate.expiresAt && Date.parse(at) >= Date.parse(mandate.expiresAt)) {
        return refuse('mandateExpired', { at: mandate.expiresAt })
      }
      // The narrower of the recorded ceiling and the Policy's current one binds; a recorded ceiling never widens.
      if (action) {
        const recorded = mandate.maxActionLevel ?? maxActionLevel
        const max = withinActionLevel(recorded, maxActionLevel) ? recorded : maxActionLevel
        if (!withinActionLevel(action.level, max)) return refuse('actionLevelExceeded', { level: action.level, max })
      }
      // The admission basis follows docs/002: the same checks apply before a resume and before an action.
      return holds(mandate) ? { ok: true } : refuse('revoked')
    },
  }
}
