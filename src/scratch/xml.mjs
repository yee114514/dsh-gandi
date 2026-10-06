/**
 * Blockly/scratch-blocks XML -> sb3 block graph.
 *
 * This is the plugin's central translation. Models write Scratch code far more
 * reliably in the XML dialect that scratch-blocks emits (and that the whole
 * Scratch tooling ecosystem reads) than in the sb3 file format, whose input
 * encoding is a positional array protocol:
 *
 *     inputs: { STEPS: [1, [4, "10"]] }                  // an inlined primitive shadow
 *     inputs: { OPERAND: [2, "someBlockId"] }            // a reporter, no shadow behind it
 *     inputs: { OPERAND: [3, "id", [4, "10"]] }          // a reporter obscuring a primitive
 *     inputs: { MENU: [1, "menuBlockId"] }               // a non-primitive shadow block
 *
 * Verified upstream, not assumed:
 *   - scratch-vm/src/serialization/sb3.js:141-168 (serializeInputs) defines the
 *     1 / 2 / 3 tags and their payload shapes.
 *   - sb3.js:108-129 (serializePrimitiveBlock) defines the inlined primitive array
 *     and when the field id / x / y are appended.
 *   - sb3.js:175-185 (serializeFields) defines `[value]` vs `[value, id]`.
 *   - src/scratch/primitives.mjs carries the primitive constant table and its source.
 *
 * The compiler is pure and offline: it never touches a running editor, so the same
 * code produces a `.sb3` on disk and the payload pushed into a live VM.
 */

import { randomBytes } from 'node:crypto'

import { parseXml, childElement, childElements, escapeXml } from './xml-parse.mjs'
import { PRIMITIVE_OPCODES, PRIMITIVES_BY_CONSTANT, isPrimitiveOpcode } from './primitives.mjs'

/** Raised for XML that is well-formed but not a usable script fragment. */
export class ScriptCompileError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ScriptCompileError'
  }
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/**
 * Generate a block id shaped like the ones Blockly produces (20 chars, base62).
 * @returns {string} a fresh id
 */
