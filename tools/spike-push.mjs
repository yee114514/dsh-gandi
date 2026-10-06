/**
 * Phase 0/1 integration probe: does the compiler's output actually RUN?
 *
 * Unit tests prove the compiled block graph has the right *shape*; only a real VM
 * proves it has the right *meaning*. This script:
 *
 *   1. snapshots the project currently open in TurboWarp,
 *   2. compiles a tiny script from XML with the plugin's own compiler,
 *   3. splices the compiled blocks into the snapshot and pushes it back with
 *      `vm.loadProject()` — the same payload shape a `.sb3` carries,
 *   4. confirms the VM and the editor's Blockly workspace both see the blocks,
 *   5. presses the green flag and checks the sprite actually MOVED,
 *   6. restores the original project.
 *
 * Step 5 is the point: a wrong input name (`X` vs `SET_X`) still produces a
 * well-formed block that loads cleanly, and only the motion assertion catches it.
 *
 * Usage: node tools/spike-push.mjs [--port 9222]
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { compileScripts } from '../src/scratch/xml.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
void root

const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const port = Number(portFlag === -1 ? (process.env.TW_PORT ?? '9222') : argv[portFlag + 1])

const SCRIPT = `<xml>
  <block type="event_whenflagclicked" id="spikeHat" x="48" y="48">
    <next>
      <block type="motion_setx" id="spikeSetx">
        <value name="X">
          <shadow type="math_number" id="spikeCoord"><field name="NUM">100</field></shadow>
        </value>
      </block>
    </next>
  </block>
</xml>`

const report = (label, value) => {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

const main = async () => {
  const fragment = compileScripts(SCRIPT)
  report('compiled blocks', fragment.blocks)
  if (fragment.warnings.length > 0) report('compiler warnings', fragment.warnings)

  const targets = await listTargets(port)
  const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
  if (page === undefined) throw new Error('no tw-editor:// page target found')
  const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)

  // Step 1+3: snapshot, splice, push — all inside the page so the project JSON
  // never crosses the wire twice.
  const pushed = await evaluate(connection, `(async () => {
    const vm = window.vm
    const SB = window.ScratchBlocks
    const original = vm.toJSON()
    const project = JSON.parse(original)
    const sprite = project.targets.find((t) => !t.isStage)
    if (!sprite) throw new Error('project has no sprite to test against')
    sprite.blocks = ${JSON.stringify(fragment.blocks)}
    sprite.x = 0
    sprite.y = 0
    window.__spikeOriginal = original
    await vm.loadProject(JSON.stringify(project))
    const target = vm.runtime.targets.find((t) => !t.isStage)
    const workspaceBlocks = Object.values(SB.Workspace.WorkspaceDB_)
      .filter((ws) => ws.rendered && !ws.isFlyout)
      .map((ws) => ws.getAllBlocks(false).length)
    return JSON.stringify({
      targetName: target.getName(),
      vmBlocks: Object.keys(target.blocks._blocks).length,
      vmBlockIds: Object.keys(target.blocks._blocks),
      firstBlockInputs: Object.fromEntries(Object.entries(target.blocks.getBlock('spikeSetx').inputs)
        .map(([k, v]) => [k, { name: v.name, block: v.block, shadow: v.shadow }])),
      xBefore: target.x,
      workspaceBlocks
    })
  })()`, { awaitPromise: true, timeoutMs: 30000 })
  report('after loadProject', JSON.parse(pushed))

  // Step 5: green flag, then DRIVE THE RUNTIME BY HAND.
  //
  // TurboWarp's own step loop is driven from the renderer's animation frames, and
  // Chromium throttles those hard whenever the window is not in the foreground —
  // observed here as timers firing ~1s apart instead of every 100ms. A bridge that
  // waits on wall-clock time therefore hangs exactly when the user is looking at
  // something else. Stepping explicitly is both immune to that and deterministic:
  // scratch-vm's timers advance by `currentStepTime`, which `_step()` increments by
  // one frame interval, so N steps means N frames of PROJECT time.
  const afterRun = await evaluate(connection, `(async () => {
    const vm = window.vm
    const runtime = vm.runtime
    const target = runtime.targets.find((t) => !t.isStage)
    const seconds = 0.5
    const steps = Math.ceil(seconds * 1000 / runtime.currentStepTime)
    vm.greenFlag()
    const startedThreads = runtime.threads.length
    for (let i = 0; i < steps; i++) runtime._step()
    const x = target.x
    const threadsLeft = runtime.threads.length
    vm.stopAll()
    return JSON.stringify({ steps, startedThreads, threadsLeft, xAfterRun: x })
  })()`, { awaitPromise: true, timeoutMs: 20000 })
  report('after greenFlag + manual stepping', JSON.parse(afterRun))

  // Step 6: put the user's project back exactly as it was.
  const restored = await evaluate(connection, `(async () => {
    await window.vm.loadProject(window.__spikeOriginal)
    delete window.__spikeOriginal
    const target = window.vm.runtime.targets.find((t) => !t.isStage)
    return JSON.stringify({ restoredBlocks: Object.keys(target.blocks._blocks).length, x: target.x })
  })()`, { awaitPromise: true, timeoutMs: 30000 })
  report('restored original project', JSON.parse(restored))

  connection.close()

  const x = JSON.parse(afterRun).xAfterRun
  if (x !== 100) {
    console.error(`\nFAIL: expected the sprite x to be 100 after running, got ${x}`)
    process.exitCode = 1
  } else {
    console.log('\nPASS: compiled XML loaded, rendered, and executed correctly (sprite x = 100)')
  }
}

main().catch((error) => {
  console.error('probe failed:', error?.stack ?? error)
  process.exitCode = 1
})
