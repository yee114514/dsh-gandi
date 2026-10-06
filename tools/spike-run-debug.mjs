/**
 * Diagnostic: the compiled script LOADS and RENDERS, but did not execute on
 * greenFlag. Find out why before building anything on top of it.
 *
 * Usage: node tools/spike-run-debug.mjs [--port 9222]
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { compileScripts } from '../src/scratch/xml.mjs'

const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const port = Number(portFlag === -1 ? (process.env.TW_PORT ?? '9222') : argv[portFlag + 1])

const SCRIPT = `<xml>
  <block type="event_whenflagclicked" id="dbgHat" x="48" y="48">
    <next>
      <block type="motion_setx" id="dbgSetx">
        <value name="X"><shadow type="math_number" id="dbgX"><field name="NUM">100</field></shadow></value>
      </block>
    </next>
  </block>
</xml>`

const report = (label, value) => {
  console.log(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}`)
}

const main = async () => {
  const fragment = compileScripts(SCRIPT)
  const targets = await listTargets(port)
  const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
  const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)

  const setup = await evaluate(connection, `(async () => {
    const vm = window.vm
    window.__dbgOriginal = vm.toJSON()
    const project = JSON.parse(window.__dbgOriginal)
    const sprite = project.targets.find((t) => !t.isStage)
    sprite.blocks = ${JSON.stringify(fragment.blocks)}
    sprite.x = 0
    window.__dbgSpriteName = sprite.name
    await vm.loadProject(JSON.stringify(project))
    const target = vm.runtime.targets.find((t) => !t.isStage)
    return JSON.stringify({
      spriteName: target.getName(),
      targetId: target.id,
      isOriginal: target.isOriginal,
      editingTargetId: vm.editingTarget ? vm.editingTarget.id : null,
      blockCount: Object.keys(target.blocks._blocks).length,
      topLevelScripts: target.blocks.getScripts(),
      hatOpcode: target.blocks.getBlock('dbgHat') ? target.blocks.getBlock('dbgHat').opcode : null,
      runtimeStarted: vm.runtime._steppingInterval !== undefined && vm.runtime._steppingInterval !== null,
      threadCount: vm.runtime.threads.length,
      x: target.x
    })
  })()`, { awaitPromise: true, timeoutMs: 30000 })
  report('setup', JSON.parse(setup))

  const attempt = async (label, body) => {
    const out = await evaluate(connection, `(async () => {
      const vm = window.vm
      const target = vm.runtime.targets.find((t) => !t.isStage)
      target.setXY(0, 0)
      ${body}
      const immediate = { threads: vm.runtime.threads.length, x: target.x }
      await new Promise((r) => setTimeout(r, 800))
      const later = { threads: vm.runtime.threads.length, x: target.x }
      vm.stopAll()
      return JSON.stringify({ immediate, later })
    })()`, { awaitPromise: true, timeoutMs: 20000 })
    report(label, JSON.parse(out))
  }

  await attempt('A: vm.greenFlag()', 'vm.greenFlag()')
  await attempt('B: runtime.startHats()', `const started = vm.runtime.startHats('event_whenflagclicked'); window.__dbgStarted = started.length;`)
  await attempt('C: vm.start() then greenFlag()', 'vm.start(); vm.greenFlag()')
  await attempt('D: postIOData keyboard then greenFlag', `vm.postIOData('keyboard', { key: 'x', isDown: true }); vm.greenFlag()`)

  const restore = await evaluate(connection, `(async () => {
    await window.vm.loadProject(window.__dbgOriginal)
    delete window.__dbgOriginal
    return 'ok'
  })()`, { awaitPromise: true, timeoutMs: 30000 })
  report('restore', restore)

  connection.close()
}

main().catch((error) => {
  console.error('debug failed:', error?.stack ?? error)
  process.exitCode = 1
})