export const randomBlockId = () => {
  const bytes = randomBytes(20)
  let id = ''
  for (let i = 0; i < 20; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  return id
}

/**
 * @typedef {object} CompiledFragment
 * @property {Record<string, any>} blocks block id -> sb3 block object (or inlined primitive array for a top-level primitive)
 * @property {string[]} topLevelIds ids of the fragment's top-level blocks, in document order
 * @property {{id: string, name: string, type: string}[]} variables variable/list declarations found in `<variables>`
 * @property {string[]} warnings non-fatal problems; the caller decides whether to apply anyway
 */

/**
 * Compile a scratch-blocks XML fragment into sb3 blocks.
 *
 * @param {string} source XML text: an `<xml>` root, or a bare `<block>`/`<shadow>`
 * @param {{newId?: () => string}} [options] injectable id generator (tests use a counter)
 * @returns {CompiledFragment} the compiled fragment
 * @throws {ScriptCompileError} when the document is not a usable script fragment
 */
export function compileScripts (source, options = {}) {
  const newId = options.newId ?? randomBlockId

  const root = parseXml(source)
  const scripts = []
  if (root.name === 'xml') {
    scripts.push(...childElements(root, 'block'))
    // A workspace may hold loose shadows (e.g. a variable reporter dropped on the canvas).
    for (const loose of childElements(root, 'shadow')) scripts.push(loose)
  } else if (root.name === 'block' || root.name === 'shadow') {
    scripts.push(root)
  } else {
    throw new ScriptCompileError(`expected an <xml>, <block> or <shadow> root, found <${root.name}>`)
  }

  /** @type {Record<string, any>} */
  const blocks = {}
  /** @type {string[]} */
  const topLevelIds = []
  /** @type {string[]} */
  const warnings = []
  /** @type {{id: string, name: string, type: string}[]} */
  const variables = []
  /** @type {any[]} */
  const comments = []
  /** @type {Set<string>} */
  const commentIds = new Set()
  /** Comment elements seen at the workspace level, by id. @type {Map<string, any>} */
  const pendingComments = new Map()

  /** Read an integer attribute, trying each name in turn. */
  const intAttribute = (element, ...names) => {
    for (const name of names) {
      const value = Number(element.attributes[name])
      if (Number.isFinite(value)) return Math.round(value)
    }
    return undefined
  }

  /** Read a `<comment>` element into a record, without registering it. */
  const commentRecord = (element, blockId) => ({
    id: element.attributes.id,
    blockId,
    text: element.text,
    x: intAttribute(element, 'x'),
    y: intAttribute(element, 'y'),
    width: intAttribute(element, 'w', 'width'),
    height: intAttribute(element, 'h', 'height'),
    minimized: element.attributes.minimized === 'true' || element.attributes.minimized === 'minimized'
  })

  /**
   * Register a comment, merging with the workspace-level copy when there is one.
   *
   * `emitWorkspaceUpdate` puts every comment at the workspace level AND again inside
   * the block it hangs off, so the same id legitimately appears twice in the editor's
   * own XML. Taking both would produce a duplicate; taking neither would lose the
   * note. The in-block copy wins on text, since that is the one attached to a script.
   *
   * @param {import('./xml-parse.mjs').XmlElement} element the `<comment>` element
   * @param {string|null} blockId the block it hangs off
   * @returns {string} the comment id
   */
  const registerComment = (element, blockId) => {
    const rawId = element.attributes.id
    const pending = rawId === undefined ? undefined : pendingComments.get(rawId)
    const inline = commentRecord(element, blockId)
    let id = rawId ?? newId()

    const record = {
      id,
      blockId,
      text: inline.text.length > 0 ? inline.text : (pending?.text ?? ''),
      x: inline.x ?? pending?.x,
      y: inline.y ?? pending?.y,
      width: inline.width ?? pending?.width,
      height: inline.height ?? pending?.height,
      minimized: inline.minimized || pending?.minimized === true
    }

    if (pending !== undefined) pendingComments.delete(id)
    if (commentIds.has(id)) {
      const replacement = newId()
      warnings.push(`duplicate comment id "${id}" renamed to "${replacement}"`)
      id = replacement
      record.id = id
    }
    commentIds.add(id)
    comments.push(record)
    return id
  }

  /**
   * Collect the workspace-level comments first, without registering them: an
   * attached comment appears here too, and only the in-block copy knows its block.
   */
  if (root.name === 'xml') {
    for (const loose of childElements(root, 'comment')) {
      const id = loose.attributes.id ?? newId()
      if (pendingComments.has(id)) {
        warnings.push(`duplicate comment id "${id}" in the workspace; only the first was kept`)
        continue
      }
      pendingComments.set(id, commentRecord(loose, null))
    }
  }

  const variablesElement = root.name === 'xml' ? childElement(root, 'variables') : undefined
  if (variablesElement !== undefined) {
    for (const declaration of childElements(variablesElement, 'variable')) {
      const id = declaration.attributes.id
      const name = declaration.text
      if (id === undefined) {
        warnings.push(`<variable> "${name}" has no id and was skipped`)
        continue
      }
      variables.push({ id, name, type: declaration.attributes.type ?? '' })
    }
  }

  /**
   * Compile one `<block>`/`<shadow>` element and everything below it.
   * @param {import('./xml-parse.mjs').XmlElement} element the element to compile
   * @param {{parent: string|null, shadow: boolean, topLevel: boolean}} context placement
   * @returns {string|null} the block id, or null when the element is unusable
   */
  const compileBlock = (element, context) => {
    const opcode = element.attributes.type
    if (opcode === undefined || opcode.length === 0) {
      warnings.push(`<${element.name}> without a type attribute was skipped`)
      return null
    }

    let id = element.attributes.id
    if (id === undefined || id.length === 0) {
      id = newId()
    } else if (Object.hasOwn(blocks, id)) {
      const replacement = newId()
      warnings.push(`duplicate block id "${id}" renamed to "${replacement}"`)
      id = replacement
    }

    // A top-level primitive (e.g. a variable reporter dropped on the workspace) is
    // serialized as a bare array in the blocks map, not as a block object — see
    // sb3.js:363-371, which warns about every OTHER top-level primitive.
    if (context.topLevel && isPrimitiveOpcode(opcode)) {
      const inlined = inlinePrimitive(element, opcode, warnings, true)
      if (inlined !== null) {
        blocks[id] = inlined
        topLevelIds.push(id)
        return id
      }
      // Fall through and emit a normal block when the primitive is malformed.
    }

    /** @type {Record<string, any>} */
    const block = {
      opcode,
      next: null,
      parent: context.parent,
      inputs: {},
      fields: {},
      shadow: context.shadow,
      topLevel: context.topLevel
    }

    if (context.topLevel) {
      const x = Number(element.attributes.x)
      const y = Number(element.attributes.y)
      if (Number.isFinite(x)) block.x = Math.round(x)
      if (Number.isFinite(y)) block.y = Math.round(y)
    }

    for (const field of childElements(element, 'field')) {
      const name = field.attributes.name
      if (name === undefined) {
        warnings.push(`block ${id} (${opcode}): <field> without a name was skipped`)
        continue
      }
      const fieldId = field.attributes.id
      block.fields[name] = fieldId === undefined ? [field.text] : [field.text, fieldId]
    }

    const mutation = childElement(element, 'mutation')
    if (mutation !== undefined) {
      // All mutation payload is string-valued on the wire (argumentids is itself a
      // JSON string), so the attribute map passes through unchanged.
      block.mutation = { ...mutation.attributes }
    }

    const commentElement = childElement(element, 'comment')
    if (commentElement !== undefined) {
      block.comment = registerComment(commentElement, id)
    }

    // Register before descending so a self-reference cannot recurse forever.
    blocks[id] = block

    for (const input of element.children) {
      if (input.name !== 'value' && input.name !== 'statement') continue
      const name = input.attributes.name
      if (name === undefined) {
        warnings.push(`block ${id} (${opcode}): <${input.name}> without a name was skipped`)
        continue
      }
      const compiled = compileInput(input, id, warnings, newId, compileBlock)
      if (compiled !== null) block.inputs[name] = compiled
    }

    const nextElement = childElement(element, 'next')
    if (nextElement !== undefined) {
      const successor = nextElement.children.find((child) => child.name === 'block' || child.name === 'shadow')
      if (successor !== undefined) {
        const successorId = compileBlock(successor, { parent: id, shadow: false, topLevel: false })
        if (successorId !== null) block.next = successorId
      }
    }

    if (context.topLevel) topLevelIds.push(id)
    return id
  }

  for (const script of scripts) {
    const isShadow = script.name === 'shadow'
    compileBlock(script, { parent: null, shadow: isShadow, topLevel: !isShadow })
  }

  // Anything left over was declared at the workspace level and never attached to a
  // block — a note in the middle of the canvas.
  for (const record of pendingComments.values()) {
    let id = record.id ?? newId()
    if (commentIds.has(id)) {
      const replacement = newId()
      warnings.push(`duplicate comment id "${id}" renamed to "${replacement}"`)
      id = replacement
    }
    commentIds.add(id)
    comments.push({ ...record, id, blockId: null })
  }

  const fragment = { blocks, topLevelIds, variables, comments, warnings }
  resolveProcedures(fragment, warnings, newId)
  placeComments(fragment)
  return fragment
}

/** Every placeholder a proccode can carry: %n number, %s string, %b boolean. */
const PLACEHOLDER = /%[nsb]/g

/**
 * Parse one of the mutation's array attributes.
 *
 * Scratch writes these as JSON strings (`argumentids="[\"a1\",\"a2\"]"`), which is
 * what the decompiler emits and what must survive a round trip. A plain
 * comma-separated list is accepted too, because that is what a person writes by
 * hand — argument names and ids cannot contain a comma, so it is unambiguous. A
 * DEFAULT value containing a comma therefore needs the JSON form; getting that wrong
 * shows up as a count mismatch, which the caller warns about.
 *
 * @param {any} value the raw attribute
 * @returns {string[]|null} the entries, or null when nothing usable was given
 */
const parseArray = (value) => {
  if (Array.isArray(value)) return value.map((entry) => String(entry))
  if (typeof value !== 'string' || value.length === 0) return null
  const text = value.trim()
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : null
    } catch {
      return null
    }
  }
  return text.split(',').map((entry) => entry.trim())
}

