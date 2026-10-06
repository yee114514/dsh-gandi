/**
 * Compiled fragment (sb3 wire format) -> scratch-vm engine block objects.
 *
 * Two representations of the same graph exist and they are NOT interchangeable:
 *
 *   - the **wire format** (`src/scratch/xml.mjs` output, and what `.sb3` stores)
 *     inlines primitive shadows into positional arrays inside `inputs`;
 *   - the **engine format** that `Blocks.createBlock()` consumes keeps every
 *     shadow as a real entry in the block map and points at it by id, with
 *     `fields` entries carrying `name` / `value` / `variableType`.
 *
 * Verified upstream: `scratch-vm/src/serialization/sb3.js:938-998`
 * (`deserializeInputs`, `deserializeFields`) is exactly this conversion, and it is
 * what runs when a `.sb3` is loaded. `createBlock` is never given wire-format
 * inputs, so a surgical edit has to do the conversion itself.
 *
 * Keeping one IR (the wire format) and converting at the boundary means the
 * compiler has a single output shape to be tested against, and the offline `.sb3`
 * writer and the live editor both consume the same bytes.
 */

import { PRIMITIVES_BY_CONSTANT, PRIMITIVE_OPCODES, isPrimitiveOpcode, BROADCAST_TYPE, LIST_TYPE, SCALAR_TYPE } from './primitives.mjs'
import { randomBlockId } from './xml.mjs'

/** Raised when a fragment cannot be expressed as engine blocks. */
export class EngineConversionError extends Error {
  constructor (message) {
    super(message)
    this.name = 'EngineConversionError'
  }
}

/** Field name -> the `variableType` scratch-vm attaches (sb3.js:989-995). */
const VARIABLE_TYPE_BY_FIELD = Object.freeze({
  BROADCAST_OPTION: BROADCAST_TYPE,
  VARIABLE: SCALAR_TYPE,
  LIST: LIST_TYPE
})

/**
 * Convert one fields map from wire to engine form.
 * @param {Record<string, any[]>} fields wire fields
 * @returns {Record<string, any>} engine fields
 */
const convertFields = (fields) => {
  const converted = {}
  for (const [name, description] of Object.entries(fields ?? {})) {
    const field = { name, value: description[0] }
    if (description.length > 1 && description[1] !== undefined && description[1] !== '') {
      field.id = description[1]
    }
    const variableType = VARIABLE_TYPE_BY_FIELD[name]
    if (variableType !== undefined) field.variableType = variableType
    converted[name] = field
  }
  return converted
}

/**
 * Turn an inlined primitive array back into a shadow block object.
 * @param {any[]} description `[constant, value, id?, x?, y?]`
 * @param {string} parentId the block that owns the input
 * @param {() => string} newId id generator
 * @returns {any} an engine-format shadow block
 */
const primitiveToBlock = (description, parentId, newId) => {
  const [constant] = description
  const info = PRIMITIVES_BY_CONSTANT[constant]
  if (info === undefined) {
    throw new EngineConversionError(`unknown primitive constant ${JSON.stringify(constant)}`)
  }
  const [opcode, fieldName] = info
  const field = { name: fieldName, value: description[1] }
  if (description.length > 2 && description[2] !== undefined && description[2] !== '') {
    field.id = description[2]
  }
  const variableType = VARIABLE_TYPE_BY_FIELD[fieldName]
  if (variableType !== undefined) field.variableType = variableType

  return {
    id: newId(),
    opcode,
    next: null,
    parent: parentId,
    inputs: {},
    fields: { [fieldName]: field },
    shadow: true,
    topLevel: false
  }
}

/**
 * Convert a compiled fragment into engine-format blocks.
 *
 * Shadow blocks referenced by id keep their ids; inlined primitives are
 * materialised as new shadow blocks, which is why the returned list is longer
 * than the fragment's block map.
 *
 * @param {{blocks: Record<string, any>, topLevelIds: string[]}} fragment compiled fragment
 * @param {{newId?: () => string}} [options] id generator for materialised primitives
 * @returns {{blocks: any[], topLevelIds: string[]}} engine blocks in dependency-safe order
 */
