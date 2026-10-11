/**
 * Extensions: the block categories a project adds from Gandi's 添加扩展 library.
 *
 * An extension is not a property of the project document. Its blocks only exist once
 * the extension has been loaded into the running VM, and until then there is nothing to
 * write: the opcode, the input names and the dropdown shadow of every extension block
 * are facts that live in `runtime._blockInfo` and nowhere else. That is why this module
 * reads the editor instead of shipping a table — the same reason `menus.mjs` is
 * generated from a flyout dump rather than typed out by hand.
 *
 * Measured on Gandi 1.0.5 (`docs/gandi-spike.md` §21):
 *
 *   - `vm.extensionManager.loadExtensionURL(id)` loads BOTH kinds: a built-in one
 *     (`isBuiltinExtension(id)`, 13 of them: pen, videoSensing, text2speech, tw, …) and
 *     a Gandi-library one, whose bundle URL it asks its own API for through
 *     `runtime.ccwAPI.getExtensionURLById(id)`. An unknown id rejects, which is the
 *     only honest way to answer "can this editor load what you asked for".
 *   - `runtime._blockInfo` gains one entry per loaded extension: `{id, name, color1,
 *     blocks, menus}`. Each block carries `info.opcode` WITHOUT the id prefix — the
 *     prefix is added when the block is registered (`music` + `restForBeats` becomes
 *     `music_restForBeats` in the project document), so the plugin has to add it too.
 *   - each block's `info.arguments` is an OBJECT keyed by argument name, not an array,
 *     and an argument that is a dropdown names its menu in `menu`. The shadow opcode is
 *     `<extensionId>_menu_<menuName>` — for `music` that is `music_menu_DRUM`, verified
 *     by writing one and reading the editor's own archive back.
 *   - a project whose blocks name an extension loads that extension by itself, from the
 *     opcode prefix alone; the document's `extensions` array is a record, not the
 *     trigger. It is still written, because every other Scratch tool reads it.
 *   - **loading a device-backed extension opens that device.** Not using its blocks —
 *     loading it. A sweep of the whole library (89 ids) left the camera on with nothing
 *     to close it, so `loadExtension` now stops and reports any live media track, and the
 *     catalogue marks the ids that look device-backed. The whole library was measured
 *     otherwise sound: 88 of 89 load and expose readable block info (the exception,
 *     `whiteBoard`, fails inside the editor itself — a user clicking 添加扩展 gets the
 *     same error). See `docs/gandi-spike.md` §21.
 */

import { evaluate } from './cdp.mjs'
import { vmBootstrapSource } from './gandi-vm.mjs'

/**
 * Page source: everything the plugin needs to know about extensions in this editor.
 *
 * Declares `extensionFacts()` and `loadExtension(id)`. Both are plain functions so the
 * callers can decide what to do with the result; nothing here mutates the project.
 *
 * NOTE: page source is a template literal. No backticks in the comments.
 */
