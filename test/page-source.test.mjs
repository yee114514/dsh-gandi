import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The bridge talks to the editor by sending JavaScript source as a string, so
 * `src/bridge/ops.mjs` and friends are full of large template literals holding page
 * code. A backtick inside one of those — even inside a `//` comment — closes the
 * literal early and produces a confusing "missing ) after argument list" tens of
 * lines away. That happened twice while writing this plugin, so it is a test now.
 */

const root = fileURLToPath(new URL('..', import.meta.url))

/** Every .mjs file under a directory, recursively. */
const sourceFiles = (directory) => {
  const found = []
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path))
    else if (entry.endsWith('.mjs')) found.push(path)
  }
  return found
}

test('no page-source template literal contains a backtick in a comment', () => {
  const offenders = []

  // tools/ too: the probe and cleanup scripts embed page source the same way, and
  // a violation there is just as hard to read as one in src/. (This happened three
  // times while building the plugin, which is why the guard covers both.)
  for (const directory of ['src', 'tools']) {
    for (const file of sourceFiles(join(root, directory))) {
      const lines = readFileSync(file, 'utf8').split('\n')
      let insideTemplate = false
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]
        const ticks = (line.match(/`/g) ?? []).length
        const hadOddTicks = ticks % 2 === 1
        // Toggling on odd counts is exact for this codebase: it uses no nested
        // template literals and no escaped backticks inside page source.
        if (hadOddTicks) insideTemplate = !insideTemplate
        if (!insideTemplate && !hadOddTicks) continue
        if (insideTemplate && line.includes('`') && line.includes('//')) {
          offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`)
        }
      }
    }
  }

  assert.deepEqual(offenders, [], `backtick inside a comment in a page-source template:\n${offenders.join('\n')}`)
})

test('every plugin source file is importable', async () => {
  // A syntax error in a page-source template only shows up when the module is
  // imported, which for a plugin means at DSH start-up. Ask for it here instead.
  //
  // Deliberately only src/: importing a tools/ script EXECUTES it (they are
  // top-level programs that attach to a live editor), which is not something a unit
  // test may do. The backtick guard above is static and does cover tools/.
  for (const file of sourceFiles(join(root, 'src'))) {
    const url = new URL(`file://${file.replace(/\\/g, '/')}`)
    await assert.doesNotReject(
      () => import(url.href),
      `${relative(root, file)} must be importable`
    )
  }
})

/** Longest match first: a template literal can start with any of these. */
const TEMPLATE_STARTS = ['`', "'", '"', '//', '/*']

/**
 * Resolve the backslash escapes of a template-literal body.
 *
 * The body is still source text, so `\n` is two characters here and a newline on the
 * page. Only the escapes that appear in page source are handled, and real control
 * characters are blanked because they cannot survive a JSON round trip.
 *
 * @param {string} text a template-literal body
 * @returns {string} the text as the page would see it
 */
const resolveEscapes = (text) => {
  const SIMPLE = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }
  let escaped = ''
  let index = 0
  while (index < text.length) {
    const character = text[index]
    if (character !== '\\') {
      escaped += character
      index++
      continue
    }
    const next = text[index + 1]
    if (next === undefined) {
      escaped += '\\\\'
      break
    }
    if (next === 'u') {
      const hex = text.slice(index + 2, index + 6)
      escaped += `\\u${hex}`
      index += 6
      continue
    }
    if (next === 'x') {
      escaped += `\\x${text.slice(index + 2, index + 4)}`
      index += 4
      continue
    }
    if (SIMPLE[next] !== undefined) {
      escaped += SIMPLE[next]
      index += 2
      continue
    }
    // Includes \\ and \' and \" and \` — all of which mean the bare character.
    escaped += next
    index += 2
  }
  // eslint-disable-next-line no-control-regex
  return escaped.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
}

/**
 * Find the end of a JavaScript string literal that starts at `start`.
 *
 * @param {string} source the whole file
 * @param {number} start index of the opening quote
 * @returns {number} index just past the closing quote
 */
const endOfString = (source, start) => {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2
      continue
    }
    if (source[index] === quote) return index + 1
    index++
  }
  return source.length
}

/**
 * Find the end of a template literal that starts at `start`.
 *
 * Backticks inside `${...}` belong to nested literals and must not end this one, and
 * `${...}` can itself contain braces, strings and comments — so the interpolation is
 * skipped with {@link skipInterpolation} rather than by counting braces blindly.
 *
 * @param {string} source the whole file
 * @param {number} start index of the opening backtick
 * @returns {number} index just past the closing backtick
 */
