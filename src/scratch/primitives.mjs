/**
 * The sb3 "primitive" block table.
 *
 * A primitive is a shadow block whose entire content the sb3 serializer inlines
 * into its parent's input array as `[primitiveConstant, fieldValue, ...]` instead
 * of emitting it as a separate block object.
 *
 * Source of truth — verified against upstream, do not edit from memory:
 *   scratch-vm (MIT) src/serialization/sb3.js:61-96. The table is part of the sb3
 *   FORMAT rather than of any one editor, and Gandi's fork
 *   (`Gandi-IDE/scratch-vm`, a TurboWarp-VM merge) carries it unchanged.
 *     const MATH_NUM_PRIMITIVE = 4
 *     const POSITIVE_NUM_PRIMITIVE = 5
 *     const WHOLE_NUM_PRIMITIVE = 6
 *     const INTEGER_NUM_PRIMITIVE = 7
 *     const ANGLE_NUM_PRIMITIVE = 8
 *     const COLOR_PICKER_PRIMITIVE = 9
 *     const TEXT_PRIMITIVE = 10
 *     const BROADCAST_PRIMITIVE = 11
 *     const VAR_PRIMITIVE = 12
 *     const LIST_PRIMITIVE = 13
 *     const primitiveOpcodeInfoMap = {
 *       math_number: [4, 'NUM'],
 *       math_positive_number: [5, 'NUM'],
 *       math_whole_number: [6, 'NUM'],
 *       math_integer: [7, 'NUM'],
 *       math_angle: [8, 'NUM'],
 *       colour_picker: [9, 'COLOUR'],
 *       text: [10, 'TEXT'],
 *       event_broadcast_menu: [11, 'BROADCAST_OPTION'],
 *       data_variable: [12, 'VARIABLE'],
 *       data_listcontents: [13, 'LIST']
 *     }
 * and sb3.js:108-129 (serializePrimitiveBlock), which appends the field id for
 * broadcast/variable/list primitives and the block x/y when the primitive is a
 * top-level block of its own.
 */

/** Input array tag meaning "block and shadow are the same, given once". */
export const INPUT_SAME_BLOCK_SHADOW = 1
/** Input array tag meaning "a block with no shadow behind it". */
export const INPUT_BLOCK_NO_SHADOW = 2
/** Input array tag meaning "a block obscuring a distinct shadow". */
export const INPUT_DIFF_BLOCK_SHADOW = 3

/**
 * opcode -> [primitiveConstant, fieldName].
 * @type {Readonly<Record<string, readonly [number, string]>>}
 */
export const PRIMITIVE_OPCODES = Object.freeze({
  math_number: [4, 'NUM'],
  math_positive_number: [5, 'NUM'],
  math_whole_number: [6, 'NUM'],
  math_integer: [7, 'NUM'],
  math_angle: [8, 'NUM'],
  colour_picker: [9, 'COLOUR'],
  text: [10, 'TEXT'],
  event_broadcast_menu: [11, 'BROADCAST_OPTION'],
  data_variable: [12, 'VARIABLE'],
  data_listcontents: [13, 'LIST']
})

/**
 * primitiveConstant -> [opcode, fieldName], for turning an inlined array back
 * into a shadow block.
 * @type {Readonly<Record<number, readonly [string, string]>>}
 */
export const PRIMITIVES_BY_CONSTANT = Object.freeze(Object.fromEntries(
  Object.entries(PRIMITIVE_OPCODES).map(([opcode, [constant, field]]) => [constant, [opcode, field]])
))

/**
 * Whether an opcode serializes as an inlined primitive.
 * @param {string} opcode block opcode
 * @returns {boolean} true when the opcode is a primitive
 */
export const isPrimitiveOpcode = (opcode) => Object.hasOwn(PRIMITIVE_OPCODES, opcode)

/**
 * Primitives that are also DROPDOWN MENUS, which makes them the one place the two
 * roles overlap.
 *
 * Every other menu — a costume, a key, a clone target — is an ordinary `shadow: true`
 * block in the sb3 format, so it is referenced by id and must be spelled with the
 * editor's own opcode. The broadcast menu is the exception: because its value is a
 * broadcast VARIABLE, the format inlines it as `[11, name, id]`, so it is a primitive —
 * and it is still a menu, which is why a broadcast input has to inline rather than
 * materialize.
 *
 * Getting this wrong is what made a delivery's project unopenable: a shadow block whose
 * opcode was not a primitive became a block object in the archive, the deserializer read
 * `opcode.split('_')[0]` as an extension id, and the editor failed with
 * "Extension not found: broadcast".
 *
 * @type {ReadonlySet<string>}
 */
export const PRIMITIVE_MENU_OPCODES = new Set(['event_broadcast_menu'])

/** Variable type string used by scratch-vm for scalar variables. */
export const SCALAR_TYPE = ''
/** Variable type string used by scratch-vm for lists. */
export const LIST_TYPE = 'list'
/** Variable type string used by scratch-vm for broadcast messages. */
export const BROADCAST_TYPE = 'broadcast_msg'