const EXTENSION_SOURCE = `
    const extensionManagerOf = () => vm.extensionManager || vm.runtime.extensionManager || null

    // One menu entry -> the shadow the editor expects under the input.
    //
    // The menu's own name is the key it was declared under in the extension's
    // getInfo().menus, and the block type the editor generates from it is
    // "<extensionId>_menu_<name>" — but the generated block JSON carries that type in
    // its own "type" field, so that is read first and the constructed form is only a
    // fallback. Measured on Gandi 1.0.5: reading the type off the entry is what gets
    // "music_menu_DRUM" right; guessing from a missing name produced "music_menu_".
    const menuIdOf = (extensionId, menu) => {
      const json = menu && menu.json !== undefined ? menu.json : null
      if (json !== null && typeof json === 'object' && typeof json.type === 'string' && json.type.length > 0) {
        return json.type
      }
      const name = menu && typeof menu.name === 'string' && menu.name.length > 0
        ? menu.name
        : (menu && typeof menu.id === 'string' && menu.id.length > 0 ? menu.id : null)
      return extensionId + '_menu_' + String(name === null ? '' : name)
    }

    const menuShapeOf = (extensionId, menu) => {
      const json = menu && menu.json !== undefined ? menu.json : null
      let args = []
      let message0 = null
      if (json !== null && typeof json === 'object') {
        message0 = typeof json.message0 === 'string' ? json.message0 : null
        args = Array.isArray(json.args0) ? json.args0 : []
      }
      const dropdown = args.find((a) => a && (a.type === 'field_dropdown' || a.type === 'field_input')) || null
      const options = dropdown !== null && Array.isArray(dropdown.options) ? dropdown.options : []
      return {
        shadow: menuIdOf(extensionId, menu),
        name: menu && typeof menu.name === 'string' ? menu.name : null,
        field: dropdown === null ? null : (dropdown.name || null),
        firstOption: options.length > 0 && Array.isArray(options[0]) ? String(options[0][0]) : null,
        optionCount: options.length,
        message0,
        argTypes: args.map((a) => (a && a.type) || null)
      }
    }

    const describeBlock = (extensionId, info) => {
      const args = Object.entries(info.arguments || {}).map(([name, spec]) => {
        const menuName = spec && typeof spec.menu === 'string' && spec.menu.length > 0 ? spec.menu : null
        return {
          name,
          type: (spec && spec.type) || null,
          menu: menuName,
          shadow: menuName === null ? null : extensionId + '_menu_' + menuName,
          defaultValue: spec && spec.defaultValue !== undefined ? spec.defaultValue : null
        }
      })
      const menuInputs = {}
      for (const arg of args) if (arg.shadow !== null) menuInputs[arg.name] = arg.shadow
      // Statement inputs are declared by the block's own text, not by its blockType:
      // a loop's text reads "%1 {SUBSTACK} %2" and a conditional's reads
      // "%1 {SUBSTACK} %2 {SUBSTACK2} %3". Guessing them from blockType would be a
      // guess; this is what the editor itself renders.
      const text = typeof info.text === 'string' ? info.text : ''
      const statementInputs = ['SUBSTACK', 'SUBSTACK2'].filter((name) => text.includes('{' + name + '}'))
      return {
        // The opcode as it lands in the project document: extension id, then the
        // extension's own opcode. runtime._blockInfo holds the bare one.
        opcode: extensionId + '_' + String(info.opcode),
        bareOpcode: String(info.opcode),
        blockType: info.blockType || null,
        text: text.length === 0 ? null : text,
        arguments: args,
        valueInputs: args.map((a) => a.name),
        statementInputs,
        menuInputs,
        menuShadows: Object.values(menuInputs),
        fields: args.map((a) => a.name),
        color1: info.color1 || null
      }
    }

    const describeExtension = (entry) => {
      const extensionId = String(entry.id)
      const menus = {}
      for (const menu of entry.menus || []) {
        const shape = menuShapeOf(extensionId, menu)
        menus[shape.shadow] = shape
      }
      // Gandi's own pen extension registers one entry whose opcode is literally
      // undefined ("Stage selected: less pen blocks"). It cannot be written as a block,
      // so it is not part of the dialect — a "<block type="pen_undefined">" would be a
      // block type no editor knows.
      const raw = (entry.blocks || []).filter((b) => b && b.info && typeof b.info.opcode === 'string' && b.info.opcode.length > 0)
      const skipped = (entry.blocks || []).length - raw.length
      const blocks = raw.map((b) => describeBlock(extensionId, b.info))
      // A menu argument names a menu; if that menu is not among the declared ones, the
      // shadow type is still the documented form, so keep the guess and say it is one.
      for (const block of blocks) {
        for (const [input, shadow] of Object.entries(block.menuInputs)) {
          if (menus[shadow] === undefined) {
            menus[shadow] = {
              shadow,
              name: null,
              field: null,
              firstOption: null,
              optionCount: 0,
              message0: null,
              argTypes: null,
              guessed: true,
              forInput: input,
              forOpcode: block.opcode
            }
          }
        }
      }
      return {
        id: extensionId,
        name: entry.name === undefined ? null : String(entry.name),
        color1: entry.color1 === undefined ? null : String(entry.color1),
        blockCount: blocks.length,
        skippedBlocks: skipped,
        blocks,
        menus: Object.values(menus)
      }
    }

    // The catalogue the 添加扩展 button shows. It carries no bundle URL (the manager
    // asks its own API for that), but the ids are exactly what loadExtension accepts,
    // and asking is what turns "unknown extension" into a list of the real ones.
    //
    // One extra fact is derived here rather than read: whether the extension looks
    // DEVICE-backed (camera or microphone). Gandi's metadata does not say, and the answer
    // matters before loading — loading one opens the device. The test is on the id and
    // the name key, deliberately narrow so it cannot mark half the library.
    const DEVICE_BACKED = /kamera|camera|face|video|recording|media|spine|dolly|pocket|voice|mic/i
    const catalogueOf = (manager) => {
      const rows = []
      const push = (map, kind) => {
        for (const [key, entry] of Object.entries(map || {})) {
          const info = entry && entry.info !== undefined ? entry.info : entry
          const inner = info && info.info !== undefined ? info.info : info
          const id = String((inner && inner.extensionId) || key)
          const nameKey = inner && inner.name !== undefined ? String(inner.name) : null
          rows.push({
            id,
            key,
            kind,
            nameKey,
            disabled: inner && inner.disabled === true,
            featured: inner && inner.featured === true,
            deviceBacked: DEVICE_BACKED.test(id) || (nameKey !== null && DEVICE_BACKED.test(nameKey))
          })
        }
      }
      push(manager._officialExtensionInfo, 'official')
      push(manager._customExtensionInfo, 'custom')
      return rows
    }

    const extensionFacts = () => {
      const manager = extensionManagerOf()
      if (manager === null) {
        return { available: false, reason: 'this editor has no extension manager' }
      }
      const loaded = (vm.runtime._blockInfo || []).map(describeExtension)
      const loadedIds = loaded.map((e) => e.id)
      const builtinIds = Object.keys(manager.builtinExtensions || {})
      const catalogue = catalogueOf(manager)
      return {
        available: true,
        loaded,
        loadedIds,
        builtinIds,
        catalogue,
        catalogueIds: catalogue.map((row) => row.id)
      }
    }

    // A few extensions are backed by a DEVICE: the camera or the microphone. Loading one
    // of them is enough to make the editor open that device — the user gets the camera
    // light and the OS "in use" record, and nothing in the editor or this plugin ever
    // closes it again. Measured, the hard way: a batch load of the whole library left the
    // user's camera on (Windows recorded lastUsedStop=0 for Gandi.exe only).
    //
    // So loading is followed by a sweep for live media tracks, which are stopped and
    // reported. That is the one thing here that changes device state, and it changes it
    // back; the report is what lets a caller say out loud what happened.
    const openMediaDevices = () => {
      const tracks = []
      const seen = new Set()
      const inspect = (value, where, depth) => {
        if (value === null || value === undefined || depth > 6 || typeof value !== 'object') return
        if (seen.has(value)) return
        seen.add(value)
        let stream = null
        try { stream = typeof value.getTracks === 'function' ? value : null } catch (error) { stream = null }
        if (stream !== null) {
          for (const track of stream.getTracks()) {
            let label = ''
            try { label = String(track.label || '') } catch (error) { label = '' }
            tracks.push({ where, kind: track.kind, readyState: track.readyState, label })
            try { track.stop() } catch (error) { /* already stopped */ }
          }
          return
        }
        let keys = []
        try { keys = Object.keys(value) } catch (error) { return }
        for (const key of keys.slice(0, 80)) {
          let child = null
          try { child = value[key] } catch (error) { continue }
          if (typeof child === 'function') continue
          inspect(child, where + '.' + key, depth + 1)
        }
      }
      const manager = extensionManagerOf()
      inspect(manager === null ? null : manager._gandiExternalExtensionServices, 'services', 0)
      inspect(vm.runtime.gandi, 'runtime.gandi', 0)
      return tracks
    }

    // Load one extension by id. Idempotent: an extension that is already loaded is left
    // alone and reported as such. Returns the same shape extensionFacts gives for that
    // one extension, so a caller never has to ask twice.
    const loadExtension = async (extensionId) => {
      const manager = extensionManagerOf()
      if (manager === null) throw new Error('this editor has no extension manager')
      const before = (vm.runtime._blockInfo || []).map((e) => String(e.id))
      const alreadyLoaded = before.includes(extensionId)
      if (alreadyLoaded) {
        const entry = (vm.runtime._blockInfo || []).find((e) => String(e.id) === extensionId)
        return { id: extensionId, alreadyLoaded: true, ms: 0, extension: describeExtension(entry), loadedIds: before, mediaStopped: [] }
      }
      const started = Date.now()
      let failure = null
      try {
        await manager.loadExtensionURL(extensionId)
      } catch (error) {
        failure = error
      }
      const after = (vm.runtime._blockInfo || []).map((e) => String(e.id))
      const entry = (vm.runtime._blockInfo || []).find((e) => String(e.id) === extensionId)
      // Sweep even on failure: an extension that gets half-way can still have opened the
      // camera before it threw.
      const mediaStopped = openMediaDevices()
      if (failure !== null) {
        // Keep the editor's own words (they are the evidence) but say what they mean:
        // a rejection either means the id is not one this editor offers, or that the
        // extension itself failed to load — a library entry that is simply broken in
        // THIS editor fails the same way for a user clicking 添加扩展.
        const raw = String(failure && failure.message ? failure.message : failure)
        const explain = /Extension not found/i.test(raw)
          ? 'This editor does not offer that id. Ask for the catalogue (gandi_extension action list) and pass an id from it.'
          : 'The extension exists in this editor\\'s library but the editor failed to load it. Nothing the plugin can do makes it load: a user clicking 添加扩展 gets the same failure.'
        throw new Error('could not load the extension "' + extensionId + '": ' + raw + '\\n' + explain)
      }
      if (entry === undefined) {
        throw new Error('the editor loaded "' + extensionId + '" but registered no blocks for it' +
          ' (block info now holds: ' + after.join(', ') + ')')
      }
      return {
        id: extensionId,
        alreadyLoaded: false,
        ms: Date.now() - started,
        extension: describeExtension(entry),
        loadedIds: after,
        mediaStopped
      }
    }
`

