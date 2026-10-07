/**
 * Pre-flight checks for a project document — "will the editor open this?".
 *
 * The failures this exists for are not compile failures. Each of them produces a file
 * that looks completely normal until the editor tries to read it, and then the error
 * names something else entirely:
 *
 *   - a block whose opcode is not a Scratch opcode is read as an EXTENSION block
 *     (`sb3.js` takes `opcode.split('_')[0]` as the extension id), so an invented
 *     `broadcast_msg` block makes the whole project fail with
 *     `Extension not found: broadcast` — nothing in that message points at the block;
 *   - a `procedures_call` mutation that is missing `children` makes scratch-blocks
 *     throw `Cannot read properties of undefined (reading 'length')` while rendering
 *     the workspace, which likewise says nothing about which block is at fault;
 *   - a field naming a variable that the target does not declare renders as an
 *     unresolved reporter — the project opens, and the script silently does nothing.
 *     A merge that copies `blocks` without `variables` produces these by the hundred.
 *
 * Everything here is offline: it reads a parsed `project.json` and its assets, so it
 * works with no editor at all. `gandi_verify {live: true}` adds the one check that no
 * amount of reading can replace — actually handing the file to the editor's own
 * deserializer.
 */

import { CORE_OPCODES, MENU_SHADOWS } from './menus.mjs'
import { PRIMITIVES_BY_CONSTANT } from './primitives.mjs'
import { collectScript } from './project.mjs'

/**
 * Opcode prefixes that belong to Scratch itself. The deserializer uses the prefix
 * before the first underscore to decide whether a block is an extension block, so this
 * list is the editor's own rule rather than a guess about its block set.
 */
const CORE_PREFIXES = new Set([
  'motion', 'looks', 'sound', 'event', 'control', 'sensing', 'operator',
  'data', 'procedures', 'argument', 'math', 'colour', 'text'
])

/**
 * Extensions Gandi can load on demand. A block from one of these is fine even when the
 * project does not list it — the deserializer calls `loadExtensionIdSync` and gets it.
 * Anything else is either a typo or an extension this project would have to declare.
 */
const BUILT_IN_EXTENSIONS = new Set([
  'music', 'pen', 'video', 'text2speech', 'translate', 'makeymakey', 'microbit',
  'ev3', 'boost', 'gdxfor', 'speech', 'gandi', 'ccw', 'tw', 'pm', 'files', 'cloud'
])

/** Field names that carry a variable, list or broadcast id in their `id` slot. */
const REFERENCE_FIELDS = new Set(['VARIABLE', 'LIST', 'BROADCAST_OPTION'])

/**
 * Primitive constants whose third slot is the id of something that must be declared:
 * 11 broadcast, 12 variable, 13 list (`primitives.mjs`, from `sb3.js`).
 */
const REFERENCE_PRIMITIVES = new Set([11, 12, 13])

/**
 * @typedef {object} VerifyReport
 * @property {string[]} errors problems that stop the project from working
 * @property {string[]} warnings things that are almost certainly mistakes
 * @property {string[]} notes informational findings
 * @property {{targets: number, sprites: number, blocks: number, scripts: number, assets: number}} stats
 */

/** An empty report, for callers that only want the findings. */
export const emptyReport = () => ({ errors: [], warnings: [], notes: [], stats: { targets: 0, sprites: 0, blocks: 0, scripts: 0, assets: 0 } })

/**
 * The opcode a block's extension id would be read from, or null when it is core.
 * @param {string} opcode block opcode
 * @returns {string|null} the extension id the deserializer would try to load
 */
const extensionPrefix = (opcode) => {
  const prefix = String(opcode).split('_')[0]
  return CORE_PREFIXES.has(prefix) ? null : prefix
}

/**
 * Check one block's mutation against the shape the editor reads.
 * @param {string} id block id, for the message
 * @param {any} block the block record
 * @param {string[]} errors collector
 */