/**
 * Fill in the boilerplate that a custom block needs, and keep it consistent.
 *
 * Scratch spells a custom block out three times over: a `procedures_definition`
 * holding a `procedures_prototype` shadow, and a `procedures_call` per use site. All
 * three share a `proccode`, the arguments are matched between them by id, and the ids
 * live in a JSON string inside a mutation attribute. Writing that by hand is where
 * custom blocks go wrong, so the compiler accepts a short form and expands it:
 *
 *     <block type="procedures_definition">
 *       <mutation proccode="jump %n" argumentnames="height" argumentdefaults="10"/>
 *       ...
 *
 * Anything already spelled out is used as given, and a call may name its inputs by
 * argument NAME instead of by id — the ids are filled in from the definition.
 *
 * @param {{blocks: Record<string, any>, warnings: string[]}} fragment the compiled fragment, mutated in place
 * @param {string[]} warnings collector
 * @param {() => string} newId id generator
 */
const resolveProcedures = (fragment, warnings, newId) => {
  const blocks = fragment.blocks
  /** @type {Map<string, {proccode: string, ids: string[], names: string[], warp: string}>} */
  const byProccode = new Map()

  for (const id of Object.keys(blocks)) {
    const block = blocks[id]
    if (Array.isArray(block) || block.opcode !== 'procedures_definition') continue

    const wire = block.inputs?.custom_block
    const prototypeId = Array.isArray(wire) && typeof wire[1] === 'string' ? wire[1] : undefined
    const prototype = prototypeId === undefined ? undefined : blocks[prototypeId]
    // The mutation may be written on either element. The prototype is where Scratch
    // keeps it, so that one wins when both are present.
    const declared = prototype?.mutation?.proccode !== undefined ? prototype.mutation : block.mutation
    const proccode = declared?.proccode
    if (typeof proccode !== 'string' || proccode.length === 0) {
      warnings.push(`custom block ${id} has no mutation proccode; it will not run`)
      continue
    }
    if (byProccode.has(proccode)) {
      warnings.push(`"${proccode}" is defined more than once in this fragment; calls resolve to the first definition`)
      continue
    }

    const placeholders = proccode.match(PLACEHOLDER) ?? []
    const count = placeholders.length

    let ids = parseArray(declared.argumentids)
    if (ids === null || ids.length !== count) {
      if (ids !== null && ids.length > 0) {
        warnings.push(`"${proccode}": argumentids has ${ids.length} entries but the proccode has ${count} placeholder(s); regenerating them`)
      }
      ids = placeholders.map(() => newId())
    }
    let names = parseArray(declared.argumentnames)
    if (names === null || names.length !== count) {
      if (names !== null && names.length > 0) {
        warnings.push(`"${proccode}": argumentnames has ${names.length} entries but the proccode has ${count} placeholder(s); regenerating them`)
      }
      names = placeholders.map((_, index) => `arg${index + 1}`)
    }
    let defaults = parseArray(declared.argumentdefaults)
    if (defaults === null || defaults.length !== count) defaults = placeholders.map(() => '')
    const warp = declared.warp === 'true' || declared.warp === true ? 'true' : 'false'

    // The canonical prototype mutation: all five attributes, JSON-encoded arrays.
    const mutation = {
      tagName: 'mutation',
      children: [],
      proccode,
      argumentids: JSON.stringify(ids),
      argumentnames: JSON.stringify(names),
      argumentdefaults: JSON.stringify(defaults),
      warp
    }

    if (prototype === undefined) {
      const createdId = newId()
      blocks[createdId] = {
        opcode: 'procedures_prototype',
        next: null,
        parent: id,
        inputs: {},
        fields: {},
        shadow: true,
        topLevel: false,
        mutation
      }
      block.inputs = { ...(block.inputs ?? {}), custom_block: [1, createdId] }
    } else {
      prototype.opcode = 'procedures_prototype'
      prototype.shadow = true
      prototype.parent = id
      prototype.mutation = mutation
      block.inputs = { ...(block.inputs ?? {}), custom_block: [1, prototypeId] }
    }
    // Scratch keeps the mutation on the prototype only; a definition carrying one
    // renders oddly in the editor.
    delete block.mutation

    byProccode.set(proccode, { proccode, ids, names, warp })
  }

  for (const id of Object.keys(blocks)) {
    const block = blocks[id]
    if (Array.isArray(block) || block.opcode !== 'procedures_call') continue
    const proccode = block.mutation?.proccode
    if (typeof proccode !== 'string' || proccode.length === 0) {
      warnings.push(`custom block call ${id} has no mutation proccode; it will not run`)
      continue
    }
    const definition = byProccode.get(proccode)
    if (definition === undefined) {
      // A call may legitimately target a definition that already exists in the
      // target (append mode), so this is only a problem when the ids are missing.
      if (parseArray(block.mutation?.argumentids) === null) {
        warnings.push(`call to "${proccode}" has no matching definition in this fragment and no argumentids; its arguments cannot be resolved`)
      }
      continue
    }

    // Calls address their arguments by ID, but a person writing XML would rather
    // use the name they declared. Accept either.
    const inputs = {}
    for (const [name, inputWire] of Object.entries(block.inputs ?? {})) {
      const index = definition.names.indexOf(name)
      inputs[index === -1 ? name : definition.ids[index]] = inputWire
    }
    block.inputs = inputs
    block.mutation = {
      tagName: 'mutation',
      children: [],
      proccode,
      argumentids: JSON.stringify(definition.ids),
      warp: definition.warp
    }
  }
}

