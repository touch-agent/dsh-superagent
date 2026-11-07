/** The GitHub adapter's conformance fixture: real Trigger builders, scope decisions and Channel sends for one repository. */
import type { Commands } from '@superagent/dsh/infra/commands.ts'
import { CliError } from '@superagent/dsh/infra/commands.ts'
import { githubAdapter, githubDefinition, type GithubConfig } from '@superagent/dsh/sources/github.ts'
import { commentTrigger, issueTrigger, pullTrigger, type GithubComment } from '@superagent/dsh/sources/github-trigger.ts'
import { cursorAt } from '@superagent/dsh/sources/poll.ts'
import { testDeployment } from '../fixtures/deployment.ts'
import type { ConformanceSubject, SendHost } from './suite.ts'

const AGENT = 'agent-bot'
const REPOSITORY = 'acme/widgets'
const LATEST = '2026-11-07T12:00:00.000Z'

const issue = { number: 12, title: 'Fix the margin', body: '@agent-bot please fix the margin', state: 'open',
  user: { login: 'carol', type: 'User' }, created_at: '2026-11-07T10:00:00Z', html_url: 'https://github.com/acme/widgets/issues/12' }
const pull = { number: 13, title: 'Fix the margin', body: 'Closes #12', state: 'open',
  user: { login: 'carol', type: 'User' }, created_at: '2026-11-07T10:30:00Z', html_url: 'https://github.com/acme/widgets/pull/13' }
const comment: GithubComment = { id: 501, body: 'Any update on this?', user: { login: 'carol', type: 'User' },
  html_url: 'https://github.com/acme/widgets/issues/12#issuecomment-501',
  created_at: '2026-11-07T11:00:00Z', updated_at: '2026-11-07T11:00:00Z' }

/** The configuration with every repository stream switched off, and one with all of them observed. */
const quiet = githubAdapter.schema.parse({ repository: REPOSITORY, cli: 'gh' })
const observing = githubAdapter.schema.parse({ repository: REPOSITORY, cli: 'gh', observeIssues: true, observePulls: true,
  observeComments: true, observeCi: true })

/** A fresh `Commands` stub; `calls` keeps the remote paths and flags so the suite can find the outbound id. */
function host(pages: (path: string) => unknown[] = () => [], api: (path: string) => unknown = () => ({})): SendHost {
  const calls: string[] = []
  const deployment = testDeployment({ repository: REPOSITORY, github: { cli: '/bin/false', login: AGENT, noreply: '' } })
  const commands = {
    deployment,
    pages: async (_schema: unknown, path: string) => { calls.push(`pages ${path}`); return pages(path) },
    api: async (_schema: unknown, path: string, ...flags: string[]) => { calls.push(`api ${path} ${flags.join(' ')}`); return api(path) },
  } as unknown as Commands
  return { commands, calls }
}

const reviewMessage = { id: 'reply-501', channel: { source: 'github', thread: 'github:12',
  address: { number: '12', url: 'https://github.com/acme/widgets/pull/12#discussion_r99' } }, text: 'Addressed in #14', kind: 'reply' as const }

export function githubConformance(): ConformanceSubject<GithubConfig> {
  return {
    config: quiet,
    definition: githubDefinition,
    events: [
      { name: 'an opened Issue', trigger: () => issueTrigger(issue, AGENT),
        replay: () => issueTrigger({ ...issue, body: '@agent-bot please fix the margin' }, AGENT) },
      { name: 'an opened pull request', trigger: () => pullTrigger(pull, AGENT),
        replay: () => pullTrigger({ ...pull }, AGENT) },
      { name: 'an Issue comment', trigger: () => commentTrigger(comment, { number: 12, isPr: false }, 'conversation', AGENT),
        replay: () => commentTrigger({ ...comment }, { number: 12, isPr: false }, 'conversation', AGENT) },
    ],
    scope: [
      { name: 'an Issue while new Issues are not observed', config: quiet, meta: { number: 12, isPr: false, kind: 'issue' },
        expected: { listened: true, observed: false, row: 'issues' } },
      { name: 'an Issue while new Issues are observed', config: observing, meta: { number: 12, isPr: false, kind: 'issue' },
        expected: { listened: true, observed: true, row: 'issues' } },
      { name: 'a pull request while new pull requests are not observed', config: quiet, meta: { number: 13, isPr: true, kind: 'pull' },
        expected: { listened: true, observed: false, row: 'pulls' } },
      { name: 'a comment while repository comments are observed', config: observing, meta: { number: 12, isPr: false, kind: 'conversation' },
        expected: { listened: true, observed: true, row: 'comments' } },
      { name: 'default-branch CI while CI is not observed', config: quiet, meta: { ci: true, branch: 'main', sha: 'abc', revision: 2 },
        expected: { listened: true, observed: false, row: 'ci' } },
      { name: 'default-branch CI while CI is observed', config: observing, meta: { ci: true, branch: 'main', sha: 'abc', revision: 2 },
        expected: { listened: true, observed: true, row: 'ci' } },
      { name: 'a Trigger with no admission row', config: quiet, meta: {},
        expected: { listened: true, observed: false } },
    ],
    sends: [
      { name: 'a new conversation comment', message: { id: 'reply-1', channel: { source: 'github', thread: 'github:12',
        address: { number: '12', url: 'https://github.com/acme/widgets/issues/12' } }, text: 'Fixed in #14', kind: 'reply' },
        outcome: 'sent', host: () => host() },
      { name: 'a review thread reply', message: reviewMessage, outcome: 'sent', host: () => host(() => [],
        path => path === 'pulls/comments/99' ? { id: 99, user: { login: 'carol' }, body: '' } : {}) },
      // A locked Issue can never receive the comment, so the message is dropped rather than retried forever.
      { name: 'a locked Issue', message: { id: 'reply-2', channel: { source: 'github', thread: 'github:12',
        address: { number: '12', url: 'https://github.com/acme/widgets/issues/12' } }, text: 'Fixed', kind: 'reply' },
        outcome: 'gone', host: () => host(() => { throw new CliError('Issues are locked', 403) }) },
      // Any other failure may succeed later; the Channel must leave it to the Outbox's retry.
      { name: 'a server error', message: { id: 'reply-3', channel: { source: 'github', thread: 'github:12',
        address: { number: '12', url: 'https://github.com/acme/widgets/issues/12' } }, text: 'Fixed', kind: 'reply' },
        outcome: 'throw', host: () => host(() => { throw new CliError('Server error', 500) }) },
    ],
    // The newest repository item is where the next round starts; `cursorAt` steps it back for late writes.
    cursor: { from: LATEST, next: () => cursorAt(LATEST) },
  }
}