const checkMutation = (id, block, errors) => {
  const mutation = block.mutation
  if (mutation === undefined || mutation === null) {
    if (block.opcode === 'procedures_call' || block.opcode === 'procedures_prototype' || block.opcode === 'procedures_definition') {
      errors.push(`${block.opcode} block ${id} has no mutation, so the editor cannot tell which custom block it is`)
    }
    return
  }
  if (typeof mutation !== 'object') {
    errors.push(`${block.opcode} block ${id}: mutation is ${typeof mutation}, not an object`)
    return
  }
  const isProcedure = block.opcode === 'procedures_call' || block.opcode === 'procedures_prototype' || block.opcode === 'procedures_definition'
  if (!isProcedure) return
  if (typeof mutation.proccode !== 'string' || mutation.proccode.length === 0) {
    errors.push(`${block.opcode} block ${id}: mutation has no proccode`)
  }
  // `scratch-blocks` walks mutation.children while rendering the workspace. A mutation
  // that never had it — which is what a hand-written cross-fragment call looks like —
  // throws `Cannot read properties of undefined (reading 'length')` and the project
  // does not open.
  if (!Array.isArray(mutation.children)) {
    errors.push(`${block.opcode} block ${id} ("${mutation.proccode ?? '?'}"): mutation.children is missing or not an array; ` +
      'the editor reads it while rendering and throws on anything else')
  }
  if (mutation.tagName !== undefined && mutation.tagName !== 'mutation') {
    errors.push(`${block.opcode} block ${id}: mutation.tagName is "${mutation.tagName}", not "mutation"`)
  }
  if (mutation.warp !== undefined && mutation.warp !== 'true' && mutation.warp !== 'false' && typeof mutation.warp !== 'boolean') {
    errors.push(`${block.opcode} block ${id}: mutation.warp is ${JSON.stringify(mutation.warp)}; it must be "true" or "false"`)
  }
}

/**
 * Check the shadow behind one input.
 *
 * This is the file-level twin of the compiler's check, and it exists because the files
 * that need it are the ones no compiler produced — a merge script, a patch script, a
 * project written by an older version of this plugin.
 *
 * @param {{id: string, block: any, inputName: string, wire: any, blocks: Record<string, any>, errors: string[], warnings: string[]}} request the input to check
 */
const checkInput = ({ id, block, inputName, wire, blocks, errors, warnings }) => {
  if (!CORE_OPCODES.has(block.opcode)) return
  const expected = MENU_SHADOWS[block.opcode]?.[inputName]
  if (expected === undefined) return

  const reference = Array.isArray(wire) ? wire[1] : undefined
  const tag = Array.isArray(wire) ? wire[0] : undefined

  // A primitive inlined in place of the dropdown: the runtime will look the option up
  // in a value that is not a menu, and read nothing. This is the clone bug.
  if (Array.isArray(reference)) {
    errors.push(`block ${id} (${block.opcode}): input ${inputName} holds an inlined primitive where the ${expected[0]} dropdown belongs; ` +
      'the block will read no option at all')
    return
  }
  if (typeof reference === 'string') {
    const shadow = blocks[reference]
    if (shadow === undefined) {
      warnings.push(`block ${id} (${block.opcode}): input ${inputName} points at block ${reference}, which is not in this target`)
      return
    }
    if (Array.isArray(shadow)) {
      errors.push(`block ${id} (${block.opcode}): input ${inputName} points at an inlined primitive where the ${expected[0]} dropdown belongs`)
      return
    }
    if (tag === 1 && shadow.opcode !== expected[0]) {
      errors.push(`block ${id} (${block.opcode}): input ${inputName} uses the shadow block ${shadow.opcode}, but the editor expects ${expected[0]}` +
        (shadow.opcode === 'broadcast_msg' ? ' (broadcast_msg is a variable type in <variables>, not a block)' : ''))
    }
    if (Array.isArray(shadow.fields?.[expected[1]]) && shadow.fields[expected[1]].length > 0) return
    if (shadow.opcode === expected[0]) {
      warnings.push(`block ${id} (${block.opcode}): the ${expected[0]} shadow ${reference} has no ${expected[1]} field, so the dropdown is empty`)
    }
  }
}

/**
 * Check an inlined primitive whose value is a REFERENCE rather than a literal.
 *
 * A variable reporter is serialised as `[12, "score", "scoreId"]`, and the id is what
 * the runtime resolves at run time. When the id belongs to nothing — the everyday result
 * of merging `blocks` without `variables` — the reporter reads an empty value and the
 * script quietly misbehaves instead of failing.
 *
 * @param {{where: string, id: string, description: any, context: {declared: Set<string>, stageDeclared: Set<string>, report: VerifyReport}}} request the primitive to check
 */
const checkReferencePrimitive = ({ where, id, description, context }) => {
  if (!Array.isArray(description)) return
  const [constant, value, referenceId] = description
  if (!REFERENCE_PRIMITIVES.has(constant)) return
  const kind = PRIMITIVES_BY_CONSTANT[constant]?.[0] ?? `primitive ${constant}`
  if (typeof referenceId !== 'string' || referenceId.length === 0) {
    context.report.errors.push(`${where}: the inlined ${kind} "${value}" has no id, so nothing can resolve it`)
    return
  }
  if (!context.declared.has(referenceId) && !context.stageDeclared.has(referenceId)) {
    context.report.errors.push(`${where}: the inlined ${kind} "${value}" (id ${referenceId}) is not declared by this project ` +
      '(no matching variable, list or broadcast)')
  }
}

