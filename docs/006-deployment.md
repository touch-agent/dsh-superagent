# 006 Deployment

Use this guide to install, configure and operate dsh-superagent. It covers accounts, startup checks, upgrades and troubleshooting, building on [001 Domain model](001-domain.md) through [005 Panel](005-panel.md).

## What runs

- **A dedicated DeepSeek Harness profile**, called `superagent` in this guide. Create it from the Web profile template. It loads the bundle and serves its panel on `127.0.0.1`. Keep it separate from the profile you work in: the plugin changes process-wide `PATH` and git settings, and its process needs independent restarts and upgrades.
- **An agent GitHub account.** The agent comments, pushes branches and opens pull requests as this account, through a GitHub CLI signed in only as that account.
- **Optional:** a Feishu bot for chat requests.

Plugin configuration holds the state directory and machine limits. Use the panel for everything else: Sources for the repository and accounts, Policy for allowed lists, and Execution for worker directories and commands.

### Permissions and isolation

The bundle defines `dsh-superagent-worker` for Executors and `dsh-superagent-router` for the main Session. They appear in the DeepSeek Harness preset list but are intended only for dsh-superagent. Do not select them for personal Sessions or disable their configuration rows. The application needs them to create and resume its Sessions.

Opening a blank managed Session in the Web UI can select the profile's default preset. dsh-superagent restores its role-specific preset before the first turn.

Both presets run with `danger-full-access` as the operator's OS user and read messages from subscribed Threads. Account wrappers choose the agent's credentials by default; they do not isolate the process. A worker can execute programs by path and read the operator's home directory. For isolation, use a dedicated OS account containing only the agent's credentials.

## Prerequisites

- Node.js 22.19+ or 24+, pnpm, git 2.32+, Python 3.8+ and tmux
- GitHub CLI (`gh`) 2.48 or later. Source CLI fields must point to `gh` or `lark-cli` wrappers; the host relies on their subcommands and output formats.
- A repository on github.com; GitHub Enterprise Server is not supported. To create a checkout per Ticket, keep a local clone from which the prepare command can add worktrees. Install `git-lfs` if that repository uses Git LFS.
- A model provider configured for DeepSeek Harness. dsh-superagent uses the profile's default model unless the Eval or Execution settings name another.
- For Feishu: `lark-cli` (tested with 1.0.90) and a Feishu or Lark app with a bot

## Accounts

### Agent GitHub account