/**
 * @typedef {object} ExtensionDialect
 * @property {string} id
 * @property {string|null} name
 * @property {{opcode: string, valueInputs: string[], statementInputs: string[], menuInputs: Record<string, string>, menuShadows: string[], fields: string[]}[]} blocks
 * @property {{shadow: string, field: string|null}[]} menus
 */

/**
 * @typedef {object} ExtensionFacts
 * @property {boolean} available
 * @property {string} [reason]
 * @property {ExtensionDialect[]} [loaded]
 * @property {string[]} [loadedIds]
 * @property {string[]} [builtinIds]
 * @property {{id: string, kind: string, disabled: boolean}[]} [catalogue]
 * @property {string[]} [catalogueIds]
 */

/**
 * Ask the editor what extensions it has, what it can load, and what each loaded one's
 * blocks look like.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @returns {Promise<ExtensionFacts>} the facts
 * @throws {import('./cdp.mjs').CdpError} when the editor cannot be reached
 */
export async function extensionFacts (connection) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n${vmBootstrapSource()}${EXTENSION_SOURCE}
    return extensionFacts()
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}

/**
 * Load one extension into the running editor.
 *
 * Loading is not just a convenience: until it happens the extension's blocks do not
 * exist in this VM, so `createBlock` would produce a block the editor cannot render and
 * the toolbox would not offer it. The load is the editor's own — the same call the
 * 添加扩展 button makes — so nothing here bypasses Gandi's policy about what may load.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {string} extensionId extension id, e.g. "music" or "pen"
 * @returns {Promise<{id: string, alreadyLoaded: boolean, ms: number, extension: ExtensionDialect, loadedIds: string[], mediaStopped: {kind: string, label: string}[]}>} what happened
 * @throws {import('./cdp.mjs').CdpError} when the editor refuses the id
 */
