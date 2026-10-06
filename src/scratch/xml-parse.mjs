/**
 * A minimal, dependency-free XML parser covering the scratch-blocks/Blockly XML
 * subset that Scratch projects use.
 *
 * Why hand-rolled: the plugin must run inside the DSH host process, which has no
 * XML parser available and no guaranteed DOM. The subset is small — elements,
 * attributes, text, self-closing tags, comments, processing instructions and a
 * DOCTYPE — so a scanner is both shorter and more predictable than pulling in a
 * dependency, and it lets us report precise offsets on malformed input.
 *
 * Deliberately NOT supported (and reported as errors rather than silently
 * mis-parsed): CDATA sections and external entities. Neither appears in XML
 * produced by scratch-blocks.
 */

/** Raised for malformed XML, with the byte offset of the offending construct. */
export class XmlParseError extends Error {
  /**
   * @param {string} message what went wrong
   * @param {number} index offset into the source
   */
  constructor (message, index) {
    super(`${message} (at offset ${index})`)
    this.name = 'XmlParseError'
    this.index = index
  }
}

/** The five predefined XML entities. Numeric character references are handled separately. */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

/**
 * One parsed element. `text` holds the concatenation of this element's direct
 * text nodes, untrimmed: a `<field>` value's leading/trailing spaces are
 * significant in Scratch (they are part of the string literal).
 *
 * @typedef {object} XmlElement
 * @property {string} name tag name, namespace prefix included when present
 * @property {Record<string, string>} attributes attribute values, entity-decoded
 * @property {XmlElement[]} children child elements, in document order
 * @property {string} text direct text content
 * @property {number} index offset of the element's `<`
 */

/**
 * Decode XML entity and character references.
 * @param {string} raw text possibly containing references
 * @param {number} index offset used for error reporting
 * @returns {string} decoded text
 */
const decodeReferences = (raw, index) => {
  if (!raw.includes('&')) return raw
  return raw.replace(/&([^;\s]{1,32});/g, (match, body) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        throw new XmlParseError(`invalid character reference &${body};`, index)
      }
      return String.fromCodePoint(code)
    }
    const value = NAMED_ENTITIES[body]
    if (value === undefined) throw new XmlParseError(`unknown entity &${body};`, index)
    return value
  })
}

/** Characters allowed in a tag or attribute name. */
const NAME_START = /[A-Za-z_:]/
const NAME_CHAR = /[A-Za-z0-9_:.\-]/

/**
 * Parse a scratch-blocks/Blockly XML document.
 *
 * The result is the single document element. A document with no element, or with
 * trailing content after the root, is an error.
 *
 * @param {string} source XML text
 * @returns {XmlElement} the root element
 * @throws {XmlParseError} on malformed XML
 */
export function parseXml (source) {
  if (typeof source !== 'string') throw new TypeError('parseXml expects a string')

  let i = 0
  const length = source.length

  /** Skip whitespace, comments, processing instructions and a DOCTYPE. */
  const skipMisc = () => {
    for (;;) {
      while (i < length && /\s/.test(source[i])) i++
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i + 4)
        if (end === -1) throw new XmlParseError('unterminated comment', i)
        i = end + 3
        continue
      }
      if (source.startsWith('<?', i)) {
        const end = source.indexOf('?>', i + 2)
        if (end === -1) throw new XmlParseError('unterminated processing instruction', i)
        i = end + 2
        continue
      }
      if (source.startsWith('<!DOCTYPE', i)) {
        const end = source.indexOf('>', i)
        if (end === -1) throw new XmlParseError('unterminated DOCTYPE', i)
        i = end + 1
        continue
      }
      return
    }
  }

  /** Read an element name starting at the cursor. */
  const readName = () => {
    const start = i
    if (i >= length || !NAME_START.test(source[i])) {
      throw new XmlParseError('expected a name', i)
    }
    i++
    while (i < length && NAME_CHAR.test(source[i])) i++
    return source.slice(start, i)
  }

  /** Read one attribute into `attributes`. */
  const readAttribute = (attributes) => {
    const name = readName()
    while (i < length && /\s/.test(source[i])) i++
    if (source[i] !== '=') throw new XmlParseError(`attribute "${name}" has no value`, i)
    i++
    while (i < length && /\s/.test(source[i])) i++
    const quote = source[i]
    if (quote !== '"' && quote !== "'") {
      throw new XmlParseError(`attribute "${name}" value is not quoted`, i)
    }
    i++
    const end = source.indexOf(quote, i)
    if (end === -1) throw new XmlParseError(`attribute "${name}" value is unterminated`, i)
    const raw = source.slice(i, end)
    attributes[name] = decodeReferences(raw, i)
    i = end + 1
  }

  /** Parse one element, assuming the cursor sits on its `<`. */
  const parseElement = () => {
    const start = i
    i++ // consume '<'
    const name = readName()
    /** @type {Record<string, string>} */
    const attributes = {}
    for (;;) {
      const beforeSpace = i
      while (i < length && /\s/.test(source[i])) i++
      if (source[i] === '/') {
        if (source[i + 1] !== '>') throw new XmlParseError('expected "/>"', i)
        i += 2
        return { name, attributes, children: [], text: '', index: start }
      }
      if (source[i] === '>') {
        i++
        break
      }
      if (i >= length) throw new XmlParseError(`element <${name}> is unterminated`, start)
      if (i === beforeSpace && Object.keys(attributes).length === 0 && source[i] === undefined) {
        throw new XmlParseError(`element <${name}> is malformed`, start)
      }
      readAttribute(attributes)
    }

    /** @type {XmlElement[]} */
    const children = []
    let text = ''
    for (;;) {
      const next = source.indexOf('<', i)
      if (next === -1) throw new XmlParseError(`element <${name}> is unterminated`, start)
      if (next > i) {
        text += decodeReferences(source.slice(i, next), i)
        i = next
      }
      if (source.startsWith('</', i)) {
        i += 2
        const closing = readName()
        if (closing !== name) {
          throw new XmlParseError(`element <${name}> closed by </${closing}>`, i)
        }
        while (i < length && /\s/.test(source[i])) i++
        if (source[i] !== '>') throw new XmlParseError('expected ">" after a closing tag', i)
        i++
        return { name, attributes, children, text, index: start }
      }
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i + 4)
        if (end === -1) throw new XmlParseError('unterminated comment', i)
        i = end + 3
        continue
      }
      if (source.startsWith('<![CDATA[', i)) {
        throw new XmlParseError('CDATA sections are not supported', i)
      }
      if (source.startsWith('<?', i)) {
        const end = source.indexOf('?>', i + 2)
        if (end === -1) throw new XmlParseError('unterminated processing instruction', i)
        i = end + 2
        continue
      }
      children.push(parseElement())
    }
  }

  skipMisc()
  if (i >= length) throw new XmlParseError('no root element', i)
  const root = parseElement()
  skipMisc()
  if (i < length) throw new XmlParseError('unexpected content after the root element', i)
  return root
}

/**
 * Find the first direct child element with the given tag name.
 * @param {XmlElement} element parent
 * @param {string} name tag name to match
 * @returns {XmlElement|undefined} the child, if any
 */
export const childElement = (element, name) =>
  element.children.find((child) => child.name === name)

/**
 * All direct child elements with the given tag name.
 * @param {XmlElement} element parent
 * @param {string} name tag name to match
 * @returns {XmlElement[]} matching children
 */
export const childElements = (element, name) =>
  element.children.filter((child) => child.name === name)

/**
 * Serialize one string for use as XML text or a quoted attribute value.
 * @param {string} value raw text
 * @returns {string} escaped text
 */
export const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