1. Create a GitHub user account for the agent and give it write access to the repository. A GitHub App cannot be the agent, because dsh-superagent reads the account's notifications.
2. Give it a GitHub CLI that uses only its own credentials:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/gh-agent <<'EOF'
   #!/bin/sh
   GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
   EOF
   chmod +x ~/.local/bin/gh-agent
   gh-agent auth login
   gh-agent api user --jq .login
   ```

   Sign in as the agent account; the last command prints its login. dsh-superagent reads the login the same way.

### Feishu bot (optional)

1. Create a self-built app with the bot capability. Grant it the permissions to receive message events, read and send chat messages, and read chat members, then publish the app version.
2. Give the bot its own `lark-cli` configuration, restricted to the bot identity, and a wrapper:

   ```sh
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config init --app-id <cli_…> --app-secret-stdin
   LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent" lark-cli config strict-mode bot --global
   cat > ~/.local/bin/lark-bot <<'EOF'
   #!/bin/sh
   export LARKSUITE_CLI_CONFIG_DIR="$HOME/.lark-cli-dsh-superagent"
   exec lark-cli "$@"
   EOF
   chmod +x ~/.local/bin/lark-bot
   ```

   The first command reads the app secret from standard input. Use a separate configuration directory: `lark-cli` allows one profile per app id, and your personal configuration may already contain a user login for that app.

   The host refuses a CLI that can act as a user. It reads the app id, Feishu/Lark brand and bot `open_id` from the bot configuration.

   Both configurations share the keychain entry for the app secret. To remove only the bot configuration, delete its directory; do not run `lark-cli config remove`, which would affect the shared secret.

## Install

Run this block once, on a machine that has no `superagent` profile yet:

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.5
git clone <this repository> dsh-superagent && cd dsh-superagent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

The pinned version above is public; other versions must satisfy `engines.dsh` in `package.json`.

The fourth command creates `~/.dsh/profiles/superagent` from the DeepSeek Harness Web template. The fifth installs this bundle. Set `DSH_HOME` to relocate the default `~/.dsh` directory.

Run the profile-creation command only for a new installation. If the profile already exists, that command replaces it and deletes its `cordis.patch.yml`, including machine configuration. Do not use it for upgrades.

### Automated install/uninstall check

`pnpm test:install-e2e` runs the install above against a throwaway `DSH_HOME`: it builds the packages, initializes a Web profile, writes the machine configuration from the next section, installs this checkout with `dsh plugin add "link:$PWD"`, starts `dsh --profile install-e2e --no-open`, and removes the plugin again. It asserts:

- the bundle becomes a profile dependency and a registered patch layer, and `dsh --dump-config` composes all six rows;
- the panel's `GET /orchestrator/api/state` answers, reports the temporary `stateDir`, and the served page references `dsh-superagent/client.js`, which is itself served;
- after `dsh plugin remove`, the dependency and the patch rows are gone while `stateDir/orchestrator.sqlite` remains, so its data remains for a later reinstall.

The `host-matrix` CI workflow runs this check on every pull request, on `main`, weekly, and on demand; locally, put `dsh` on `PATH` (or set `DSH_BIN`) and run `pnpm test:install-e2e`. On Windows, point `DSH_BIN` at the host's `lib/bin.js` rather than the `.cmd` shim. `KEEP=1` leaves the temporary home for inspection.

The check has deliberate limits. It installs the built checkout with `link:` because both packages are private and unpublished, so a registry or packed-tarball install is not covered until there is a release; the cross-host matrix is X-10, and its contract is the [supported-host table](#supported-hosts-and-the-ci-matrix) below. With no GitHub account configured, setup deliberately stops at `repositoryUnset`, and the check asserts that state instead of exercising Sources, Sessions or delivery. It stops at uninstall and does not reinstall, so it proves the data survives rather than exercising the recovery path. Uninstalling leaves the user's `cordis.patch.yml` naming the removed entry, so `dsh --dump-config` warns `entry "dsh-superagent" not found` and still exits 0; the check asserts that warning, and the configuration is intentionally kept so a reinstall gets its `stateDir` back.

### Supported hosts and the CI matrix

`.github/workflows/host-matrix.yml` holds the contract. Every row below runs the same `pnpm test:install-e2e` path, and every row is required: the workflow has no `if`, no `continue-on-error`, no `exclude`, and no retry on a leg. `fail-fast: false` only lets the other legs finish reporting; the final `host matrix summary` job fails the workflow unless the whole matrix job reports `success`. Each leg first asserts its actual `process.platform`, `process.arch` and Node major against the matrix values, so a mislabelled or silently substituted runner is red rather than green.

| Host | Runner | Node | DSH host | What it adds |
| --- | --- | --- | --- | --- |
| Linux x64 | `ubuntu-latest` | 22, 24 | `0.2.1-rc.5` | The reference install/run/uninstall path on the operating system most deployments use. |
| macOS arm64 | `macos-latest` | 22, 24 | `0.2.1-rc.5` | The developer laptop target, including macOS path and process behaviour. |
| Windows x64 | `windows-latest` | 24 | `0.2.1-rc.5` | The Windows install, boot, panel and uninstall path, with the limitations below. Windows runs one Node line to keep its slow global install to one leg. |
| Linux x64, forward probe | `ubuntu-latest` | 24 | `0.2.2-rc.1` | An early-warning probe of the next host line. `0.2.2-rc.1` is **outside** `engines.dsh` (`^0.2.1-rc.5`), so this row is not a supported-host claim; the pinned rows above define support. |

Node 22 means the latest 22.x from `actions/setup-node`; `engines.node` requires at least 22.19.0. Node 24 is the current line. The DSH host is pinned in the workflow: every supported leg uses the version the devDependencies and `engines.dsh` name. The forward probe is pinned to `0.2.2-rc.1`, which is outside the declared range: semver lets a prerelease satisfy a range only when the major.minor.patch tuple matches, so `0.2.2-rc.1` is not admitted by `^0.2.1-rc.5`. It is an early-warning canary for the next host line, not a claim that the next line is supported. `latest` is deliberately not used, so the gate does not move without a commit.

**Excluded combinations.** Node 20 does not satisfy `engines.node`. Node 23 is excluded by `^22.19.0 || >=24.0.0`. Node 25 and later are admitted by `>=24.0.0` but are not gated; they are best-effort until a row is added. Windows is gated on Node 24 only: the Windows global `npm install` costs about ten minutes per leg, and a second Windows leg would nearly double that host's cost while the Node 22 line is already exercised on Linux and macOS. The CI covers x64 Linux, arm64 macOS and x64 Windows; it does not cover arm64 Linux, arm64 Windows or x64 macOS. The E2E has no native build step, so architecture differences are mostly host-runtime differences; add rows if a native dependency appears. GitHub Enterprise Server, real GitHub/Feishu accounts and a model provider are outside this check by design.

**Known platform limits.** All hosts install from a `link:` checkout, not a registry tarball, and the run stops at `repositoryUnset`: Sources, Sessions, model turns and delivery are not exercised. The browser rendering is not exercised either; the check fetches the page and the client asset. On Windows the host has no POSIX signal delivery: the check stops it by terminating the process, so it asserts the exit and the surviving state database rather than the graceful-drain behaviour asserted on Linux and macOS. Windows also requires `stateDir` as a POSIX-style absolute path such as `/Users/me/.dsh/state`: the current schema rejects a drive-letter path such as `C:\…`, and Node resolves the POSIX form against the host's current drive. The E2E uses that spelling; accepting drive letters is a product change outside this CI/scripts/docs task, so this is the supported Windows configuration until it lands. The `scripts/dsh-superagent` service wrapper is a POSIX shell script that uses tmux and is not supported on Windows; start the host directly with `dsh --profile superagent --no-open` or a Windows service manager. On macOS the wrapper works when tmux is installed, but CI does not install or exercise tmux. The `/bin/sh` account wrappers in this guide likewise need a Windows equivalent before Sources or delivery can run there.

**Timeouts.** The job timeout is 30 minutes, a backstop rather than an expected duration. Inside the script, each `dsh` invocation is bounded at 180 seconds, waiting for the Web URL and the panel API is bounded at 90 seconds each, and the graceful stop is bounded at 30 seconds. A timeout is a failed leg, never a skip.

**Cost.** On the 2026-11-10 run the Linux legs took about 48–61 s, macOS about 88–99 s, and the Windows leg about ten minutes, almost all of it the global `npm install` (about nine to ten minutes on the Windows runner) rather than the E2E. The legs run in parallel, so the matrix adds roughly ten minutes of wall-clock time but about 20 runner-minutes to a pull request; the two macOS legs also carry the higher billing multiplier. `concurrency` cancels superseded pull-request runs, `fail-fast: false` does not add retries (there are none), and the full `pnpm check` suite deliberately stays a single `ubuntu-latest`/Node 24 job instead of being copied onto every host. If the Windows install cost becomes a problem, cache the global host install; update this table and keep every remaining leg explicit. Do not turn a leg into a no-op, `continue-on-error`, or a silent skip.

## Machine configuration

Copy [examples/profile.cordis.patch.yml](../examples/profile.cordis.patch.yml) to `~/.dsh/profiles/superagent/cordis.patch.yml`, replacing that file, and replace every `<placeholder>`. For Feishu, also enable the `dsh-superagent-feishu` entry there, and for document comments the `dsh-superagent-feishu-doc` one. The `webserver` entry sets the panel's port.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: the database, the lock, the command shims in `worker-bin`, the agent's git configuration, the main Session's directory `system`, and by default the Ticket directories in `system/work`. Back it up before upgrades |
| `promptMaxChars`, `admissionContextMaxPages`, `admissionContextTimeoutMs` | no | The largest saved prompt configuration, and how many Thread pages one assessment reads within what time |

On Windows, write `stateDir` as a POSIX-style absolute path such as `/Users/me/.dsh/state`: the current schema rejects a drive-letter path such as `C:\…`, and Node resolves the POSIX form against the host's current drive. This is a product limitation, not a recommendation; it is called out with the other Windows limits below.

After the first start, edit machine limits in **Settings → Deployment** or the DeepSeek Harness Plugin Manager. Changes apply without restart. `stateDir` cannot be changed there. Invalid values or unknown configuration keys prevent startup; the log identifies the key.

## Start and stop

```sh
scripts/dsh-superagent start
scripts/dsh-superagent status
```

`start` runs `dsh --profile superagent` in tmux session `dsh-superagent`, or `dsh-<profile>` for another profile. It waits up to one minute for the runtime to become ready or report a setup requirement. On a first run it prints the missing setup information. It refuses duplicate instances, including ones started outside this script.

`stop` and `restart` request graceful shutdown and wait up to five minutes for Executors. They never force-kill the process or touch other tmux sessions.

`status` prints process ids, health and setup problems. For a different profile or port, use `--profile` and `--url`, or set `DSH_SUPERAGENT_PROFILE` and `DSH_SUPERAGENT_URL`.

`status`, `start` and `restart` exit with one of four codes:

| Code | Meaning |
| --- | --- |
| 0 | The service runs normally |
| 1 | It does not run, runs twice, does not answer, or its runtime reports an error; a restart may fix it |
| 2 | It runs, but a part other than the runtime, such as a Source or a Policy sync (`sync:<source id>`), reports an error; a restart does not fix it |
| 3 | It runs and waits for setup; a restart does not fix it |

A Source that is still starting counts as normal operation. So does a Feishu bot that setup could not check.

`status` returns failed parts and their details under `errors`, and setup requirements under `setup`. `start` and `restart` print those problems as lines; they exit 1 if the service never comes up. Only an intentional `stop` pauses automatic recovery.

Each profile stores logs and control files under `.artifacts/`:

- Startup logs: `dsh-superagent-<profile>-<date>-<time>-<pid>.log`, where the pid belongs to the script. The newest 20 are kept.
- Control files: `control/profiles/<profile>/`, containing the stop marker, lock and process id.

Open the URL printed in the log, then choose **Superagent** in the sidebar.

### Hourly check

Create the hourly check in the DeepSeek Harness profile you normally use, not in `superagent`. It must keep running when the agent service is down. Ask an agent in that profile to create an hourly schedule using this prompt, with the checkout path filled in:

```text
Check dsh-superagent: run `scripts/dsh-superagent --profile superagent status` in <checkout>. Exit 0: do nothing and say nothing. Exit 2: do not restart; tell me each part under `errors` with its detail, unless you already told me about the same ones. Exit 3: do not restart; tell me what `setup` says setup needs, unless you already told me. If it reports manually_stopped: true, leave it stopped. Otherwise (exit 1) run `scripts/dsh-superagent --profile superagent --respect-stop restart`, which exits the same way: 0 means it recovered, so say nothing; 2 and 3 are reported as above; if it exits 1 or fails otherwise, read the newest .artifacts/dsh-superagent-superagent-*.log and the Troubleshooting section of docs/006-deployment.md, fix what you can, and tell me what was wrong and what you did.
```

`--respect-stop` preserves an intentional stop. Only `stop` writes the marker; `start` clears it. `restart` writes no marker, so the check can recover a restart whose shutdown timed out.

## Settings

Setup must succeed before polling or work starts. Overview lists missing requirements and links to their settings. A settings change runs setup again. If you fix something outside the application, such as CLI authentication, choose **Check again**.

1. **Sources.** Set the GitHub repository (`owner/name`) and agent CLI, for example `/home/me/.local/bin/gh-agent`. Requests normally arrive through the agent account's notifications. A new Issue or comment mentioning the account arrives on the next poll; adding a mention by editing an existing Issue body does not. Post a new comment instead. For Feishu, set the bot CLI, chats, each chat's receive-all or mentions-only mode, and whether to receive direct messages.
2. **Policy.** The two example rules can be edited or removed. Under **On each Source**, add the GitHub accounts and Feishu users who may ask for work; until a list has someone, no request can become a Ticket. With Feishu, a chat can be chosen to sync the list from, at startup and on **Sync now**.
3. **Execution.** The directory root and a prepare command. To give each Ticket a checkout of the repository:

   ```sh
   git -C /home/me/src/widgets fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
   git -C /home/me/src/widgets worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
   ```

   List personal CLIs, such as one signed in to your own account, as blocked commands.
4. **Prompts.** Set the team sections: the GitHub disclosure line, review bots, the commit author and the auto-merge condition.

### Management API

The panel uses a local HTTP API that agents can also call. `SETUP.md` uses it to save settings, and the service script reads `GET state`.

Send requests to `http://127.0.0.1:<port>/orchestrator/api/` with `x-orchestrator-request: 1`. The host must be `127.0.0.1:<port>` or `localhost:<port>`. Missing headers or an `Origin` from another site receive 403.