const endOfTemplate = (source, start) => {
  let index = start + 1
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '`') return index + 1
    if (character === '$' && source[index + 1] === '{') {
      index = skipInterpolation(source, index + 2)
      continue
    }
    index++
  }
  return source.length
}

/**
 * Skip a `${ ... }` interpolation whose body starts at `start`.
 * @param {string} source the whole file
 * @param {number} start index just past `${`
 * @returns {number} index just past the matching `}`
 */
const skipInterpolation = (source, start) => {
  let index = start
  let braces = 1
  while (index < source.length && braces > 0) {
    const next = TEMPLATE_STARTS.find((token) => source.startsWith(token, index))
    if (next === '`') {
      index = endOfTemplate(source, index)
      continue
    }
    if (next === "'" || next === '"') {
      index = endOfString(source, index)
      continue
    }
    if (next === '//') {
      index = source.indexOf('\n', index)
      if (index === -1) return source.length
      continue
    }
    if (next === '/*') {
      const close = source.indexOf('*/', index + 2)
      index = close === -1 ? source.length : close + 2
      continue
    }
    if (source[index] === '{') braces++
    else if (source[index] === '}') braces--
    index++
  }
  return index
}

/**
 * Split a module into the bodies of its template literals.
 *
 * Scanned rather than pattern-matched: the module is ordinary JavaScript, and a
 * half-correct scanner would silently check the wrong spans — which is exactly the
 * failure mode this test exists to prevent.
 *
 * @param {string} source a whole module
 * @param {string} file path, for messages
 * @returns {{line: number, text: string}[]} one entry per template literal
 */
const templateBodies = (source, file) => {
  const found = []
  let index = 0
  while (index < source.length) {
    const next = TEMPLATE_STARTS.find((token) => source.startsWith(token, index))
    if (next === undefined) {
      index++
      continue
    }
    if (next === '`') {
      const end = endOfTemplate(source, index)
      // Replace interpolations with `undefined` before handing the body to a parser:
      // what an author types is the skeleton, and the inserted helpers are checked by
      // the same rule where they are defined. `undefined` is valid both as an
      // expression (`f(${x})`) and as a statement (`${BOOTSTRAP}` on its own line).
      const raw = source.slice(index + 1, end - 1)
      let body = ''
      let cursor = 0
      while (cursor < raw.length) {
        if (raw[cursor] === '\\') {
          body += raw.slice(cursor, cursor + 2)
          cursor += 2
          continue
        }
        if (raw[cursor] === '$' && raw[cursor + 1] === '{') {
          cursor = skipInterpolation(raw, cursor + 2)
          body += 'undefined'
          continue
        }
        body += raw[cursor]
        cursor++
      }
      found.push({
        file,
        line: source.slice(0, index).split('\n').length,
        text: body
      })
      index = end
      continue
    }
    if (next === '//') {
      const newline = source.indexOf('\n', index)
      index = newline === -1 ? source.length : newline + 1
      continue
    }
    if (next === '/*') {
      const close = source.indexOf('*/', index + 2)
      index = close === -1 ? source.length : close + 2
      continue
    }
    index = endOfString(source, index)
  }
  return found
}

test('every page source is syntactically valid JavaScript', () => {
  // The plugin ships page code as strings, so nothing else parses it: a typo there is
  // not caught by importing the module, and only shows up when a real editor is driven
  // — where it costs a whole debugging session. `new Function` parses without running,
  // which is exactly the check wanted.
  //
  // Interpolations are replaced with `undefined`, so what is verified is the literal
  // skeleton: the parts an author types. That is where this class of bug lives. (The
  // first version of the Gandi port shipped a page source with `const vm` declared
  // twice, and only the live end-to-end run found it.)
  const failures = []
  let checked = 0
  for (const file of sourceFiles(join(root, 'src')).concat(sourceFiles(join(root, 'tools')))) {
    const source = readFileSync(file, 'utf8')
    for (const { line, text } of templateBodies(source, file)) {
      // Only page sources. Prose (JSDoc, tool descriptions) is full of tokens that no
      // JavaScript parser accepts, and checking it would only produce noise.
      if (!/^\s*(\(\s*\)\s*=>|\(async\s*\(\)\s*=>|JSON\.stringify|new Promise|const vm =|\(\(\) =>)/.test(text)) continue
      checked++
      try {
        // eslint-disable-next-line no-new-func
        new Function(resolveEscapes(text))
      } catch (error) {
        failures.push(`${relative(root, file)}:${line}: ${error.message}`)
      }
    }
  }
  assert.ok(checked > 10, `expected to check many page sources, checked ${checked}`)
  assert.deepEqual(failures, [], `page source that does not parse:\n${failures.join('\n')}`)
})
