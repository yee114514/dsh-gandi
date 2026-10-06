/**
 * Why does duplicating a sprite that has a CUSTOM BLOCK produce a copy with the
 * wrong scripts — and why does the copy's block count disagree with what the
 * decompiler renders?
 *
 * Prints the target's scripts and block count after each step of the sequence the
 * plugin's "create sprite" action performs.
 *
 * Run with: node tools/spike-duplicate.mjs [--port 9222]
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { compileScripts } from '../src/scratch/xml.mjs'
import { fragmentToEngine } from '../src/scratch/engine.mjs'

const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const port = Number(portFlag === -1 ? (process.env.TW_PORT ?? '9222') : argv[portFlag + 1])

const XML = `<xml>
  <block type="procedures_definition" id="probeDef" x="40" y="600">
    <mutation proccode="nudge %n" argumentnames="amount" argumentdefaults="10"></mutation>
    <next>
      <block type="motion_changexby" id="probeBody">
        <value name="DX">
          <block type="argument_reporter_string_number" id="probeReporter">
            <field name="VALUE">amount</field>
          </block>
          <shadow type="math_number"><field name="NUM">10</field></shadow>
        </value>
      </block>
    </next>
  </block>
  <block type="event_whenflagclicked" id="probeHat" x="40" y="420">
    <comment id="probeNote">calls it</comment>
    <next>
      <block type="procedures_call" id="probeCall">
        <mutation proccode="nudge %n"></mutation>
        <value name="amount"><shadow type="math_number"><field name="NUM">77</field></shadow></value>
      </block>
    </next>
  </block>
</xml>`

const targets = await listTargets(port)
const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)

/** Report every target's scripts and total block count. */
const census = async (label) => {
  const raw = await evaluate(connection, `JSON.stringify(window.vm.runtime.targets.map((t) => ({
    name: t.getName(),
    scripts: t.blocks.getScripts(),
    blocks: Object.keys(t.blocks._blocks).length,
    topLevelFlags: Object.entries(t.blocks._blocks)
      .filter(([, b]) => b.topLevel)
      .map(([id, b]) => id + ':' + b.opcode)
  })))`, { timeoutMs: 30000 })
  console.log(`--- ${label}`)
  for (const target of JSON.parse(raw)) {
    console.log(`  ${target.name}: ${target.scripts.length} script(s), ${target.blocks} block(s)`)
    console.log(`    scripts: ${JSON.stringify(target.scripts)}`)
    console.log(`    topLevel: ${JSON.stringify(target.topLevelFlags)}`)
  }
}

await census('before')

// 1. Apply the custom-block script the way the plugin does.
const wire = compileScripts(XML)
const engine = fragmentToEngine(wire)
const applied = await evaluate(connection, `JSON.stringify((() => {
  const vm = window.vm
  const target = vm.runtime.targets.find((t) => !t.isStage)
  vm.setEditingTarget(target.id)
  vm.stopAll()
  for (const id of target.blocks.getScripts()) target.blocks.deleteBlock(id)
  const blocks = ${JSON.stringify(engine.blocks)}
  for (const block of blocks) target.blocks.createBlock(block)
  for (const comment of ${JSON.stringify(engine.comments)}) {
    target.createComment(comment.id, comment.blockId, comment.text, comment.x, comment.y, comment.width, comment.height, comment.minimized)
  }
  vm.emitWorkspaceUpdate()
  return { target: target.getName(), scripts: target.blocks.getScripts().length, blocks: Object.keys(target.blocks._blocks).length }
})())`, { timeoutMs: 30000 })
console.log('applied:', applied)
await census('after apply')

// 1b. Now RUN it. Writing a custom block can succeed while running it fails, because
// only the run resolves the call through getProcedureDefinition and glows the stack.
const ran = await evaluate(connection, `JSON.stringify((() => {
  const vm = window.vm
  const target = vm.runtime.targets.find((t) => t.getName() === 'Sprite1')
  const before = target.x
  try {
    vm.greenFlag()
    for (let i = 0; i < 5; i++) vm.runtime._step()
    vm.runtime.stopAll()
    return { ok: true, movedBy: target.x - before, definition: String(target.blocks.getProcedureDefinition('nudge %n')) }
  } catch (error) {
    return { ok: false, message: String(error && error.message), stack: String(error && error.stack).slice(0, 1500) }
  }
})())`, { timeoutMs: 30000 })
console.log('ran:', ran)

// 2. Duplicate it, exactly as gandi_sprite create does.
const duplicated = await evaluate(connection, `(async () => {
  const vm = window.vm
  const source = vm.runtime.targets.find((t) => !t.isStage)
  const before = vm.runtime.targets.map((t) => t.id)
  await vm.duplicateSprite(source.id)
  const created = vm.runtime.targets.find((t) => !before.includes(t.id))
  if (!created) throw new Error('no new sprite')
  return JSON.stringify({
    source: source.getName(),
    name: created.getName(),
    scripts: created.blocks.getScripts(),
    blocks: Object.keys(created.blocks._blocks).length,
    comments: Object.keys(created.comments || {}).length
  })
})()`, { awaitPromise: true, timeoutMs: 60000 })
console.log('duplicated:', duplicated)
await census('after duplicate')

// 3. Strip it, the way stripSprite does. The SNAPSHOT matters: getScripts() hands
// back the runtime's own array and deleteBlock shortens it, so iterating it directly
// deletes only every second script. That is what this probe was written to find.
const stripped = await evaluate(connection, `JSON.stringify((() => {
  const vm = window.vm
  const target = vm.runtime.targets.find((t) => !t.isStage && t.getName() !== 'Sprite1')
  if (!target) throw new Error('no copy')
  vm.stopAll()
  let removedScripts = 0
  for (const id of [...target.blocks.getScripts()]) { target.blocks.deleteBlock(id); removedScripts++ }

  // Anything nothing points at any more is junk the duplicate left behind.
  const reachable = new Set()
  const walk = (id) => {
    if (typeof id !== 'string' || reachable.has(id)) return
    const block = target.blocks._blocks[id]
    if (block === undefined) return
    reachable.add(id)
    if (typeof block.next === 'string') walk(block.next)
    for (const input of Object.values(block.inputs || {})) {
      if (input === null || typeof input !== 'object') continue
      if (typeof input.block === 'string') walk(input.block)
      if (typeof input.shadow === 'string') walk(input.shadow)
    }
  }
  for (const id of target.blocks.getScripts()) walk(id)
  let removedOrphans = 0
  for (const id of Object.keys({ ...target.blocks._blocks })) {
    if (reachable.has(id)) continue
    target.blocks.deleteBlock(id)
    removedOrphans++
  }

  vm.setEditingTarget(target.id)
  vm.emitWorkspaceUpdate()
  return {
    name: target.getName(),
    removedScripts,
    removedOrphans,
    scriptsAfter: target.blocks.getScripts().length,
    blocksAfter: Object.keys(target.blocks._blocks).length
  }
})())`, { timeoutMs: 30000 })
console.log('stripped:', stripped)
await census('after strip')

connection.close()
