/**
 * Probe: dump the editor's own block dialect — inputs, dropdown shadows and fields.
 *
 * Why this exists: the XML dialect this plugin accepts is defined by the editor, and
 * three separate delivery bugs came from guessing it. A clone-object dropdown written
 * as `looks_costume` compiled clean and silently created no clones; `broadcast_msg`
 * written for the broadcast dropdown became a block with an unknown opcode, which the
 * deserializer reads as an extension (`Extension not found: broadcast`) and the project
 * stopped opening at all. So the dialect is READ OUT of the running editor rather than
 * recalled, and `src/scratch/menus.mjs` is generated from this dump by
 * `tools/gen-block-table.mjs`.
 *
 * The toolbox flyout is the source: it renders one of every block the current project
 * can use, with the default shadows scratch-blocks attaches to its inputs. That is the
 * only place the shadow OPCODE of a dropdown input is visible.
 *
 * Caveat, and the reason the generator refuses to treat the dump as complete: a
 * category whose blocks depend on project state (lists, in particular) only renders
 * once that state exists. The generated table therefore only ever validates what it
 * actually saw — an opcode the dump does not mention is passed through untouched.
 *
 * Read-only: nothing here touches the open project.
 *
 * Usage: node tools/spike-gandi-blocks.mjs [outFile.json]
 */

import { writeFile } from 'node:fs/promises'

import { CdpConnection, evaluate, listTargets } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const outFile = process.argv[2] ?? '.spike/blocks.json'

const editor = (await listTargets(PORT)).find((target) => typeof target.url === 'string' && target.url.includes('/gandi'))
if (!editor) {
  console.log('editor not open')
  process.exit(1)
}
const connection = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const raw = await evaluate(connection, `JSON.stringify((() => {
  const B = globalThis.Blockly
  if (!B || typeof B.getMainWorkspace !== 'function') return { error: 'no Blockly on this page' }
  const workspace = B.getMainWorkspace()
  if (!workspace) return { error: 'no main workspace' }
  const flyout = typeof workspace.getFlyout === 'function' ? workspace.getFlyout() : null
  const flyoutWorkspace = flyout && typeof flyout.getWorkspace === 'function' ? flyout.getWorkspace() : null
  if (!flyoutWorkspace) return { error: 'the workspace has no toolbox flyout' }

  // Only NAMED fields: scratch-blocks' label/image fields carry no name, and an
  // unnamed one would land in the generated table as the string "undefined".
  const fieldInfo = (block) => block.inputList
    .flatMap((row) => row.fieldRow)
    .filter((field) => typeof field.name === 'string' && field.name.length > 0)
    .map((field) => ({ name: field.name, value: String(field.getValue()) }))

  // Blockly.inputs: INPUT_VALUE = 1, INPUT_STATEMENT = 3, INPUT_DUMMY = 5.
  // A connection on a value input accepts values; a statement input takes a stack.
  const VALUE = 1
  const blocks = flyoutWorkspace.getAllBlocks(false).map((block) => ({
    type: block.type,
    fields: fieldInfo(block),
    inputs: block.inputList
      .filter((row) => row.connection && row.type === VALUE)
      .map((row) => {
        const target = row.connection.targetBlock()
        return {
          name: row.name,
          check: typeof row.connection.getCheck === 'function' ? row.connection.getCheck() : null,
          shadow: target === null ? null : { type: target.type, fields: fieldInfo(target) }
        }
      }),
    statements: block.inputList.filter((row) => row.connection && row.type !== VALUE).map((row) => row.name),
    // A block whose inputs are built at runtime (variable/list reporters) declares
    // nothing here; that is how the dump stays honest about what it does not know.
    dynamic: typeof block.dynamicBlockType_ === 'string'
  }))

  return { blocks, blockCount: blocks.length }
})())`, { timeoutMs: 120000 })

const parsed = JSON.parse(raw)
if (parsed.error) {
  console.log('probe failed:', parsed.error)
  process.exit(1)
}
const dump = { source: 'gandi toolbox flyout', blocks: parsed.blocks }
await writeFile(outFile, `${JSON.stringify(dump, null, 1)}\n`, 'utf8')

const opcodes = new Set(parsed.blocks.map((block) => block.type))
console.log(`flyout: ${parsed.blocks.length} blocks, ${opcodes.size} distinct opcodes -> ${outFile}`)

console.log('\nmenu inputs (block.input -> shadow opcode, field) as the editor builds them:')
const menus = new Map()
for (const block of parsed.blocks) {
  for (const input of block.inputs) {
    if (input.shadow === null) continue
    if (!/_menu|costume|backdrops|keyoptions|sounds_menu|touchingobjectmenu|distancetomenu/.test(input.shadow.type)) continue
    menus.set(`${block.type}.${input.name}`, `${input.shadow.type} (field ${input.shadow.fields.map((f) => f.name).join(',') || 'none'})`)
  }
}
for (const [key, value] of [...menus].sort()) console.log(`  ${key.padEnd(44)} ${value}`)

const primitiveLike = new Set(parsed.blocks.filter((block) => block.inputs.every((input) => input.shadow === null)).map((b) => b.type))
console.log(`\nopcodes with no shadowed input (${primitiveLike.size}): ${[...primitiveLike].sort().join(', ')}`)

connection.close()
