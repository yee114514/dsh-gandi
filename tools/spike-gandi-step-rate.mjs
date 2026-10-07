/**
 * Probe: who advances the runtime, and how often?
 *
 * The authoring skill used to say "30 fps fixed stepping". A delivery measured its
 * project's own frame counter reading ~1.85x the number of frames `gandi_run` reported
 * and concluded the real rate is ~60 fps, so it retuned every physics constant for a
 * doubled step rate. The other explanation is that the editor's OWN loop keeps stepping
 * while the bridge also calls `runtime._step()` by hand — which would make the effective
 * rate depend on whether the Gandi window is in the foreground, and would make a
 * bridge-driven run unreproducible.
 *
 * This probe settles it against a live editor:
 *
 *   1. is the editor's own loop armed, and what drives it?
 *   2. with it running, how many `_step` calls happen while the bridge forces N of them?
 *   3. with it paused, is the count exactly N?
 *   4. does the editor's loop come back afterwards?
 *
 * `--front` brings the Gandi window to the foreground first, which is what makes the
 * difference visible at all: a background window's animation frames do not fire.
 *
 * `_step` is wrapped for the duration, and the loop is left exactly as it was found. The
 * open project is not modified. Usage: node tools/spike-gandi-step-rate.mjs [--front]
 */

import { CdpConnection, evaluate, listTargets } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const FORCED = 30
const FRAME_MS = 1000 / 30
const bringToFront = process.argv.includes('--front')

const editor = (await listTargets(PORT)).find((target) => typeof target.url === 'string' && target.url.includes('/gandi'))
if (!editor) {
  console.log('editor not open')
  process.exit(1)
}
const connection = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const VM = `(() => {
  if (globalThis.__dshSpikeVm && globalThis.__dshSpikeVm.runtime) return globalThis.__dshSpikeVm
  const root = document.getElementById('root')
  const entry = Object.keys(root).find((k) => k.startsWith('__reactContainer'))
  let found = null
  const seen = new Set()
  const walk = (f, depth) => {
    if (!f || found || depth > 100 || seen.has(f)) return
    seen.add(f)
    const p = f.memoizedProps
    if (p && p.vm && p.vm.runtime && typeof p.vm.greenFlag === 'function') { found = p.vm; return }
    walk(f.child, depth + 1); walk(f.sibling, depth)
  }
  walk(root[entry], 0)
  globalThis.__dshSpikeVm = found
  return found
})()`

const page = (body) => `JSON.stringify((() => {\nconst vm = ${VM}\nif (vm === null) throw new Error('no vm')\nconst rt = vm.runtime\n${body}\n})())`

/**
 * Page-side helpers, installed once: a `_step` counter and the two ways this runtime can
 * drive itself (Gandi uses a `frameLoop`; a stock scratch-vm uses `_steppingInterval`).
 */
const HELPERS = `
  const loopState = () => {
    const frame = rt.frameLoop
    const interval = rt._steppingInterval
    if (frame !== undefined && frame !== null) return { kind: 'frameLoop', running: frame.running === true, handle: frame }
    if (interval !== undefined && interval !== null) return { kind: 'setInterval', running: true, handle: interval }
    return { kind: 'none', running: false, handle: null }
  }
  const loopPause = () => {
    const frame = rt.frameLoop
    if (frame !== undefined && frame !== null) {
      if (frame.running === true) { frame.stop(); return true }
      return false
    }
    if (rt._steppingInterval !== undefined && rt._steppingInterval !== null) {
      clearInterval(rt._steppingInterval); rt._steppingInterval = null; return true
    }
    return false
  }
  const loopResume = () => { rt.start(); return loopState().running }`