/**
 * Give every comment a position, using the script it hangs off when none was given.
 *
 * A comment with no coordinates would land at the workspace origin, on top of
 * whatever is there, so an unattached-position comment is placed beside the
 * top-level block it belongs to.
 *
 * @param {{blocks: Record<string, any>, comments?: any[]}} fragment the compiled fragment
 */
const placeComments = (fragment) => {
  for (const comment of fragment.comments ?? []) {
    const blockId = comment.blockId
    let anchor
    let guard = 0
    while (typeof blockId === 'string' && guard++ < 1000) {
      const block = fragment.blocks[blockId]
      if (block === undefined) break
      if (Array.isArray(block) || block.topLevel === true) {
        anchor = block
        break
      }
      const parentId = block.parent
      if (typeof parentId !== 'string') break
      anchor = fragment.blocks[parentId]
      break
    }
    const anchorX = Number.isFinite(anchor?.x) ? anchor.x : 0
    const anchorY = Number.isFinite(anchor?.y) ? anchor.y : 0
    if (!Number.isFinite(comment.x)) comment.x = anchorX + 240
    if (!Number.isFinite(comment.y)) comment.y = anchorY
    // Comment's constructor clamps these to its own minimums, so the defaults match
    // the size the editor gives a new comment rather than a bare minimum.
    if (!Number.isFinite(comment.width)) comment.width = 200
    if (!Number.isFinite(comment.height)) comment.height = 200
    if (comment.minimized !== true) comment.minimized = false
  }
}