export function fragmentToEngine (fragment, options = {}) {
  const newId = options.newId ?? randomBlockId
  const engineBlocks = []
  /** Ids that already exist as real blocks in the fragment (shadows included). */
  const knownIds = new Set(Object.keys(fragment.blocks))

  for (const [id, definition] of Object.entries(fragment.blocks)) {
    if (Array.isArray(definition)) {
      // A top-level primitive (a variable reporter dropped on the workspace) has
      // no engine block of its own in wire format; scratch-vm reconstructs it on
      // load. Surgical application cannot, so say so rather than emit a stub.
      throw new EngineConversionError(
        `block ${id} is a top-level primitive (${JSON.stringify(definition)}); ` +
        'use a whole-project load for fragments like this'
      )
    }

    const engine = {
      id,
      opcode: definition.opcode,
      next: definition.next ?? null,
      parent: definition.parent ?? null,
      inputs: {},
      fields: convertFields(definition.fields),
      shadow: definition.shadow === true,
      topLevel: definition.topLevel === true
    }
    if (definition.topLevel === true) {
      engine.x = typeof definition.x === 'number' ? definition.x : 0
      engine.y = typeof definition.y === 'number' ? definition.y : 0
    }
    if (definition.mutation !== undefined) engine.mutation = { ...definition.mutation }
    // A block points at its comment by id; the comment itself travels separately
    // (comments live on the target, not in the block graph).
    if (typeof definition.comment === 'string') engine.comment = definition.comment

    for (const [name, wire] of Object.entries(definition.inputs ?? {})) {
      const tag = wire[0]
      let blockRef = null
      let shadowRef = null

      if (tag === 1) {
        shadowRef = resolveRef(wire[1], id, newId, knownIds, engineBlocks)
        blockRef = shadowRef
      } else if (tag === 2) {
        blockRef = resolveRef(wire[1], id, newId, knownIds, engineBlocks)
      } else if (tag === 3) {
        blockRef = resolveRef(wire[1], id, newId, knownIds, engineBlocks)
        shadowRef = resolveRef(wire[2], id, newId, knownIds, engineBlocks)
      } else {
        throw new EngineConversionError(`block ${id} input ${name} has unknown tag ${JSON.stringify(tag)}`)
      }

      engine.inputs[name] = { name, block: blockRef, shadow: shadowRef }
    }

    engineBlocks.push(engine)
  }

  // Shadows created while resolving inputs are appended; scratch-vm tolerates any
  // creation order because inputs reference ids, but creating owners first keeps
  // the editor's ordering stable across runs.
  return { blocks: engineBlocks, topLevelIds: [...fragment.topLevelIds], comments: [...(fragment.comments ?? [])] }
}

/**
 * Inverse of {@link fragmentToEngine}: turn a live target's block map back into the
 * wire form, so the offline code paths can work on a running editor.
 *
 * The two forms differ in exactly three ways:
 *
 *   - an engine input is `{name, block, shadow}`, a wire input is a tagged array
 *     (`[1, ref]`, `[2, id]`, `[3, blockId, shadowRef]`);
 *   - a field is `{name, value, id}` on an engine block and `[value]` / `[value, id]`
 *     on the wire;
 *   - primitives are real `shadow: true` blocks in the engine form and INLINED
 *     arrays in the wire form, with no entry of their own in the block map.
 *
 * Getting this wrong is quiet: the decompiler simply renders an empty script, which
 * looks like "the sprite has no blocks" rather than like a bug.
 *
 * @param {{blocks: any[], topLevelIds?: string[]}} engine fragment in engine form
 * @returns {{blocks: Record<string, any>, topLevelIds: string[]}} fragment in wire form
 */
