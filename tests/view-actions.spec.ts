import { expect, it, vi } from 'vitest'
import { CONVERSATION_VIEW, registerConversationView, revealConversation } from '@superagent/dsh/client/view-actions.ts'

it('returns the mounted Session to its Conversation View', () => {
  const openView = vi.fn()
  const remove = registerConversationView('session-a', openView)
  expect(revealConversation('session-a')).toBe(true)
  expect(openView).toHaveBeenCalledExactlyOnceWith(CONVERSATION_VIEW, '')
  remove()
  expect(revealConversation('session-a')).toBe(false)
  expect(openView).toHaveBeenCalledOnce()
})

it('leaves a Session already showing Chat alone', () => {
  const openView = vi.fn()
  // Chat has no plugin View seat mounted, so an "open conversation" action has nothing to change.
  expect(revealConversation('session-chat')).toBe(false)
  expect(openView).not.toHaveBeenCalled()
})

it('keeps the current seat when a replaced seat unmounts late', () => {
  const first = vi.fn(); const second = vi.fn()
  const removeFirst = registerConversationView('session-b', first)
  const removeSecond = registerConversationView('session-b', second)
  removeFirst()
  expect(revealConversation('session-b')).toBe(true)
  expect(second).toHaveBeenCalledExactlyOnceWith(CONVERSATION_VIEW, '')
  expect(first).not.toHaveBeenCalled()
  removeSecond()
  expect(revealConversation('session-b')).toBe(false)
})