/**
 * Build the inlined primitive array for a `<shadow>`/`<block>` element.
 *
 * @param {import('./xml-parse.mjs').XmlElement} element the primitive element
 * @param {string} opcode the primitive opcode
 * @param {string[]} warnings collector
 * @param {boolean} topLevel whether positions should be appended (see sb3.js:121-124)
 * @returns {any[]|null} `[constant, value, id?, x?, y?]`, or null when malformed
 */
const inlinePrimitive = (element, opcode, warnings, topLevel) => {
  const [constant, fieldName] = PRIMITIVE_OPCODES[opcode]
  const field = childElements(element, 'field').find((candidate) => candidate.attributes.name === fieldName)
  if (field === undefined) {
    warnings.push(`primitive ${opcode} is missing its <field name="${fieldName}">`)
    return null
  }
  const description = [constant, field.text]
  if (opcode === 'event_broadcast_menu' || opcode === 'data_variable' || opcode === 'data_listcontents') {
    if (field.attributes.id === undefined) {
      warnings.push(`primitive ${opcode} ("${field.text}") has no field id; the reference may not resolve`)
      description.push('')
    } else {
      description.push(field.attributes.id)
    }
    if (topLevel && (opcode === 'data_variable' || opcode === 'data_listcontents')) {
      const x = Number(element.attributes.x)
      const y = Number(element.attributes.y)
      description.push(Number.isFinite(x) ? Math.round(x) : 0)
      description.push(Number.isFinite(y) ? Math.round(y) : 0)
    }
  }
  return description
}