export const engineToFragment = (engine) => {
  const source = new Map((engine.blocks ?? []).map((block) => [block.id, block]))

  /**
   * Which primitives get inlined, decided in a pass of its own.
   *
   * It cannot be decided while building the map: a materialised primitive is pushed
   * BEFORE the block that owns it, so a single pass meets the shadow before it knows
   * anything references it, and quietly files it as a block of its own.
   */
  const inlined = new Set()
  for (const block of engine.blocks ?? []) {
    for (const input of Object.values(block.inputs ?? {})) {
      const shadowRef = input?.shadow ?? null
      if (shadowRef === null || shadowRef === undefined) continue
      const shadow = source.get(shadowRef)
      // A primitive that is also top-level was dragged onto the canvas in its own
      // right, and belongs in the map with its coordinates.
      if (shadow === undefined || shadow.topLevel === true) continue
      if (isPrimitiveOpcode(shadow.opcode)) inlined.add(shadowRef)
    }
  }

  const inlinePrimitive = (shadowId) => {
    const shadow = source.get(shadowId)
    if (shadow === undefined) return shadowId
    const info = PRIMITIVE_OPCODES[shadow.opcode]
    if (info === undefined) return shadowId
    const [constant, fieldName] = info
    const field = shadow.fields?.[fieldName]
    const value = Array.isArray(field) ? field[0] : field?.value
    const fieldId = Array.isArray(field) ? field[1] : field?.id
    const description = [constant, value === undefined ? '' : value]
    if (typeof fieldId === 'string' && fieldId.length > 0) description.push(fieldId)
    if (shadow.topLevel === true) description.push(shadow.x ?? 0, shadow.y ?? 0)
    return description
  }

  /** A shadow reference: inlined for primitives, an id for anything else. */
  const shadowSide = (shadowId) => {
    if (shadowId === null || shadowId === undefined) return null
    return inlinePrimitive(shadowId)
  }

  const blocks = {}
  for (const block of engine.blocks ?? []) {
    if (inlined.has(block.id)) continue

    // A primitive loose on the canvas is a bare array in the wire form too, with its
    // coordinates in the last two slots.
    if (block.shadow === true && block.topLevel === true && isPrimitiveOpcode(block.opcode)) {
      blocks[block.id] = inlinePrimitive(block.id)
      continue
    }

    const fields = {}
    for (const [name, field] of Object.entries(block.fields ?? {})) {
      const value = Array.isArray(field) ? field[0] : field?.value
      const fieldId = Array.isArray(field) ? field[1] : field?.id
      fields[name] = typeof fieldId === 'string' && fieldId.length > 0
        ? [value === undefined ? '' : value, fieldId]
        : [value === undefined ? '' : value]
    }

    const inputs = {}
    for (const [name, input] of Object.entries(block.inputs ?? {})) {
      const blockRef = input?.block ?? null
      const shadowRef = input?.shadow ?? null
      // A pure shadow has block and shadow pointing at the SAME id: that is how the
      // engine form spells "nothing is plugged in here". Miss this and every
      // primitive comes back as a real block (tag 2) and stays in the block map.
      if (blockRef !== null && shadowRef !== null && blockRef === shadowRef) {
        inputs[name] = [1, shadowSide(shadowRef)]
      } else if (blockRef !== null && shadowRef !== null) {
        inputs[name] = [3, blockRef, shadowSide(shadowRef)]
      } else if (blockRef !== null) {
        inputs[name] = [2, blockRef]
      } else if (shadowRef !== null) {
        inputs[name] = [1, shadowSide(shadowRef)]
      }
    }

    const wire = {
      opcode: block.opcode,
      next: block.next ?? null,
      parent: block.parent ?? null,
      inputs,
      fields,
      shadow: block.shadow === true,
      topLevel: block.topLevel === true
    }
    if (wire.topLevel) {
      wire.x = typeof block.x === 'number' ? block.x : 0
      wire.y = typeof block.y === 'number' ? block.y : 0
    }
    if (block.mutation !== undefined) wire.mutation = { ...block.mutation }
    if (typeof block.comment === 'string') wire.comment = block.comment
    blocks[block.id] = wire
  }

  const topLevelIds = (engine.topLevelIds ?? []).filter((id) => Object.hasOwn(blocks, id))
  return { blocks, topLevelIds }
}

/**
 * Resolve one side of an input to an engine block id, materialising inlined
 * primitives as they are encountered.
 *
 * @param {any} reference a block id string or an inlined primitive array
 * @param {string} parentId owning block
 * @param {() => string} newId id generator
 * @param {Set<string>} knownIds ids present in the fragment
 * @param {any[]} sink engine blocks created so far (materialised primitives are pushed here)
 * @returns {string|null} the engine block id
 */
function resolveRef (reference, parentId, newId, knownIds, sink) {
  if (reference === null || reference === undefined) return null
  if (typeof reference === 'string') {
    if (!knownIds.has(reference)) {
      throw new EngineConversionError(`input of block ${parentId} references unknown block "${reference}"`)
    }
    return reference
  }
  if (Array.isArray(reference)) {
    const block = primitiveToBlock(reference, parentId, newId)
    sink.push(block)
    return block.id
  }
  throw new EngineConversionError(`input of block ${parentId} is neither an id nor a primitive: ${JSON.stringify(reference)}`)
}
