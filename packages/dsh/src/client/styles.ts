/** Install the plugin stylesheet in the document head, so surfaces outside the management panel are styled too. */
import STYLES from './client.css?raw'

const ID = 'dsh-superagent-styles'
/** Append the stylesheet once and return a disposer; every `.dt-` rule is namespaced, so a global element is safe. */
export function mountStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.getElementById(ID)) return () => {}
  const style = document.createElement('style')
  style.id = ID
  style.textContent = STYLES
  document.head.append(style)
  return () => { style.remove() }
}