/**
 * Compile one `<value>`/`<statement>` element into its serialized input array.
 *
 * @param {import('./xml-parse.mjs').XmlElement} input the input element
 * @param {string} parentId owning block id
 * @param {string[]} warnings collector
 * @param {() => string} newId id generator for materialized shadow blocks
 * @param {(element: any, context: any) => string|null} compileBlock recursive compiler
 * @returns {any[]|null} the serialized input, or null when the input is empty
 */
const compileInput = (input, parentId, warnings, newId, compileBlock) => {
  // A statement input can only hold a real block, and a `<shadow>` there is never
  // valid scratch-blocks output, but we accept it rather than silently dropping it.
  const blockElement = childElements(input, 'block')[0]
  const shadowElement = childElements(input, 'shadow')[0]
  if (childElements(input, 'block').length > 1) {
    warnings.push(`input "${input.attributes.name}" of block ${parentId} has several <block> children; only the first is used`)
  }

  if (blockElement !== undefined && shadowElement !== undefined) {
    const blockId = compileBlock(blockElement, { parent: parentId, shadow: false, topLevel: false })
    const shadowRef = materializeShadow(shadowElement, parentId, warnings, newId, compileBlock)
    if (blockId === null || shadowRef === null) return null
    return [3, blockId, shadowRef]
  }
  if (blockElement !== undefined) {
    const blockId = compileBlock(blockElement, { parent: parentId, shadow: false, topLevel: false })
    return blockId === null ? null : [2, blockId]
  }
  if (shadowElement !== undefined) {
    const shadowRef = materializeShadow(shadowElement, parentId, warnings, newId, compileBlock)
    return shadowRef === null ? null : [1, shadowRef]
  }
  return null
}

/**
 * Reference a shadow from its parent's input: primitives inline, everything else
 * becomes a real `shadow: true` block referenced by id.
 *
 * @param {import('./xml-parse.mjs').XmlElement} shadowElement the `<shadow>` element
 * @param {string} parentId owning block id
 * @param {string[]} warnings collector
 * @param {() => string} newId id generator
 * @param {(element: any, context: any) => string|null} compileBlock recursive compiler
 * @returns {any[]|string|null} an inlined primitive array, a shadow block id, or null
 */
const materializeShadow = (shadowElement, parentId, warnings, newId, compileBlock) => {
  const opcode = shadowElement.attributes.type
  if (opcode !== undefined && isPrimitiveOpcode(opcode)) {
    return inlinePrimitive(shadowElement, opcode, warnings, false)
  }
  return compileBlock(shadowElement, { parent: parentId, shadow: true, topLevel: false })
}

// ── decompilation: fragment -> XML ──────────────────────────────────────────

/**
 * Input names that hold a nested stack of blocks rather than a value.
 *
 * The wire format does not distinguish them: both a `<value>` and a `<statement>`
 * serialize to `[2, blockId]`. Only the block definition knows which is which, and
 * that definition lives in scratch-blocks rather than in a project file. These are
 * the C-block bodies Scratch ships; anything else is emitted as a value input,
 * which the compiler treats identically, so reading and round-tripping are
 * unaffected either way.
 */
const STATEMENT_INPUTS = new Set(['SUBSTACK', 'SUBSTACK2'])

/**
 * Render an inlined primitive array back into its `<shadow>` element.
 * @param {any[]} description `[constant, value, id?, x?, y?]`
 * @param {number} depth indentation depth
 * @param {(depth: number, line: string) => void} emit line sink
 */
const emitPrimitive = (description, depth, emit) => {
  const [constant, value, id] = description
  const info = PRIMITIVES_BY_CONSTANT[constant]
  if (info === undefined) {
    emit(depth, `<!-- unknown primitive constant ${JSON.stringify(constant)} -->`)
    return
  }
  const [opcode, fieldName] = info
  const idAttribute = id === undefined || id === '' ? '' : ` id="${escapeXml(id)}"`
  emit(depth, `<shadow type="${escapeXml(opcode)}"${idAttribute}>`)
  emit(depth + 1, `<field name="${escapeXml(fieldName)}"${idAttribute}>${escapeXml(String(value ?? ''))}</field>`)
  emit(depth, '</shadow>')
}