/**
 * Check one target's blocks.
 *
 * @param {any} target a project target
 * @param {{declared: Set<string>, stageDeclared: Set<string>, report: VerifyReport}} context the surrounding project
 */
const checkTargetBlocks = (target, context) => {
  const blocks = target.blocks ?? {}
  const { errors, warnings, notes } = context.report
  const where = `${target.name}${target.isStage ? ' (stage)' : ''}`

  for (const [id, block] of Object.entries(blocks)) {
    if (Array.isArray(block)) {
      // A top-level variable or list reporter is a bare array in the map.
      checkReferencePrimitive({ where, id, description: block, context })
      continue
    }
    if (block === null || typeof block !== 'object') {
      errors.push(`${where}: block ${id} is ${block === null ? 'null' : typeof block}, not a block`)
      continue
    }
    if (typeof block.opcode !== 'string' || block.opcode.length === 0) {
      errors.push(`${where}: block ${id} has no opcode`)
      continue
    }

    const extension = extensionPrefix(block.opcode)
    if (extension !== null && !BUILT_IN_EXTENSIONS.has(extension)) {
      warnings.push(`${where}: block ${id} has opcode "${block.opcode}", whose "${extension}" prefix is not a Scratch category. ` +
        'The editor reads that prefix as an extension id and refuses to open the project if it cannot load it')
    }

    checkMutation(id, block, errors)

    for (const [inputName, wire] of Object.entries(block.inputs ?? {})) {
      for (const reference of [wire?.[1], wire?.[2]]) {
        if (typeof reference === 'string' && blocks[reference] === undefined) {
          errors.push(`${where}: block ${id} (${block.opcode}) input ${inputName} points at block ${reference}, which does not exist in this target`)
        }
        // An inlined primitive sitting in the input slot is where variable and
        // broadcast reporters live, ids and all.
        if (Array.isArray(reference)) checkReferencePrimitive({ where, id, description: reference, context })
      }
      checkInput({ id, block, inputName, wire, blocks, errors, warnings })
    }

    if (typeof block.next === 'string' && blocks[block.next] === undefined) {
      errors.push(`${where}: block ${id} (${block.opcode}) continues into block ${block.next}, which does not exist in this target`)
    }

    for (const [fieldName, description] of Object.entries(block.fields ?? {})) {
      if (!Array.isArray(description)) continue
      const fieldId = description[1]
      if (typeof fieldId !== 'string' || fieldId.length === 0) continue
      if (!REFERENCE_FIELDS.has(fieldName)) continue
      // A field naming a variable that nothing declares renders as an unresolved
      // reporter: the project opens, and the script silently does nothing. This is
      // exactly what a merge that copies `blocks` but not `variables` produces.
      if (!context.declared.has(fieldId) && !context.stageDeclared.has(fieldId)) {
        errors.push(`${where}: block ${id} (${block.opcode}) uses ${fieldName} "${description[0]}" (id ${fieldId}), ` +
          'which no variable, list or broadcast in this project declares')
      }
    }
  }

  // Reachability: a script that no top-level block reaches is invisible in the editor
  // but stays in the file, and it is what a deleted script leaves behind.
  const reachable = new Set()
  const roots = Object.keys(blocks).filter((id) => Array.isArray(blocks[id]) || blocks[id]?.topLevel === true)
  for (const root of roots) for (const id of collectScript(blocks, root)) reachable.add(id)
  const orphans = Object.keys(blocks).filter((id) => !reachable.has(id))
  if (orphans.length > 0) {
    notes.push(`${where}: ${orphans.length} block(s) are not reachable from any script (left behind by an earlier edit)`)
  }
  for (const root of roots) {
    if (Array.isArray(blocks[root])) continue
    if (blocks[root].parent !== null && blocks[root].parent !== undefined) {
      const parent = blocks[blocks[root].parent]
      if (parent === undefined) {
        warnings.push(`${where}: top-level block ${root} claims parent ${blocks[root].parent}, which does not exist`)
      }
    }
  }

  // Comments are target state and name the block they hang off.
  for (const [commentId, comment] of Object.entries(target.comments ?? {})) {
    const blockId = comment?.blockId
    if (blockId === null || blockId === undefined) continue
    if (blocks[blockId] === undefined) {
      warnings.push(`${where}: comment ${commentId} is attached to block ${blockId}, which does not exist`)
    }
  }
}

