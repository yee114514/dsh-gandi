/**
 * Generate `src/scratch/menus.mjs` from a live dump of the editor's toolbox flyout.
 *
 * The table this writes is the compiler's map of the XML dialect: which inputs a block
 * has, which of them take a dropdown, and which shadow opcode each dropdown is spelled
 * with. It is generated rather than recalled because every guess made about it so far
 * has been wrong in a way that either silently did nothing (a clone dropdown written as
 * `looks_costume`) or stopped the project from opening (a `broadcast_msg` block).
 *
 * Pipeline: `node tools/spike-gandi-blocks.mjs` (needs a running editor) writes
 * `.spike/blocks.json`; this script turns that into the module.
 *
 * Usage: node tools/gen-block-table.mjs [dumpFile] [outFile]
 */

import { readFile, writeFile } from 'node:fs/promises'

import { isPrimitiveOpcode, PRIMITIVE_MENU_OPCODES } from '../src/scratch/primitives.mjs'

const dumpFile = process.argv[2] ?? '.spike/blocks.json'
const outFile = process.argv[3] ?? 'src/scratch/menus.mjs'

const dump = JSON.parse(await readFile(dumpFile, 'utf8'))
if (!Array.isArray(dump.blocks) || dump.blocks.length === 0) {
  throw new Error(`${dumpFile} has no blocks; run tools/spike-gandi-blocks.mjs against a live editor first`)
}

/** opcode -> { value: string[], statement: string[] } */
const inputs = new Map()
/** opcode -> string[] */
const fields = new Map()
/** opcode -> { INPUT: [shadowOpcode, fieldName] } */
const menus = new Map()
/** every shadow opcode that is a dropdown rather than a primitive */
const menuOpcodes = new Set()
const opcodes = new Set()

for (const block of dump.blocks) {
  opcodes.add(block.type)
  const entry = inputs.get(block.type) ?? { value: [], statement: [] }
  for (const input of block.inputs ?? []) {
    if (!entry.value.includes(input.name)) entry.value.push(input.name)
    if (input.shadow === null) continue
    // A dropdown shadow is "a shadow that is not one of the ten primitives the sb3
    // serializer inlines" — that is the format's own line, so it is drawn from the
    // primitive table rather than from a spelling pattern. The broadcast menu is the
    // one primitive that is nevertheless a menu; see PRIMITIVE_MENU_OPCODES.
    if (!isPrimitiveOpcode(input.shadow.type) || PRIMITIVE_MENU_OPCODES.has(input.shadow.type)) {
      const table = menus.get(block.type) ?? {}
      table[input.name] = [input.shadow.type, (input.shadow.fields?.[0]?.name) ?? '']
      menus.set(block.type, table)
      menuOpcodes.add(input.shadow.type)
    }
  }
  for (const name of block.statements ?? []) {
    entry.statement.push(name)
    // A statement input's name is not a value input even though it also has a
    // connection; keep the two lists disjoint.
    entry.value = entry.value.filter((value) => value !== name)
  }
  inputs.set(block.type, entry)

  const fieldNames = (fields.get(block.type) ?? [])
  for (const field of block.fields ?? []) if (!fieldNames.includes(field.name)) fieldNames.push(field.name)
  if (fieldNames.length > 0) fields.set(block.type, fieldNames)
}

const sortedKeys = (map) => [...map.keys()].sort()
const quote = (value) => `'${String(value).replace(/'/g, "\\'")}'`
const blockLines = (map, render) => sortedKeys(map).map((key) => `  ${quote(key)}: ${render(map.get(key))}`).join(',\n')

const module = `/**
 * The XML dialect as the EDITOR spells it: inputs, dropdown shadows and fields.
 *
 * GENERATED FILE — edit \`tools/gen-block-table.mjs\`, not this table.
 * Regenerate with:
 *
 *     node tools/spike-gandi-blocks.mjs      # needs a running editor; writes .spike/blocks.json
 *     node tools/gen-block-table.mjs         # rewrites this file
 *
 * Source: the toolbox flyout of a live Gandi editor, which renders one of every block
 * together with the default shadows scratch-blocks attaches to its inputs. That flyout
 * is the only place a dropdown's shadow OPCODE is visible, and the opcode is what the
 * sb3 deserializer keys on: get it wrong and the block is read as an extension block
 * ("Extension not found: broadcast") and the whole project stops opening. Two delivery
 * bugs came from exactly that — an invented \`broadcast_msg\` shadow, and a clone-object
 * dropdown written as \`looks_costume\`, which compiled clean and silently created no
 * clones at all.
 *
 * Coverage is deliberately partial and honest about it: a category whose blocks depend
 * on project state (lists, most obviously) only renders in the flyout once that state
 * exists, so an opcode missing here is simply NOT VALIDATED rather than assumed wrong.
 * Validation must never reject XML for a block this table has never seen.
 */

/**
 * Value inputs per opcode, from the editor's own block definitions.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const BLOCK_VALUE_INPUTS = Object.freeze({
${blockLines(inputs, (entry) => `[${entry.value.map(quote).join(', ')}]`)}
})

/**
 * Statement (C-block body) inputs per opcode. A \`<statement>\` belongs on one of these
 * and a \`<value>\` does not.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const BLOCK_STATEMENT_INPUTS = Object.freeze({
${blockLines(inputs, (entry) => `[${entry.statement.map(quote).join(', ')}]`)}
})

/**
 * Pure dropdown FIELDS per opcode — the ones written as \`<field>\`, not \`<value><shadow>\`.
 * Confusing the two is silent: the field is simply never read.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const BLOCK_FIELDS = Object.freeze({
${blockLines(fields, (names) => `[${names.map(quote).join(', ')}]`)}
})

/**
 * opcode -> input name -> [shadow opcode, field name] for every dropdown input the
 * editor showed. A shadow of any other type on one of these inputs is the bug class
 * that produces a project nobody can open.
 * @type {Readonly<Record<string, Readonly<Record<string, readonly [string, string]>>>>}
 */
export const MENU_SHADOWS = Object.freeze({
${blockLines(menus, (table) => `Object.freeze({ ${Object.entries(table).sort().map(([input, [shadow, field]]) => `${quote(input)}: [${quote(shadow)}, ${quote(field)}]`).join(', ')} })`)}
})

/**
 * Every opcode that is a dropdown menu block rather than a primitive.
 *
 * A menu is a real \`shadow: true\` block in the sb3 format, so it may only appear where
 * the block that owns it expects one: \`looks_costume\` under \`CLONE_OPTION\` is a block
 * the runtime will never read, which is how "create clone of" stopped cloning anything.
 * @type {ReadonlySet<string>}
 */
export const MENU_OPCODES = new Set([${[...menuOpcodes].sort().map(quote).join(', ')}])

/**
 * Every opcode the dump saw. Used to tell "a core block I know" from "something else,
 * possibly an extension block I must not judge".
 * @type {ReadonlySet<string>}
 */
export const CORE_OPCODES = new Set([${[...opcodes].sort().map(quote).join(', ')}])
`

await writeFile(outFile, module, 'utf8')
console.log(`wrote ${outFile}: ${inputs.size} opcodes, ${menus.size} with dropdown inputs, ${menuOpcodes.size} menu opcodes, ${fields.size} with fields`)