/**
 * Render a compiled fragment back into scratch-blocks XML.
 *
 * The output is the dialect `compileScripts` reads and `scratch_inspect` prints, and
 * compiling it again yields an equal fragment — that round trip is what the tests
 * assert, and it is the property that makes the offline path trustworthy: a project
 * read from disk can be edited as text and written back.
 *
 * Custom blocks come out in Scratch's own spelling (the prototype shadow carrying
 * the full mutation, calls addressing their arguments by id); comments come out as
 * `<comment>` inside the block they hang off.
 *
 * @param {{blocks: Record<string, any>, topLevelIds: string[], variables?: any[], comments?: any[]}} fragment the fragment to render
 * @param {{indent?: string}} [options] formatting options
 * @returns {string} XML text
 */
export function decompileScripts (fragment, options = {}) {
  const indent = options.indent ?? '  '
  const lines = []
  const emit = (depth, line) => lines.push(indent.repeat(depth) + line)

  const blocks = fragment.blocks ?? {}
  const emitted = new Set()
  const comments = fragment.comments ?? []
  const commentsById = new Map(comments.map((comment) => [comment.id, comment]))

  /**
   * Emit one `<comment>` element, spelled the way Comment.toXML() spells it.
   * @param {any} comment the comment record
   * @param {number} depth indentation depth
   */
  const emitComment = (comment, depth) => {
    const attributes = [`id="${escapeXml(comment.id)}"`]
    for (const [name, value] of [['x', comment.x], ['y', comment.y], ['w', comment.width], ['h', comment.height]]) {
      if (Number.isFinite(value)) attributes.push(`${name}="${Math.round(value)}"`)
    }
    // "pinned" is how the editor says "this comment hangs off a block". It is
    // redundant inside a <block> element, but emitting it keeps the output identical
    // in shape to what emitWorkspaceUpdate produces, so the two can be read alike.
    attributes.push(`pinned="${comment.blockId !== null && comment.blockId !== undefined}"`)
    attributes.push(`minimized="${comment.minimized === true}"`)
    emit(depth, `<comment ${attributes.join(' ')}>${escapeXml(String(comment.text ?? ''))}</comment>`)
  }

  /**
   * Emit one block (or a top-level primitive) and its children.
   * @param {string} id block id
   * @param {number} depth indentation depth
   * @param {boolean} isShadow whether to render a `<shadow>` element
   * @param {{x?: number, y?: number}} [position] top-level coordinates
   */
  const emitBlock = (id, depth, isShadow, position) => {
    const definition = blocks[id]
    if (definition === undefined) {
      emit(depth, `<!-- missing block ${escapeXml(id)} -->`)
      return
    }
    if (Array.isArray(definition)) {
      // A top-level primitive is a bare array in the wire format, and its third
      // slot is the FIELD id (a variable's id), not the block's map key. Both have
      // to be emitted, or recompiling would file the block under the wrong key.
      const [constant, value, fieldId, x, y] = definition
      const info = PRIMITIVES_BY_CONSTANT[constant]
      if (info === undefined) {
        emit(depth, `<!-- unknown primitive constant ${JSON.stringify(constant)} -->`)
        return
      }
      const [opcode, fieldName] = info
      const fieldIdAttribute = fieldId === undefined || fieldId === '' ? '' : ` id="${escapeXml(fieldId)}"`
      const coords = Number.isFinite(x) || Number.isFinite(y)
        ? ` x="${Number.isFinite(x) ? x : 0}" y="${Number.isFinite(y) ? y : 0}"`
        : ''
      emit(depth, `<block type="${escapeXml(opcode)}" id="${escapeXml(id)}"${coords}>`)
      emit(depth + 1, `<field name="${escapeXml(fieldName)}"${fieldIdAttribute}>${escapeXml(String(value ?? ''))}</field>`)
      emit(depth, '</block>')
      return
    }

    emitted.add(id)
    const tag = isShadow ? 'shadow' : 'block'
    const attributes = [`type="${escapeXml(definition.opcode)}"`, `id="${escapeXml(id)}"`]
    if (position !== undefined && Number.isFinite(position.x)) attributes.push(`x="${Math.round(position.x)}"`)
    if (position !== undefined && Number.isFinite(position.y)) attributes.push(`y="${Math.round(position.y)}"`)
    // A block with no children still needs an opening and closing tag: the parser
    // treats `<block/>` and `<block></block>` the same, but the explicit form is
    // easier to read in tool output.
    emit(depth, `<${tag} ${attributes.join(' ')}>`)

    for (const [name, description] of Object.entries(definition.fields ?? {})) {
      const [value, fieldId] = description
      const idAttribute = fieldId === undefined || fieldId === '' ? '' : ` id="${escapeXml(fieldId)}"`
      emit(depth + 1, `<field name="${escapeXml(name)}"${idAttribute}>${escapeXml(String(value ?? ''))}</field>`)
    }

    if (definition.mutation !== undefined) {
      const attributes = Object.entries(definition.mutation)
        .map(([key, value]) => `${key}="${escapeXml(String(value))}"`)
        .join(' ')
      emit(depth + 1, `<mutation ${attributes}></mutation>`)
    }

    for (const [name, wire] of Object.entries(definition.inputs ?? {})) {
      const tag = STATEMENT_INPUTS.has(name) ? 'statement' : 'value'
      const reference = wire?.[1]
      const obscured = wire?.[2]
      const hasBlock = wire?.[0] !== 1
      if (!hasBlock && (reference === undefined || reference === null)) continue

      emit(depth + 1, `<${tag} name="${escapeXml(name)}">`)
      if (hasBlock) {
        if (Array.isArray(reference)) emitPrimitive(reference, depth + 2, emit)
        else emitBlock(reference, depth + 2, false)
      } else if (Array.isArray(reference)) {
        emitPrimitive(reference, depth + 2, emit)
      } else {
        emitBlock(reference, depth + 2, true)
      }
      // An obscured shadow rides along so the input can be un-plugged again.
      if (wire?.[0] === 3 && obscured !== undefined && obscured !== null) {
        if (Array.isArray(obscured)) emitPrimitive(obscured, depth + 2, emit)
        else emitBlock(obscured, depth + 2, true)
      }
      emit(depth + 1, `</${tag}>`)
    }

    if (definition.next !== undefined && definition.next !== null) {
      emit(depth + 1, '<next>')
      emitBlock(definition.next, depth + 2, false)
      emit(depth + 1, '</next>')
    }

    // Comments are NOT part of the block graph in a project document: they live on
    // the target and point at a block id. Rendering one inside its block is what
    // makes the round trip possible.
    if (typeof definition.comment === 'string') {
      const comment = commentsById.get(definition.comment)
      if (comment === undefined) emit(depth + 1, `<!-- missing comment ${escapeXml(definition.comment)} -->`)
      else emitComment(comment, depth + 1)
    }

    emit(depth, `</${tag}>`)
  }

  emit(0, '<xml xmlns="http://www.w3.org/1999/xhtml">')
  const variables = fragment.variables ?? []
  if (variables.length > 0) {
    emit(1, '<variables>')
    for (const variable of variables) {
      emit(2, `<variable id="${escapeXml(variable.id)}" type="${escapeXml(variable.type ?? '')}">${escapeXml(variable.name)}</variable>`)
    }
    emit(1, '</variables>')
  }

  for (const id of fragment.topLevelIds ?? []) {
    const definition = blocks[id]
    const position = Array.isArray(definition)
      ? { x: definition[3], y: definition[4] }
      : { x: definition?.x, y: definition?.y }
    emitBlock(id, 1, false, position)
  }

  // Comments with no block of their own, and comments whose block is not part of
  // this fragment, belong to the workspace. Dropping them silently would lose a
  // user's notes on the first edit.
  for (const comment of comments) {
    if (typeof comment.blockId === 'string' && emitted.has(comment.blockId)) continue
    emitComment(comment, 1)
  }

  emit(0, '</xml>')
  return lines.join('\n')
}