/**
 * Check a whole project document.
 *
 * @param {any} project parsed `project.json`
 * @param {{assets?: Map<string, Buffer>|Record<string, any>, assetCount?: number}} [options] the archive contents, when there are any
 * @returns {VerifyReport} what was found
 */
export const verifyProject = (project, options = {}) => {
  /** @type {VerifyReport} */
  const report = emptyReport()
  const targets = project?.targets
  if (!Array.isArray(targets)) {
    report.errors.push('the project has no targets array, so it is not a project document')
    return report
  }
  const stage = targets.find((target) => target.isStage === true)
  if (stage === undefined) report.errors.push('the project has no stage target')

  for (const target of targets) {
    const declared = new Set([
      ...Object.keys(target.variables ?? {}),
      ...Object.keys(target.lists ?? {}),
      ...Object.keys(target.broadcasts ?? {})
    ])
    const stageDeclared = stage === undefined
      ? declared
      : new Set([
          ...Object.keys(stage.variables ?? {}),
          ...Object.keys(stage.lists ?? {}),
          ...Object.keys(stage.broadcasts ?? {})
        ])
    checkTargetBlocks(target, { declared, stageDeclared, report })

    const blocks = target.blocks ?? {}
    report.stats.blocks += Object.keys(blocks).length
    report.stats.scripts += Object.keys(blocks).filter((id) => Array.isArray(blocks[id]) || blocks[id]?.topLevel === true).length
    if (target.isStage !== true) report.stats.sprites++

    if ((target.costumes ?? []).length === 0) {
      report.errors.push(`${target.name}: no costume at all — the Scratch parser rejects a target without one`)
    }
    for (const costume of target.costumes ?? []) {
      const md5ext = costume.md5ext ?? costume.md5
      if (typeof md5ext !== 'string' || md5ext.length === 0) {
        report.errors.push(`${target.name}: costume "${costume.name}" carries no md5ext, so the archive cannot contain its image`)
        continue
      }
      if (options.assets !== undefined && !hasAsset(options.assets, md5ext)) {
        report.errors.push(`${target.name}: costume "${costume.name}" references asset ${md5ext}, which is not in the archive`)
      }
    }
    for (const sound of target.sounds ?? []) {
      const md5ext = sound.md5ext ?? sound.md5
      if (typeof md5ext !== 'string' || md5ext.length === 0) {
        report.errors.push(`${target.name}: sound "${sound.name}" carries no md5ext`)
        continue
      }
      if (options.assets !== undefined && !hasAsset(options.assets, md5ext)) {
        report.errors.push(`${target.name}: sound "${sound.name}" references asset ${md5ext}, which is not in the archive`)
      }
    }
  }

  // A block that nothing declares is a scope question the stage answers for globals,
  // but a broadcast is always the stage's, so an undeclared one is worth naming.
  report.stats.targets = targets.length
  report.stats.assets = options.assetCount ?? (options.assets === undefined ? 0 : sizeOf(options.assets))
  return report
}

/**
 * Whether the container holds an asset, for either shape the readers hand back.
 * @param {Map<string, any>|Record<string, any>} assets the archive contents
 * @param {string} md5ext the asset name
 * @returns {boolean} true when present
 */
const hasAsset = (assets, md5ext) =>
  typeof assets.has === 'function' ? assets.has(md5ext) : Object.hasOwn(assets, md5ext)

/** @param {Map<string, any>|Record<string, any>} assets the archive contents */
const sizeOf = (assets) => (typeof assets.size === 'number' ? assets.size : Object.keys(assets).length)

/**
 * Render a report as the text a tool returns.
 * @param {VerifyReport} report the findings
 * @param {{heading?: string}} [options] what to call this check
 * @returns {string} the report text
 */
export const formatReport = (report, options = {}) => {
  const lines = [options.heading ?? 'load check']
  const section = (title, entries) => {
    if (entries.length === 0) return
    lines.push(`${title} (${entries.length}):`)
    // Long lists are the norm for a broken merge (hundreds of dangling references) and
    // reading the first few is enough to recognise the pattern.
    for (const entry of entries.slice(0, 12)) lines.push(`  - ${entry}`)
    if (entries.length > 12) lines.push(`  … and ${entries.length - 12} more`)
  }
  section('errors', report.errors)
  section('warnings', report.warnings)
  section('notes', report.notes)
  if (report.errors.length === 0 && report.warnings.length === 0) {
    lines.push(`  no problems found: ${report.stats.targets} target(s), ${report.stats.sprites} sprite(s), ` +
      `${report.stats.blocks} block(s), ${report.stats.scripts} script(s)` + (report.stats.assets > 0 ? `, ${report.stats.assets} asset(s)` : ''))
  }
  return lines.join('\n')
}
