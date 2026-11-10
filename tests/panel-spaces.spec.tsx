// @vitest-environment jsdom
// Phase 1/2 read-only spaces: the Ticket page space block and the Execution list, with the legacy fallback.
import { expect, it, vi } from 'vitest'
import { en, zh } from '@superagent/dsh/client/locales.ts'
import { usePanel, mount, click, text } from './fixtures/panel.tsx'

usePanel()

it('shows the Ticket space by name, kind, branch, state and holder without exposing its path', async () => {
  await mount()
  await click('修复回归')
  await click(zh.space)
  expect(text()).toContain(zh.space)
  expect(text()).toContain('fix-login')
  expect(text()).toContain(zh['spaceKind.checkout'])
  expect(text()).toContain(zh['spaceState.active'])
  expect(text()).toContain(zh.spaceHolder)
  expect(text()).toContain('修复回归')
  expect(text()).not.toContain('/w/t1')
  expect(text()).not.toContain('/srv/work/t1-abc123def456')
})

it('lists spaces on the Execution page with the path, lease generation and a copy action', async () => {
  const writeText = vi.fn(async () => {})
  Object.assign(navigator, { clipboard: { writeText } })
  await mount()
  await click(zh['tab.execution'])
  expect(text()).toContain(zh.spaces)
  expect(text()).toContain('/srv/work/t1-abc123def456')
  expect(text()).toContain(zh['spaceFilter.all'])
  expect(text()).toContain('fix-login')
  expect(text()).toContain('租约：持有中 · 第 1 代')
  await click(zh.copyPath)
  expect(writeText).toHaveBeenCalledWith('/srv/work/t1-abc123def456')
  expect(text()).toContain(zh.copied)
})

it('rolls back to the legacy directory identifiers with workspace.view=off', async () => {
  localStorage.setItem('workspace.view', 'off')
  await mount()
  await click('修复回归')
  await click(zh.identifiers)
  expect(text()).toContain('/w/t1')
  expect(text()).not.toContain('fix-login')
  expect(en.space).toBe('Space')
  localStorage.removeItem('workspace.view')
})