const state = JSON.parse(await evaluate(connection, page(`
  ${HELPERS}
  const loop = loopState()
  return {
    stepTime: rt.currentStepTime,
    loop: loop.kind + (loop.running ? ' (running)' : ' (idle)'),
    frameLoopType: rt.frameLoop === undefined || rt.frameLoop === null ? null : rt.frameLoop.constructor.name,
    frameLoopMethods: rt.frameLoop === undefined || rt.frameLoop === null
      ? null
      : Object.getOwnPropertyNames(Object.getPrototypeOf(rt.frameLoop)),
    hidden: document.hidden,
    stepSource: String(rt._step).slice(0, 260),
    startSource: String(rt.start).slice(0, 320)
  }`), { timeoutMs: 30000 }))
console.log('editor loop:', state.loop)
console.log('frameLoop:', state.frameLoopType, state.frameLoopMethods ? `methods: ${state.frameLoopMethods.join(', ')}` : '')
console.log('document.hidden:', state.hidden, bringToFront ? '(bringing to front)' : '(pass --front to test the foreground case)')
console.log('\nruntime.start source:\n  ' + state.startSource.replace(/\n/g, '\n  '))

if (bringToFront) {
  await connection.send('Page.bringToFront', {}, { timeoutMs: 10000 }).catch((error) => console.log('bringToFront failed:', error.message))
  // Poll from Node: the page's own timers are exactly what is throttled here.
  for (let attempt = 0; attempt < 40; attempt++) {
    const hidden = await evaluate(connection, 'document.hidden', { timeoutMs: 10000 })
    if (hidden === false) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  console.log('document.hidden now:', await evaluate(connection, 'document.hidden', { timeoutMs: 10000 }))
}

await evaluate(connection, page(`
  if (!globalThis.__dshSpikeInstalled) {
    globalThis.__dshSpikeInstalled = true
    globalThis.__dshSpikeSteps = []
    globalThis.__dshSpikeOriginalStep = rt._step
    rt._step = function () { globalThis.__dshSpikeSteps.push(Date.now()); return globalThis.__dshSpikeOriginalStep.apply(this, arguments) }
  }
  return true`), { timeoutMs: 30000 })

/** Drive N forced steps from Node, one per frame of real time — exactly what `runSteps` does. */
const drive = async (label) => {
  const before = Number(await evaluate(connection, 'globalThis.__dshSpikeSteps.length', { timeoutMs: 15000 }))
  await evaluate(connection, page('vm.greenFlag(); return true'), { timeoutMs: 30000 })
  const wallStart = Date.now()
  for (let index = 0; index < FORCED; index++) {
    await evaluate(connection, page('rt._step(); return true'), { timeoutMs: 15000 })
    const remaining = wallStart + (index + 1) * FRAME_MS - Date.now()
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining))
  }
  const elapsed = Date.now() - wallStart
  const total = Number(await evaluate(connection, 'globalThis.__dshSpikeSteps.length', { timeoutMs: 15000 })) - before
  console.log(`${label}: forced ${FORCED} steps in ${elapsed}ms; the runtime stepped ${total} time(s)` +
    ` (${(total / (elapsed / 1000)).toFixed(1)}/s, ${(total / FORCED).toFixed(2)}x the bridge frames)`)
  return total
}

const wasRunning = state.loop.includes('(running)')
if (!wasRunning) {
  await evaluate(connection, page(`${HELPERS}\n  rt.start(); return loopState().running`), { timeoutMs: 30000 })
  console.log('\narmed the editor loop with runtime.start() to reproduce the reported condition')
}

await drive('loop running')
await evaluate(connection, page(`${HELPERS}\n  return loopPause()`), { timeoutMs: 30000 })
await drive('loop paused ')
const restored = await evaluate(connection, page(`${HELPERS}\n  loopResume(); return loopState().kind + (loopState().running ? ' (running)' : ' (idle)')`), { timeoutMs: 30000 })
if (!wasRunning) await evaluate(connection, page(`${HELPERS}\n  loopPause(); return true`), { timeoutMs: 30000 })
console.log('editor loop restored to:', wasRunning ? restored : 'idle (as found)')

connection.close()
