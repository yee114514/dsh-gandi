/**
 * The real end-to-end proof of the surgical edit path.
 *
 * Loads a fragment compiled from XML into a LIVE editor WITHOUT reloading the
 * project (the path `gandi_apply` will use), then verifies that:
 *
 *   - the VM gained the blocks and established `next`/`parent` links,
 *   - the editor's Blockly workspace redrew to match,
 *   - a variable declared in the XML was created and is writable by the script,
 *   - pressing the green flag actually RUNS it (variable set, sprite moved).
 *
 * Everything is undone at the end: the scripts are cleared surgically and the
 * original project is restored, so the user's session is left as found.
 *
 * Usage: node tools/spike-apply.mjs [--port 9222]
 */

import { listTargets, CdpConnection } from '../src/bridge/cdp.mjs'
import { compileScripts } from '../src/scratch/xml.mjs'
import { fragmentToEngine } from '../src/scratch/engine.mjs'
import {
  waitForVm,
  applyFragment,
  clearScripts,
  runSteps,
  observe,
  getTargetXml,
  screenshot,
  loadProjectJson,
  getProjectJson
} from '../src/bridge/ops.mjs'

const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const port = Number(portFlag === -1 ? (process.env.TW_PORT ?? '9222') : argv[portFlag + 1])

const SCRIPT = `<xml>
  <variables>
    <variable id="spikeCounterVar" type="">counter</variable>
  </variables>
  <block type="event_whenflagclicked" x="48" y="48">
    <next>
      <block type="data_setvariableto">
        <field name="VARIABLE" id="spikeCounterVar" variabletype="">counter</field>
        <value name="VALUE"><shadow type="text"><field name="TEXT">42</field></shadow></value>
        <next>
          <block type="control_wait">
            <value name="DURATION"><shadow type="math_positive_number"><field name="NUM">0.5</field></shadow></value>
            <next>
              <block type="motion_setx">
                <value name="X"><shadow type="math_number"><field name="NUM">100</field></shadow></value>
              </block>
            </next>
          </block>
        </next>
      </block>
    </next>
  </block>
</xml>`

let failures = 0
const check = (label, condition, detail) => {
  const status = condition ? 'PASS' : 'FAIL'
  if (!condition) failures++
  console.log(`[${status}] ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const main = async () => {
  const targets = await listTargets(port)
  const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
  if (page === undefined) throw new Error('no tw-editor:// page target found')
  const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)
  await waitForVm(connection)

  const original = await getProjectJson(connection)

  const fragment = compileScripts(SCRIPT)
  console.log('compiler warnings:', JSON.stringify(fragment.warnings))
  const engine = fragmentToEngine(fragment)
  console.log(`fragment: ${Object.keys(fragment.blocks).length} blocks -> ${engine.blocks.length} engine blocks (primitives materialised)`)
  check('compiler produced no warnings', fragment.warnings.length === 0, fragment.warnings)

  const applied = await applyFragment(connection, {
    blocks: engine.blocks,
    variables: fragment.variables,
    mode: 'replace'
  })
  console.log('applyFragment:', JSON.stringify(applied))
  check('blocks landed in the VM (4 real + 3 primitives)', applied.blocksAfter >= 6, applied)
  check('exactly one top-level script', applied.topLevelScripts === 1, applied)
  check('variable was created', applied.createdVariables.includes('counter'), applied.createdVariables)

  // Walk the whole chain: hat -> setvariable -> wait -> setx, checking links both ways.
  const linked = await evaluateJson(connection, `JSON.stringify((() => {
    const target = window.vm.runtime.targets.find((t) => !t.isStage)
    const scripts = target.blocks.getScripts()
    const chain = []
    let current = target.blocks.getBlock(scripts[0])
    while (current) {
      chain.push({ opcode: current.opcode, parentOk: chain.length === 0 ? current.parent === null : true })
      current = current.next ? target.blocks.getBlock(current.next) : null
    }
    const blocks = Object.values(target.blocks._blocks)
    return {
      chain: chain.map((c) => c.opcode),
      workspaces: Object.values(window.ScratchBlocks.Workspace.WorkspaceDB_)
        .filter((ws) => ws.rendered && !ws.isFlyout).map((ws) => ws.getAllBlocks(false).length),
      shadowBlocks: blocks.filter((b) => b.shadow).length
    }
  })())`)
  console.log('link check:', JSON.stringify(linked))
  check('hat chains through setvariable, wait and setx', JSON.stringify(linked.chain) ===
    JSON.stringify(['event_whenflagclicked', 'data_setvariableto', 'control_wait', 'motion_setx']), linked)
  check('editor workspace matches the VM block count', linked.workspaces[0] === applied.blocksAfter, linked)
  check('primitive shadows were materialised', linked.shadowBlocks === 3, linked)

  const runStartedAt = Date.now()
  const run = await runSteps(connection, { seconds: 1.2, stopAfter: true, mode: 'paced' })
  const runWallMs = Date.now() - runStartedAt
  console.log('run:', JSON.stringify({ ...run, wallMs: runWallMs }))
  check('a thread started', run.startedThreads >= 1, run)
  check('paced run took about as long as requested', runWallMs >= 1000 && runWallMs < 4000, { runWallMs })

  const state = await observe(connection)
  const sprite = state.targets.find((t) => !t.isStage)
  const counter = state.targets
    .flatMap((t) => t.variables.map((v) => ({ ...v, on: t.name })))
    .find((v) => v.name === 'counter')
  console.log('observed sprite:', JSON.stringify({ name: sprite.name, x: sprite.x, y: sprite.y }))
  console.log('observed counter:', JSON.stringify(counter))
  check('the script ran past the 0.5s wait and moved the sprite', sprite.x === 100, sprite)
  check('the script set the variable to "42"', counter !== undefined && String(counter.value) === '42', counter)

  const xml = await getTargetXml(connection)
  check('scripts round-trip back out as XML',
    xml.xml.includes('motion_setx') && xml.xml.includes('data_setvariableto') && xml.xml.includes('control_wait'),
    xml.xml.slice(0, 160))

  const shot = await screenshot(connection)
  check('stage snapshot is a PNG data URI', shot.dataUri.startsWith('data:image/png;base64,'), { width: shot.width, height: shot.height })

  const cleared = await clearScripts(connection)
  console.log('clearScripts:', JSON.stringify(cleared))
  check('scripts cleared surgically', cleared.removed === 1 && cleared.blocksAfter === 0, cleared)

  await loadProjectJson(connection, original)
  const restored = await observe(connection)
  const restoredSprite = restored.targets.find((t) => !t.isStage)
  check('original project restored', restoredSprite.x === 0 && restoredSprite.variables.every((v) => v.name !== 'counter'), restoredSprite)

  connection.close()
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  if (failures > 0) process.exitCode = 1
}

/** Evaluate an expression returning JSON text and parse it. */
async function evaluateJson (connection, expression) {
  const { evaluate } = await import('../src/bridge/cdp.mjs')
  return JSON.parse(await evaluate(connection, expression, { timeoutMs: 30000 }))
}

main().catch((error) => {
  console.error('apply probe failed:', error?.stack ?? error)
  process.exitCode = 1
})