export async function loadExtension (connection, extensionId) {
  const raw = await evaluate(connection, `(async () => {\n${vmBootstrapSource()}${EXTENSION_SOURCE}
    return JSON.stringify(await loadExtension(${JSON.stringify(extensionId)}))
  })()`, { awaitPromise: true, timeoutMs: 120000 })
  return JSON.parse(raw)
}

/**
 * A readable list of what this editor can load, marked with what is already loaded.
 *
 * The catalogue is the editor's own — 93 entries on Gandi 1.0.5, Scratch's official ones
 * plus Gandi's and the community's. It is deliberately not filtered to "safe" ids: the
 * plugin has no business deciding which of Gandi's extensions a project may use.
 *
 * @param {ExtensionFacts} facts what the editor said
 * @param {{filter?: string, limit?: number}} [options] how to present it
 * @returns {string} the listing
 */
export const formatExtensionCatalogue = (facts, options = {}) => {
  if (facts.available !== true) {
    return `extensions: unavailable — ${facts.reason ?? 'the editor did not answer'}`
  }
  const filter = typeof options.filter === 'string' && options.filter.length > 0
    ? options.filter.toLowerCase()
    : null
  const loaded = new Set(facts.loadedIds ?? [])
  const rows = (facts.catalogue ?? []).filter((row) =>
    (filter === null || row.id.toLowerCase().includes(filter) || String(row.kind).includes(filter)) && row.disabled !== true)
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200
  const shown = rows.slice(0, limit)
  const deviceBacked = rows.filter((row) => row.deviceBacked === true).map((row) => row.id)
  const lines = [
    `loaded extensions: ${(facts.loadedIds ?? []).length === 0 ? 'none' : facts.loadedIds.join(', ')}`,
    `built into this editor (loadable offline, no download): ${(facts.builtinIds ?? []).join(', ')}`,
    `library: ${rows.length} extension(s)${filter === null ? '' : ` matching "${options.filter}"`}${rows.length > shown.length ? `, first ${shown.length}` : ''}`
  ]
  for (const row of shown) {
    lines.push(`  ${loaded.has(row.id) ? '*' : ' '} ${row.id}${row.id === row.nameKey || row.nameKey === null ? '' : ` (${row.nameKey})`}${row.featured === true ? ' [featured]' : ''}${row.deviceBacked === true ? ' [uses a device]' : ''}`)
  }
  if (rows.length === 0) lines.push('  (nothing matched)')
  if (deviceBacked.length > 0 && filter === null) {
    lines.push('', `[uses a device] = loading it opens your camera or microphone (the editor does this itself, and it stays open` +
      ` until it is stopped — the load result says what was stopped): ${deviceBacked.slice(0, 14).join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * A readable description of one loaded extension's dialect: exactly what an author has
 * to write, taken from the editor rather than from documentation.
 *
 * @param {ExtensionDialect} extension a loaded extension
 * @returns {string} the description
 */
export const formatExtensionDialect = (extension) => {
  const lines = [`${extension.id}${extension.name === null || extension.name === extension.id ? '' : ` (${extension.name})`} — ${extension.blocks.length} block(s)`]
  for (const block of extension.blocks) {
    lines.push(`  <block type="${block.opcode}">`)
    if (block.valueInputs.length > 0) {
      lines.push(`    inputs: ${block.valueInputs.map((name) => {
        const shadow = block.menuInputs?.[name]
        if (shadow === undefined) return name
        // The FIELD name matters as much as the shadow type, and it is not always the
        // input name — so it is printed here, where the author is reading the input.
        const shape = (extension.menus ?? []).find((menu) => menu.shadow === shadow)
        const field = shape === undefined || shape.field === null ? '?' : shape.field
        return `${name} (dropdown <shadow type="${shadow}"><field name="${field}">)`
      }).join(', ')}`)
    }
    if (block.statementInputs.length > 0) lines.push(`    statement inputs: ${block.statementInputs.join(', ')}`)
    if (block.text !== null && Object.keys(block.menuInputs ?? {}).length === 0 && block.valueInputs.length === 0) {
      lines.push(`    shape: ${block.text}`)
    }
  }
  // The menus themselves: the value an author has to put in the dropdown field. Without
  // this the dialect says which shadow to write but not what to put in it, and the
  // dropdown then reads its first option — a silent wrong value.
  const menus = (extension.menus ?? []).filter((menu) => menu.guessed !== true)
  if (menus.length > 0) {
    lines.push('  menus:')
    for (const menu of menus) {
      const sample = menu.firstOption === null || menu.firstOption === undefined
        ? (menu.optionCount > 0 ? `${menu.optionCount} option(s)` : 'options come from the project or the editor, not from the extension')
        : `e.g. "${menu.firstOption}"${menu.optionCount > 1 ? ` (${menu.optionCount} options)` : ''}`
      lines.push(`    <shadow type="${menu.shadow}"><field name="${menu.field ?? '?'}"> — ${sample}`)
    }
  }
  const guessed = (extension.menus ?? []).filter((menu) => menu.guessed === true)
  if (guessed.length > 0) {
    lines.push(`  (${guessed.length} menu(s) whose field name the editor did not declare: ` +
      `${guessed.map((menu) => menu.shadow).join(', ')} — the shadow type is right, read the field name off gandi_inspect of a script that already uses the block)`)
  }
  return lines.join('\n')
}
