/**
 * Invisible delivery marks for Feishu messages: neither the IM reply API nor the document comment reply API returns the
 * idempotency key it was sent with, so a sent message carries a zero-width mark naming its outbound message. A retry
 * reads that mark back to answer whether the message already arrived; readers see only the message text.
 */
const MARK = '\u200d'
const ZERO = '\u200b'
const ONE = '\u200c'
/** Encodes an outbound message ID as zero-width characters readers do not see. */
export function deliveryMark(id: string): string {
  const bits = [...id].map(char => char.charCodeAt(0).toString(2).padStart(16, '0')).join('')
  return MARK + bits.replaceAll('0', ZERO).replaceAll('1', ONE) + MARK
}
/** The message IDs a text carries, in the order they appear. */
export function deliveryMarkIds(text: string): string[] {
  const ids: string[] = []
  let index = text.indexOf(MARK)
  while (index >= 0) {
    const end = text.indexOf(MARK, index + 1)
    if (end < 0) break
    const bits = [...text.slice(index + 1, end)].map(char => char === ONE ? '1' : char === ZERO ? '0' : undefined)
    if (bits.length % 16 === 0 && bits.every(bit => bit !== undefined)) {
      const chars = (bits.join('').match(/.{16}/g) ?? []).map(part => String.fromCharCode(parseInt(part, 2)))
      ids.push(chars.join(''))
      index = end + 1
    } else index += 1
  }
  return ids
}
/** Removes every delivery mark from text, so models read what a person wrote. */
export function stripDeliveryMarks(text: string): string {
  return deliveryMarkIds(text).reduce((result, id) => result.replace(deliveryMark(id), ''), text).trim()
}