API saves have the panel's permissions. They can change execution environment and setup account fields, unlike saves made through the main Session's tools.

Agents may rely on these routes and fields. The other routes in `packages/dsh/src/app/api.ts` serve the panel and change with it.

`PUBLIC_ROUTES` in `packages/dsh/src/app/api.ts` is the machine-readable list of these routes. `tests/docs.spec.ts` fails when this table and that list disagree; there is no exemption list, so a public route needs its row before it can land.

| Request | Answer |
| --- | --- |
| `GET state` | What every page reads: `setup`, with `problem` and `feishuProblem`, each `null` or a setup problem with `place`, `code`, `values` and `detail`, and `accounts` once setup resolved them; `health`, an entry per part, below, with `state` (`starting`, `ready`, `paused` or `error`), `detail` and `at`; `load`, the Executor Sessions `running`, the Tickets `queued` and `maxWorkers`; `paused`; `masterId`; and `build`, the running artifact's `version`, `commit`, `buildId`, `builtAt` and `dirty`, which Settings › Display shows next to the page's own build |
| `GET settings` | `blocks`: `policy`, `eval`, `dispatch` and `executor`, each with its `value` and its `revision`; `sources`: the Source instances, each with `id`, `kind`, `installed`, its block's `value`, `{"enabled": …, "config": {…}}`, and `revision`, its kind's form, and its setup `problem` when it has one; `policyVersion`; and `environment`, the execution environment's `root` and `variables` |
| `GET sources` | Each Source's status: `state` (`missing`, `off`, `error`, `setup`, `starting`, `paused` or `ready`), the `health` of its parts, its setup `problem`, the last day's `stats`, the Triggers it `filtered` in that day, and the messages it `dropped` in that day, newest drop first, each with its `channel`, `preview`, `ticket` (`id` and `title`) when it was for one, its `thread` when the store has it, and `dropped.at` and `dropped.reason`: `channelGone`, `channelIgnored`, a Mandate refusal (`actionLevelExceeded`, `mandateExpired`, `revoked`), or an Approval outcome (`approvalDenied`, `approvalExpired`, `approvalRevoked`, `approvalMissing`, `approvalLevelInsufficient`, `approvalTargetMismatch`), or `ticketMissing` when the message named a Ticket the store no longer has |
| `PUT settings/<block>` with `{"value": …, "revision": n}` | Saves one block: `saved`, the block's new `revision`, `policy_changed` and `restarting`. `value` is the whole block, as `GET settings` holds it; a missing key takes its default |
| `POST executor/pause` with `{"paused": true}` or `false` | Pauses or resumes processing: `paused` |
| `POST setup/check` | Runs setup again by restarting dsh-superagent: `restarting: true`. Refused when setup has nothing to fix |
| `POST policy-sync/<source id>` | Syncs that Source's allowed list now: `policy`, the Source's part as saved |
| `GET prompts`, `PUT prompts` with `{"config", "baseRevision"}` | Reads the prompt configuration: `current`, with its `revision` and `config`, `defaults`, `sections`, the team sections in the order Sessions read them, `skillName`, the pattern of a team skill's name, `builtin`, the names a team skill cannot take, and `skillPrefix`, which Sessions load a skill's name under. Or saves it: the new `revision` |
| `POST tickets/<id>/retry`, `POST tickets/<id>/stop` | Retries or stops a root Ticket, as the panel does; a child Ticket is refused with `childRequiresParent` |
| `POST tickets/<id>/approve` with `{"reviewRevision": "…"}` | Accepts the root Ticket's current review aggregate at that revision, as the panel does, and answers `approved: true` and the revision. Refused with `childRequiresParent` for a child Ticket, `unfinishedChildTickets` while child Tickets are unresolved, `reviewNotReady` when the Ticket is not awaiting review, `deliverablePreviewMissing` when the aggregate has no deliverable, or `409 reviewStale` when the revision is no longer current |
| `POST outbox/<id>/recall` | Recalls a pending message while its undo window is open and answers `status: recalled`. A message that is unknown, already settled or past its window is refused with `unknownReply`/`replySettled`/`undoClosed` and their values |
| `POST approvals/<id>/approve` with `{"level": "draft"}` or `{}`, and `POST approvals/<id>/deny` | Records the panel's decision on one requested Approval, as the panel does, and reconciles the outbox so a held message is released or dropped. The level is optional and may only lower the requested Action's level; the answer is `state` and, for an approval, the granted `level` |

