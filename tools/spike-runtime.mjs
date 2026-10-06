/**
 * Decisive diagnostic: are the compiled blocks semantically wrong, or is nothing
 * driving the runtime's step loop?
 *
 * Discriminating experiment: load the compiled script, then call
 * `vm.runtime._step()` BY HAND. If the sprite moves, the compiler is correct and
 * the only open question is who ticks the runtime.
 *
 * Usage: node tools/spike-runtime.mjs [--port 9222]
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { compileScripts } from '../src/scratch/xml.mjs'

const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const port = Number(portFlag === -1 ? (process.env.TW_PORT ?? '9222') : argv[portFlag + 1])

const SCRIPT = `<xml>
  <block type="event_whenflagclicked" id="rtHat" x="48" y="48">
    <next>
      <block type="motion_setx" id="rtSetx">
        <value name="X"><shadow type="math_number" id="rtX"><field name="NUM">100</field></shadow></value>
      </block>
    </next>
  </block>
</xml>`

const report = (label, value) => {
  console.log(`\n=== ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}`)
}

const main = async () => {
  const fragment = compileScripts(SCRIPT)
  const targets = await listTargets(port)
  const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
  const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)

  const setup = await evaluate(connection, `(async () => {
    const vm = window.vm
    window.__rtOriginal = vm.toJSON()
    const project = JSON.parse(window.__rtOriginal)
    const sprite = project.targets.find((t) => !t.isStage)
    sprite.blocks = ${JSON.stringify(fragment.blocks)}
    sprite.x = 0
    await vm.loadProject(JSON.stringify(project))
    const runtime = vm.runtime
    const tickKeys = Object.keys(runtime).filter((k) => /step|interval|raf|redraw|running|timer/i.test(k))
    return JSON.stringify({
      tickKeys: Object.fromEntries(tickKeys.map((k) => [k, typeof runtime[k] === 'object' && runtime[k] !== null ? '<object>' : runtime[k]])),
      hasRequestAnimationFrame: typeof requestAnimationFrame,
      rafPrefix: typeof window.requestAnimationFrame,
      runningFlags: { redrawRequested: runtime.redrawRequested, _redrawRequested: runtime._redrawRequested }
    })
  })()`, { awaitPromise: true, timeoutMs: 30000 })
  report('runtime tick internals', JSON.parse(setup))

  const manual = await evaluate(connection, `(async () => {
    const vm = window.vm
    const runtime = vm.runtime
    const target = runtime.targets.find((t) => !t.isStage)
    target.setXY(0, 0)
    vm.greenFlag()
    const afterFlag = { threads: runtime.threads.length, x: target.x }
    let stepError = null
    let steps = 0
    try {
      for (let i = 0; i < 30; i++) { runtime._step(); steps++ }
    } catch (error) { stepError = String(error && error.message ? error.message : error) }
    const afterManual = { threads: runtime.threads.length, x: target.x }
    vm.stopAll()
    return JSON.stringify({ afterFlag, steps, stepError, afterManual })
  })()`, { awaitPromise: true, timeoutMs: 30000 })
  report('manual runtime._step() x30', JSON.parse(manual))

  // Who drives the loop? Watch the stage position with no manual stepping at all,
  // using a script that changes x every frame.
  const ticking = await evaluate(connection, `(async () => {
    const vm = window.vm
    const runtime = vm.runtime
    const target = runtime.targets.find((t) => !t.isStage)
    target.setXY(0, 0)
    runtime.requestRedraw()
    const samples = []
    const timer = setInterval(() => { samples.push({ t: Date.now(), x: target.x, threads: runtime.threads.length }) }, 100)
    await new Promise((r) => setTimeout(r, 500))
    clearInterval(timer)
    return JSON.stringify({ samples, moved: target.x !== 0 })
  })()`, { awaitPromise: true, timeoutMs: 20000 })
  report('does anything tick on its own?', JSON.parse(ticking))

  const restore = await evaluate(connection, `(async () => {
    await window.vm.loadProject(window.__rtOriginal)
    delete window.__rtOriginal
    return 'ok'
  })()`, { awaitPromise: true, timeoutMs: 30000 })
  report('restore', restore)

  connection.close()
}

main().catch((error) => {
  console.error('runtime probe failed:', error?.stack ?? error)
  process.exitCode = 1
})
