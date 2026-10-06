/**
 * The little bit of SVG inspection the costume path needs.
 *
 * Scratch rotates a sprite around its costume's rotation centre. A costume added
 * with a centre of (0, 0) spins around its top-left corner, which looks broken and
 * is easy to mistake for a scripting bug — so when the caller does not supply a
 * centre, one is derived from the SVG's own geometry.
 *
 * This is deliberately a regex over the root element rather than an SVG parser:
 * the only numbers wanted are the ones an author writes on `<svg>` itself, and
 * pulling in a real parser (with its entity and namespace handling) to read two
 * attributes would be a poor trade.
 */

/** Raised when SVG text cannot be understood well enough to place a costume. */
export class SvgError extends Error {
  constructor (message) {
    super(message)
    this.name = 'SvgError'
  }
}

/**
 * Isolate the opening `<svg …>` tag.
 *
 * Attribute reads must not see the rest of the document: a nested
 * `<rect width="10">` would otherwise be mistaken for the artwork's size. The tag
 * ends at the first `>`, which is safe because SVG attribute values in practice do
 * not contain a bare `>`.
 *
 * @param {string} source SVG text
 * @returns {string} the opening tag, or an empty string when there is none
 */
const rootTag = (source) => {
  const start = source.search(/<svg[\s>]/i)
  if (start === -1) return ''
  const end = source.indexOf('>', start)
  return end === -1 ? source.slice(start) : source.slice(start, end + 1)
}

/**
 * Read a numeric attribute from the root tag.
 * @param {string} tag the opening `<svg …>` tag
 * @param {string} attribute attribute name
 * @returns {number|null} the value, or null when absent, a percentage, or unparsable
 */
const numericAttribute = (tag, attribute) => {
  const match = new RegExp(`${attribute}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)
  if (match === null) return null
  const raw = match[1].trim()
  // A percentage has no intrinsic extent; reading "100%" as 100 would misplace
  // the rotation centre.
  if (raw.includes('%')) return null
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Determine the intrinsic size of an SVG.
 *
 * Prefers `width`/`height`; falls back to the `viewBox` extent.
 *
 * @param {string} source SVG text
 * @returns {{width: number, height: number}|null} the size, or null when unknown
 */
export const svgSize = (source) => {
  if (typeof source !== 'string' || source.length === 0) return null
  const tag = rootTag(source)
  if (tag === '') return null

  const rawWidth = numericAttribute(tag, 'width')
  const rawHeight = numericAttribute(tag, 'height')
  if (rawWidth !== null && rawHeight !== null && rawWidth > 0 && rawHeight > 0) {
    return { width: rawWidth, height: rawHeight }
  }

  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(tag)
  if (viewBox !== null) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number)
    if (parts.length === 4 && parts.every((value) => Number.isFinite(value)) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] }
    }
  }

  return null
}

/**
 * Suggest a rotation centre for a costume: the middle of the artwork, or (0, 0)
 * when the size cannot be determined (which is Scratch's own default).
 *
 * @param {string} source SVG text
 * @returns {{x: number, y: number, derived: boolean}} the suggested centre
 */
export const defaultRotationCenter = (source) => {
  const size = svgSize(source)
  if (size === null) return { x: 0, y: 0, derived: false }
  return { x: size.width / 2, y: size.height / 2, derived: true }
}

/**
 * Cheap structural sanity check before handing SVG text to the editor, so a
 * malformed costume fails here with a clear message instead of appearing as an
 * invisible sprite.
 *
 * @param {string} source candidate SVG text
 * @throws {SvgError} when the text is not recognisable as an SVG document
 */
export const assertLooksLikeSvg = (source) => {
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new SvgError('the costume data is empty')
  }
  if (!/<svg[\s>]/i.test(source)) {
    throw new SvgError('the costume data does not contain an <svg> element; pass SVG markup, or use dataFormat/base64 for a bitmap')
  }
  if (!/<\/svg>\s*$/i.test(source.trim())) {
    throw new SvgError('the SVG is not closed with </svg>; a truncated document renders as nothing')
  }
}