Health entries are grouped by responsibility:

| Entry | Reports |
| --- | --- |
| `runtime` | The application itself |
| `models` | Sessions waiting on a model-budget retry |
| `evals` | Unavailable Evals from the last hour with no later judgement or dismissal |
| `assessment`, `launch`, `delivery`, `relay`, `notice`, `reply` | Stored work described in [003 Execution](003-execution.md); delivery counts waiting work, while reply covers Channel messages |
| `worker` | Executor Session event handling; appears after its first failure |
| `github`, `feishu`, `feishu-doc`, `history` | Source polling, events, document comments and history recovery |
| `sync:<source id>` | Allowed-list synchronization |

A refusal has a status and `error`, its English text:

- 400: an invalid value (`issues`, each with its `path`), a failed account check (`setup`), a fixed refusal (`code` and `values`), or a body that is not JSON or is too large.
- 404: something that does not exist.
- 409: a stale revision.
- 500: anything else.

The blocks:

- `source:github`, `source:feishu`, `source:feishu-doc`: `{"enabled": true, "config": {…}}`. GitHub's config has `repository` and `cli` and the panel switches `observeIssues`, `observePulls`, `observeComments`, `observeCi` and `humanIdentity`, all off by default; the receive switches read every new Issue, new pull request and comment in the repository and the default branch's CI, while `humanIdentity` treats a decisive review or a `[人]`/`HUMAN:` comment from the agent's own account as a person's action (see [002 Authorization](002-authorization.md#human-identity-on-a-shared-github-account)); the panel names `observeComments` and `observePulls` as its dependencies and offers to turn them on when they are off, since those switches decide what the Source reads across the repository (marked comments are read by the comment stream whenever the flag is on); Feishu's has `cli`, `chats` as `[{"chatId": "oc_…", "name": "…", "listen": "mentions"}]` (or `"all"`), `directMessages`, and `otherChats` as `"none"` or `"mentions"`; Feishu documents' has `documents` as `[{"url": "https://…/docx/…", "name": "…", "listen": "mentions"}]` (or `"all"`), `pollSeconds` and `failuresBeforeError`. The document Source uses the bot configured on the Feishu Source, and its admission rows are keyed by document URL.
- `policy`: `{"rules": […], "maxActionLevel": "draft", "mandateMinutes": 0, "undoWindowSeconds": 30, "sources": {"github": {"allowed": [{"id": "<login>"}], "bots": [{"id": "dependabot[bot]"}]}, "feishu": {"allowed": [{"id": "ou_…", "name": "…"}], "syncChat": "oc_…", "admission": {"oc_…": {"unlistedAddressed": "explicit"}}}, "feishu-doc": {"allowed": [{"id": "ou_…"}], "admission": {"https://…/docx/…": {"unlistedAddressed": "explicit"}}}}}`. `bots` lists the bots whose messages may become inferred candidates. `maxActionLevel` is the highest action level a Mandate may authorize (`read`, `draft`, `commit`, `send` or `spend`; default `draft`, so raise it explicitly to allow `commit`, `send` or `spend`), and `mandateMinutes` is a new Mandate's lifetime in minutes (default `0`, meaning until revoked). `undoWindowSeconds` is how long an outbound message stays recallable before it is sent (`0`–`300`; default `30`, while an IM tenant usually sets `0` to avoid delaying replies). An `admission` row is keyed by chat id, `other` or `direct` for Feishu, by document URL for Feishu documents, and by `issues`, `pulls`, `comments` or `ci` for GitHub; an unset cell takes its default (see [002 Authorization](002-authorization.md)).
- `eval`: `mode`, `timeoutSeconds` and `model`.
- `executor`: `model`, `maxWorkers`, `directory`, `prepare`, `blockedCommands`, `workspace` and `lightweight` (default `true`; `false` keeps every accept tracked with its Assignment and workspace, even when the decision asked for the lightweight form). `workspace` has two booleans, both default `true`: `lease` reserves and activates the additive `space_lease` write lease before and after prepare, and `childSibling` puts a child Ticket's directory beside its root under the execution root instead of inside its parent. Turning `lease` off returns to path-only behavior; `space_lease` stays. An older binary still refuses schema 16, so a binary rollback follows the backup rule above. Turning `childSibling` off keeps the old nested layout for new child Tickets. The processing pause is a setting of its own, `paused`, which `POST executor/pause` sets.

Changing a repository or CLI runs the corresponding setup check first. A failed check returns 400 with details in `setup`. A successful account change, or any save while setup is pending, returns `restarting: true`. The API is temporarily unavailable while the application restarts.

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "github") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:github \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"repository\": \"acme/widgets\", \"cli\": \"$HOME/.local/bin/gh-agent\"}}, \"revision\": $rev}"
```

## Setup checks

Setup uses the DeepSeek Harness subprocess service, as worker shells do. It removes environment variables whose names contain KEY, PASSWORD, SECRET or TOKEN.

Setup verifies the GitHub repository and the agent's push access, writes the worker environment, and checks that git uses only the agent credentials for github.com. A Feishu setup failure disables only the Feishu Source.

The process environment that setup writes:

- **Command shims** in `<stateDir>/worker-bin`, first on `PATH`: `gh` runs the agent's CLI; `lark-cli` runs the bot's CLI; blocked commands fail. A shim removes its own directory from `PATH` before it runs its target.
- **git configuration** in `<stateDir>/worker-gitconfig`: replaces the operator's global and system git configuration. It selects the agent CLI as the github.com credential helper, rewrites GitHub SSH addresses to HTTPS and defines Git LFS filters. Personal git settings such as an HTTP proxy do not apply. No commit identity is set here, git never prompts for credentials, and `GH_TOKEN` and `GITHUB_TOKEN` are removed.

A file in `worker-bin` or `worker-gitconfig` that dsh-superagent did not write stops setup. A Ticket directory inside a git repository whose own configuration adds credentials fails the Ticket.

## Try it

From an allowed GitHub account, open an Issue or post a comment containing `@<agent login> <request>`. Within a polling interval (one minute by default), Overview should show a Ticket. The agent acknowledges the request, works in its own Session and directory, and delivers in the original conversation. For Feishu, mention the bot in a configured chat.

## Upgrade

1. Wait until no Executor is in the middle of a turn.
2. Back up `<stateDir>/orchestrator.sqlite`.
3. Run `git pull && pnpm install && pnpm build`.
4. Run `scripts/dsh-superagent restart` and inspect its status.
5. Open the URL and hard-reload the tab (`Ctrl/⌘+Shift+R`); the open panel keeps its previous document across a restart. Check **Settings › Display › Interface build**: the page and service build ids should match and the build time should be the one just produced; docs/027 lists the full per-screen checklist.

A restart ends running Assignments and starts replacements with recovery notes. Team text and overridden prompt parts are retained; parts without overrides follow the new defaults. Review parts marked **Default updated** after upgrading.

A database migrated by a newer version cannot be opened by an older one. Rollback therefore requires the pre-upgrade backup. After upgrading DeepSeek Harness itself, restart the running instance so the panel loads matching artifacts.

### Agent presets

The worker and router presets move shell commands to the background after 5 seconds. A Session cannot load without its preset. Keep the `dsh-superagent-worker` and `dsh-superagent-router` rows in `cordis.patch.yml` while their Sessions are in use; otherwise resume fails with `agent-preset/not-found`.

## Troubleshooting

Setup problems appear on the overview with a link to the fix, in the panel's language; the log and the API show the English text below.

| Symptom | Cause and fix |
| --- | --- |
| `The agent GitHub CLI is not set.` | Set the agent's CLI on the GitHub card |
| `The agent GitHub CLI was not found.` | Set the wrapper's absolute path, or a command name on `PATH` |
| `The agent GitHub CLI cannot read its account` | Sign the wrapper in with `auth login` |
| `@… cannot read …` or `@… cannot push to …` | Give the agent account write access to the repository |
| `The GitHub Source names no repository.` | Set the repository, `owner/name`, on the GitHub card |
| A Ticket fails with `The prepare command failed: …` | The output names the cause, such as a wrong clone path; fix the command, then retry the Ticket |
| `git does not read the github.com credential configuration dsh-superagent writes` | Install git 2.32 or later |
| A Ticket fails with `The git configuration of the repository in … sets …` | Remove the named credential or `http.*.extraheader` settings from the clone's `.git/config` |
| `… was not written by dsh-superagent` | Move the named file out of `<stateDir>/worker-bin` or `<stateDir>/worker-gitconfig`, or choose another `stateDir` |
| `The bot lark-cli allows user identities` | Point the Feishu Source at a bot-only configuration, as in Feishu bot above |
| `The bot lark-cli does not work.` or `The bot identity of app … is …` | Check the configuration's app id and secret |
| `The Feishu bot is not a member of the chat.` | Add the bot to the chat in the chat's settings; the next attempt succeeds |
| `status` exits 2 | A part reports an error, which a restart does not fix: `errors` names each part, as listed under Management API, with its detail; each part clears its own entry once it works again |
| `status` exits 3 | Setup waits: `setup` says what is missing, and the overview links to the setting that fixes it |
| `status` exits 1 | The service does not run, runs twice, does not answer, or its runtime reports an error; the output and the newest log say which |
| `… timed out after 90 s`, `… was stopped by …`, `… exited with code …` or `… could not run: …` | A CLI failed without printing why; run the named program by hand as the operator's user to see its own message |
| The panel says dsh-superagent is not answering | It is restarting, or did not start because of its configuration; the DeepSeek Harness log names the cause |
| `dsh-superagent configuration has keys it does not use` (log) | Remove the named keys; the message says where each value lives now |
| The log says the plugin is incompatible with the running dsh | Install a DeepSeek Harness version within the `engines.dsh` range |
| The panel still looks like the previous build after `git pull` and a restart | The open tab keeps its old document and bundle; the sidebar's host rows stay unchanged. Hard-reload (`Ctrl/⌘+Shift+R`), then compare the page and service build ids in **Settings › Display**; docs/027 separates a stale page from a stale build |
| The panel shows "Failed to load plugins" after a DeepSeek Harness upgrade | Restart the running instance |
| Nothing happens after a mention | Check that the author is on the Source's allowed list, the Source is on, and processing is not paused. On GitHub, a mention added by editing an Issue's body is not received; mention the agent in a comment |
