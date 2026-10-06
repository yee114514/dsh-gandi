/**
 * Key-name translation for synthetic keyboard input.
 *
 * Scratch has TWO key-name vocabularies and they are not interchangeable
 * (`scratch-vm/src/io/keyboard.js`):
 *
 *   - `_keyArgToScratchKey` (:108) converts a BLOCK argument — the dropdown value
 *     "space", "left arrow", … — into a Scratch key name. That is what
 *     `sensing_keypressed` compares against.
 *   - `_keyStringToScratchKey` (:67) converts a DOM `KeyboardEvent.key` — `" "`,
 *     `"ArrowLeft"`, `"Enter"` — into the same names, and `postData` (:160) uses
 *     it. Anything longer than one character that is not in its switch list is
 *     treated as a modifier and DROPPED, so posting `{key: "space"}` presses
 *     nothing at all, silently.
 *
 * A model writing "press the space key" will say "space", so translate here rather
 * than making every caller remember which vocabulary each API wants.
 */

/** Friendly name -> DOM `KeyboardEvent.key` value. */
const DOM_KEY_BY_NAME = Object.freeze({
  space: ' ',
  spacebar: ' ',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  // The spellings scratch-blocks puts in the key dropdown.
  'left arrow': 'ArrowLeft',
  'right arrow': 'ArrowRight',
  'up arrow': 'ArrowUp',
  'down arrow': 'ArrowDown',
  'page up': 'PageUp',
  'page down': 'PageDown',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  shift: 'Shift',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  capslock: 'CapsLock',
  scrolllock: 'ScrollLock',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
})

/** Names that are valid DOM key values already, so they pass through untouched. */
const DOM_KEY_PASSTHROUGH = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Backspace',
  'Delete', 'Insert', 'Shift', 'Control', 'Alt', 'CapsLock', 'ScrollLock', 'Tab',
  'Home', 'End', 'PageUp', 'PageDown'
])

/**
 * Convert a key name a human or model would write into the DOM key value that
 * `vm.postIOData('keyboard', …)` expects.
 *
 * @param {string} name e.g. "space", "ArrowRight", "a", " "
 * @returns {string} the DOM key value, or an empty string when nothing usable was given
 */
export const toDomKey = (name) => {
  if (typeof name !== 'string') return ''
  // A single space IS the spacebar's DOM key value, so it must survive the trim.
  if (name === ' ') return ' '
  const trimmed = name.trim()
  if (trimmed.length === 0) return ''
  if (trimmed.length === 1) return trimmed
  if (DOM_KEY_PASSTHROUGH.has(trimmed)) return trimmed
  const mapped = DOM_KEY_BY_NAME[trimmed.toLowerCase()]
  return mapped ?? ''
}

/**
 * Whether a key name can be posted at all, for early argument validation.
 * @param {string} name candidate key name
 * @returns {boolean} true when {@link toDomKey} would produce something
 */
export const isPostableKey = (name) => toDomKey(name).length > 0

/**
 * The Scratch key names a caller is most likely to mean, for error messages.
 * @returns {string[]} the friendly spellings
 */
export const knownKeyNames = () => Object.keys(DOM_KEY_BY_NAME).sort()
