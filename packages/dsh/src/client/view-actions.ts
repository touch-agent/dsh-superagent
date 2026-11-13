/** Per-Session View selection lent by the host's Conversation seat, so the plugin can return an open Session to Chat. */

/** The Core Conversation View every host Session registers beside the plugin's Status and the host's Trajectory. */
export const CONVERSATION_VIEW = 'chat'

type OpenView = (view: string, focus: string) => void
const seats = new Map<string, OpenView>()

/**
 * Record the View selector of the Session whose `conversation.view` seat is mounted.
 * The host's `selectView` both activates the View and writes its per-Session preference, so using it keeps the next
 * Session visit on the same View; `UiConversation.binding().activate()` only pre-activates assembly and would not
 * move the visible tab.
 * @param sessionId - Session owning the mounted View seat.
 * @param openView - The seat's Session-bound selector.
 * @returns removal for the seat's unmount.
 */
export function registerConversationView(sessionId: string, openView: OpenView): () => void {
  seats.set(sessionId, openView)
  return () => { if (seats.get(sessionId) === openView) seats.delete(sessionId) }
}

/**
 * Return an open Session to its Conversation View.
 * Selecting the Session that is already current has no visible effect by itself, and a Session whose last View was
 * Status keeps Status in front; both make an "open conversation" action look dead. A Session already showing Chat
 * has no mounted Status seat, so nothing is called.
 * @param sessionId - Session the action opened.
 * @returns whether a mounted View seat handled the request.
 */
export function revealConversation(sessionId: string): boolean {
  const openView = seats.get(sessionId)
  if (!openView) return false
  openView(CONVERSATION_VIEW, '')
  return true
}
