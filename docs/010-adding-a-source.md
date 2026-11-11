# 010 Adding a Source in 30 minutes

Status: written 2026-11-08 (T1-12), verified by adding a throwaway `noop` Source and running the full gate.
This is the fast path: it gets a new Source kind installed, validated and visible in the panel. It does not make the Source read events; [008 Cookbook](008-cookbook.md) is the full recipe for everything after the skeleton, and [007 Architecture](007-architecture.md) explains the interfaces.

The terms are those of [001 Domain model](001-domain.md). The rule that keeps this short is in [007](007-architecture.md): a Source is a declaration (`manifest`) plus behavior (`adapter`), registered by a plugin. Nothing under `packages/dsh/src/app` changes.

## 1. What you will have after 30 minutes (2 min)

A `noop` Source that:

- installs as `dsh-superagent/noop-watch`, disabled by default like the optional Feishu Sources;
- validates its configuration (empty in this example);
- appears in **Settings › Sources** with its title and description and no hand-written form code;
- lists under **Eval → On each Source** once it declares a `policy` part (§7), so its admission table can be configured;
- passes `pnpm check`.

It has no loop and declares no health entries, so it reports `ready`: there is nothing to poll. That is the point of a skeleton — you can install it before you know how to read the real system.

Before you start, have the repository checked out with dependencies installed (`pnpm install`). The time boxes assume you are adding one Source to this checkout, not building a separate package.

## 2. Map the Source (5 min)

Write these five mappings down before the code. They are persisted, so changing them later disconnects stored records. The full explanations are in [008 §1](008-cookbook.md#1-map-the-events-onto-the-domain).

| Concept | Your Source | `noop` |
| --- | --- | --- |
| Stable id | Lower-case letters, digits and `-`; it becomes `source:<id>` and the Policy key | `noop` |
| Trigger | One external event, with a stable id | none |
| Thread | The conversation the event belongs to | none |
| Actor | The sender's id on the Source | none |
| Channel address | What a reply needs | none |

If you cannot fill in Trigger and Thread yet, stop at the skeleton and come back. Everything in steps 3–6 still applies.

## 3. Declare the manifest (5 min)

Create `packages/dsh/src/sources/noop.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { SourceManifest } from '@superagent/kernel'
import type { SourceAdapter, SourceDefinition } from './kind.ts'

const NoopConfigSchema = z.object({}).strict()

export type NoopConfig = z.infer<typeof NoopConfigSchema>

export const noopManifest: SourceManifest = {
  id: 'noop',
  title: { zh: '空来源', en: 'No-op Source' },
  description: { zh: '一个不读取任何事件的示例来源。', en: 'An example Source that reads no events.' },
  auth: { kind: 'none', fields: [] },
  fields: [],
  health: [],
}
export const noopAdapter: SourceAdapter<NoopConfig> = { schema: NoopConfigSchema }
export const noopDefinition: SourceDefinition<NoopConfig> = { manifest: noopManifest, adapter: noopAdapter }

export const name = 'dsh-superagent-noop'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.registerDefinition(noopDefinition), 'noop: source kind')
}
```

### Manifest fields

`SourceManifest` in `packages/kernel/src/manifest.ts` has exactly these fields. `tests/docs.spec.ts` keeps this table complete, so add a row here when the interface gains a field.

| Field | Required | What it declares |
| --- | --- | --- |
| `id` | yes | The stable Source id, matching `^[a-z][a-z0-9-]*$`. It is the registration key and appears in `source:<id>`, the Source Policy and the `source:<id>` settings block. |
| `title` | yes | The localized `{ zh, en }` display name on the Source card. |
| `description` | yes | The localized `{ zh, en }` one-line explanation beside the title. |
| `auth` | yes | `{ kind, fields }`: how the Source signs in (`cli`, `app` or `none`) and which keys in `fields` carry the credential; `kind: 'none'` names none. |
| `fields` | yes | The ordered `FieldSpec[]` that renders the configuration form; an empty list is legal for a Source with nothing to configure. |
| `health` | yes | The health entry names registration claims; an empty list is legal. Use the kind's name, never `sync:<id>`. |
| `limits` | no | Polling defaults the panel suggests, currently `pollSeconds`. It does not replace the adapter's configuration defaults. |
| `extra` | no | A `Record<string, unknown>` escape hatch for metadata a future field adds. Parsing preserves it, but the panel and registry ignore it today; do not put behavior or admission there. |

What the registry checks when the plugin loads, and what to change if it throws:

- `id` must match `^[a-z][a-z0-9-]*$`; it is the registration key, so two Sources with one id are refused.
- `title` and `description` need both `zh` and `en`.
- `auth.fields` must name fields that exist in `fields`; `kind: 'none'` must name none. Use `{ kind: 'cli', fields: ['cli'] }` when the Source signs in through a CLI field, as GitHub does.
- `fields: []` is legal and is what a Source with nothing to configure uses. When you add fields, they generate the settings form; do not write panel code.
- `health: []` is legal. When you add a loop, declare one entry named after the kind (`['noop']`) and report through `sourceContext`, never through `sync:<id>`.
- `limits` is optional; use it when the panel should suggest a polling interval.

The adapter is behavior. This one only validates configuration. The optional members are the whole feature map, and [008 §2–9](008-cookbook.md#2-configuration-schema-fields-facts-and-health) covers each: `scope`, `channel`, `threadContext`, `find`, `repliesTo`, `policy`, `environment`, `facts`, `refreshLabels`, and — when the Source has shared spaces — `contextGroup`/`threadSpace` (the read-only group dimension described in document 017; it must not become a member list or an authorization scope).

## 4. Register the plugin (3 min)

The `apply` above is the whole entry:

- `ctx.effect(() => ctx.orchestrator.sources.registerDefinition(...))` registers the pair and unregisters it when the plugin is disposed. Doing this in `apply` rather than at import time is what lets the runtime start and stop the Source.
- `inject = ['orchestrator']` makes the host available.
- No loop means no `SourceContext`; add `sourceContext(ctx.orchestrator, { kind: noopManifest.id, health: noopManifest.health })` when you add one.

That is why this stays out of `packages/dsh/src/app`: the application knows only the registry, and the Source registers itself.

## 5. Wire the package (10 min)

A Source that is not reachable as a plugin cannot load. Add these seven pieces, in this order, copying the Feishu document Source as the model:

1. **Runtime entry** in `tsdown.config.ts`, first build:

   ```diff
   -  { entry: { index: 'packages/dsh/src/index.ts', 'github-watch': 'packages/dsh/src/sources/github.ts', 'feishu-watch': 'packages/dsh/src/sources/feishu.ts',
   -    'feishu-doc-watch': 'packages/dsh/src/sources/feishu-doc.ts' },
   +  { entry: { index: 'packages/dsh/src/index.ts', 'github-watch': 'packages/dsh/src/sources/github.ts', 'feishu-watch': 'packages/dsh/src/sources/feishu.ts',
   +    'feishu-doc-watch': 'packages/dsh/src/sources/feishu-doc.ts', 'noop-watch': 'packages/dsh/src/sources/noop.ts' },
   ```

2. **Bundle entry** `meta/noop-watch.ts`, as the other bundle entries are:

   ```ts
   /** The bundle's noop Source entry, exported as `./noop-watch` so the patch row `dsh-superagent/noop-watch` resolves. */
   export * from '@superagent/dsh/noop-watch'
   ```

   and the matching meta build entry in `tsdown.config.ts`:

   ```diff
   -  { entry: { index: 'meta/index.ts', 'github-watch': 'meta/github-watch.ts', 'feishu-watch': 'meta/feishu-watch.ts', 'feishu-doc-watch': 'meta/feishu-doc-watch.ts' },
   +  { entry: { index: 'meta/index.ts', 'github-watch': 'meta/github-watch.ts', 'feishu-watch': 'meta/feishu-watch.ts', 'feishu-doc-watch': 'meta/feishu-doc-watch.ts',
   +    'noop-watch': 'meta/noop-watch.ts' },
   ```

3. **Runtime export** in `packages/dsh/package.json`:

   ```json
   "./noop-watch": {
     "types": "./lib/noop-watch.d.ts",
     "default": "./lib/noop-watch.js"
   },
   ```

4. **Bundle export** in the root `package.json`:

   ```json
   "./noop-watch": "./lib/noop-watch.js",
   ```

5. **Patch row** in `cordis.patch.yml`, next to the other Sources and disabled, as the optional Feishu Sources are:

   ```yaml
       - id: dsh-superagent-noop
         name: dsh-superagent/noop-watch
         disabled: true
   ```

   Disabled is the default because an unconfigured Source that reads nothing should not add a health entry or noise to an operator's installation. Enable it in a profile with `disabled: false` when you test it.

6. **Type and test resolution**: the subpath mappings are written out for the three Sources today. Add `@superagent/dsh/noop-watch` to the `paths` of `tsconfig.json` (pointing at `./packages/dsh/src/sources/noop.ts`) and to the `alias` list of `vitest.config.ts`. Without them, `meta/noop-watch.ts` fails to typecheck and a test that imports `@superagent/dsh/noop-watch` cannot resolve it.

7. **The checks that enumerate Sources**:

   - Two tests assert the exact plugin rows: `tests/bundle-patch.spec.ts` and `tests/dump-config.spec.ts` (X-11). Add `dsh-superagent-noop` to both expected row lists, change dump-config's `toHaveLength(6)` to 7, and update its "six rows" names and message plus the expected dump string in the incomplete-dump test.
   - `docs/007-architecture.md` must list `packages/dsh/src/sources/noop.ts` in its Modules table; `tests/docs.spec.ts` checks every TypeScript file under `packages/`. Add `meta/noop-watch.ts` next to the other bundle entries for consistency; `docs.spec.ts` does not check `meta/`.
   - If the module grows past one file, list each file. If you add a spec, list it in the Tests table too.
   - `pnpm build && pnpm check:size` may report the new entry over the total budget. That is a real product cost: raise `scripts/bundle-budget.json` in the same change only when shipping the Source is intended.

## 6. Verify (5 min)

Run the checks that the wiring touches first:

```sh
pnpm typecheck
pnpm vitest run tests/docs.spec.ts tests/bundle-patch.spec.ts tests/dump-config.spec.ts tests/packaging.spec.ts tests/registry.spec.ts
pnpm build
pnpm check:size
```

Then prove the registration itself with a throwaway spec, `tests/noop.spec.ts`:

```ts
import { expect, it } from 'vitest'
import { SettingsSchema } from '@superagent/dsh/policy.ts'
import { SourceRegistry } from '@superagent/dsh/sources/registry.ts'
import { noopDefinition } from '@superagent/dsh/sources/noop.ts'

it('registers the noop Source', () => {
  const sources = new SourceRegistry(() => SettingsSchema.parse({}))
  sources.registerDefinition(noopDefinition)
  expect(sources.form('noop')?.fields).toEqual([])
  expect(sources.instances()).toContainEqual({ id: 'noop', kind: 'noop', enabled: true, config: {}, installed: true })
})
```

Run it and then decide whether to keep it: a real Source should keep a spec and list it in the Tests table; the skeleton's acceptance is a temporary check. While an unlisted spec exists, `tests/docs.spec.ts` fails its Tests-table check, so either run this spec alone or add the row first.

Finally, see it in the panel:

1. Build (`pnpm build`).
2. In the profile's `cordis.patch.yml`, add the row with the same id and `disabled: false` (the example profile does this for Feishu).
3. Restart the profile and open **Settings › Sources**. The card shows the manifest's title and description with an empty form; its state is `ready`.
4. Confirm the boundary: `git diff --stat packages/dsh/src/app` prints nothing.
5. Run the full gate once before opening a pull request: `pnpm check`.

## 7. Grow it without rewriting it (ongoing)

Add capabilities to the same file; the registration, packaging and panel stay as they are.

| Next capability | Where it is specified | What you add |
| --- | --- | --- |
| Configuration fields and their defaults | [008 §2](008-cookbook.md#2-configuration-schema-fields-facts-and-health) | `schema`, `facts`, `refreshLabels` |
| Events into Triggers | [008 §3](008-cookbook.md#3-translate-a-message-into-a-trigger) | a polling loop in `apply`, stable Trigger ids |
| Receiving scopes | [008 §4](008-cookbook.md#4-what-the-source-receives-scope) | `scope` |
| Replies | [008 §5](008-cookbook.md#5-replies-the-channel) | `channel` with idempotent `send`, `gone`, `probe`, optional `withdraw` and `link` |
| Assessment context | [008 §6](008-cookbook.md#6-thread-context-for-assessments) | `threadContext`, optionally `repliesTo` |
| Admission rules | [008 §7](008-cookbook.md#7-who-may-ask-the-sources-part-of-the-policy) | `policy` with `allowed` and `rows` |
| Variables for Executors | [008 §8](008-cookbook.md#8-variables-for-the-executor) | `environment` |
| A polling loop | [008 §9](008-cookbook.md#9-the-plugin-entry-and-its-loop) | `SourceContext`, health reports, cursors in `KV` |
| The adapter contract suite | [008 §11](008-cookbook.md#run-the-adapter-conformance-suite) | `tests/conformance/<id>.spec.ts` |

Keep these invariants from the start, because they are expensive to change later:

- **Ids are stable.** Derive the Trigger id from the Source's event id with `key`; replay must be a duplicate, not a second event.
- **Advance a cursor only after `receive` returned.** A crash then replays instead of losing an event.
- **Sends are idempotent.** The same message id must be safe to retry; return `gone` only when the destination can never receive it.
- **`unknown` is not `gone`.** A failed probe must not cause a resend.
- **No `packages/dsh/src/app` changes.** If the feature needs one, it is a new capability of the Source host, not part of this recipe.

## 8. What usually fails

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Source kind already registered: noop` | The kind registers twice at runtime: two enabled plugin rows, or the assembly registers it as well | Keep one enabled plugin row and one `registerDefinition` call |
| manifest validation names `auth.fields` | The sign-in field is not in `fields`, or `kind: 'none'` names one | Declare the field and list the key, or clear it |
| The card is missing from Settings › Sources | The plugin is not in the patch, or the row is still disabled | Add the row, enable it in the profile, build and restart |
| `meta/noop-watch.ts` cannot resolve the runtime | The tsconfig/vitest subpath mapping is missing | Add the `@superagent/dsh/noop-watch` path as in step 5 |
| `tests/bundle-patch.spec.ts`, `tests/dump-config.spec.ts` or `tests/docs.spec.ts` fails | The row list, the row count, or the Modules table was not updated | Update the exact lists and counts in the same change |
| The size gate fails | The new entry grew the shipped bundle | Update `scripts/bundle-budget.json` only if shipping it is intended |

## Checklist

1. Five mappings written down; id chosen.
2. `packages/dsh/src/sources/<id>.ts` has the manifest, the adapter and the plugin entry.
3. Runtime and meta entries, both exports, the patch row, tsconfig and vitest mappings are in place.
4. The bundle row list, the Modules table (and a spec's Tests row) are synced.
5. `pnpm check` passes; the panel shows the Source; `packages/dsh/src/app` is untouched.