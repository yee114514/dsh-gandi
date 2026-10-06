/**
 * Scratch operations over a live Gandi editor.
 *
 * Every function here is a thin Node-side wrapper around one function executed in
 * the page's main world through CDP. The page-side bodies are the interesting
 * part; the comments on each one record the upstream contract it depends on.
 *
 * Every page source starts with `${vmBootstrapSource()}`. That is not decoration:
 * Gandi has no `window.vm` (see `gandi-vm.mjs`), so the VM has to be resolved inside
 * the page before anything can use it. The bootstrap binds `vm` for the statements
 * that follow.
 *
 * Three hard-won rules are baked in:
 *
 *   1. **Never wait on wall-clock time to make a project progress.** Chromium
 *      throttles a backgrounded renderer's timers hard (measured: ~1s between
 *      ticks instead of 100ms), so a stopped-window bridge would silently stall.
 *      `runSteps` drives `runtime._step()` itself; scratch-vm's timers read
 *      `currentStepTime`, which each step advances by one frame, so N steps is N
 *      frames of PROJECT time — deterministic and focus-independent.
 *   2. **Always request a redraw and force the draw before taking a snapshot.** The
 *      snapshot callback only fires from inside a draw pass, and Gandi's draw pass is
 *      additionally gated on `!document.hidden` — so on a backgrounded window the
 *      app's own loop never draws and the callback would never run.
 *   3. **Never wait inside page source.** A page-side `setTimeout` is throttled to
 *      minutes when the window is in the background; waiting belongs on the Node side.
 */

import { evaluate, isContextDestroyed } from './cdp.mjs'
import { vmBootstrapSource, vmResolverSource, workspaceSource } from './gandi-vm.mjs'
import { isPostableKey, knownKeyNames, toDomKey } from '../scratch/keys.mjs'
import { decompileScripts } from '../scratch/xml.mjs'
import { engineToFragment } from '../scratch/engine.mjs'

/** Raised when the editor is reachable but cannot satisfy an operation. */
export class ScratchOpError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'ScratchOpError'
  }
}

/** A project larger than this is refused rather than shipped over the CDP socket. */
const MAX_TRANSFER_BYTES = 32 * 1024 * 1024

/**
 * Block until the editor has a running VM with at least one target.
 *
 * Tolerates the launch race: the DevTools target appears before the editor
 * document settles, so a poll can be cut short by a navigation. That is retried on
 * the same connection rather than reported as a failure — otherwise a launch that
 * actually worked looks like it did not.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{timeoutMs?: number}} [options] how long to wait
 * @returns {Promise<boolean>} true when the VM is ready
 */
export async function waitForVm (connection, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000
  const settleSamples = options.settleSamples ?? 2
  const deadline = Date.now() + timeoutMs
  let lastSignature = null
  let stable = 0
  for (;;) {
    let signature = null
    try {
      signature = await evaluate(connection, `(() => {
        const vm = ${vmResolverSource()};
        if (vm === null) return null;
        const runtime = vm.runtime;
        if (!Array.isArray(runtime.targets) || runtime.targets.length === 0) return null;
        return runtime.targets.map((target) => target.getName() + ':' + target.getCostumes().length).join(',');
      })()`, { timeoutMs: 20000 })
    } catch (error) {
      if (!isContextDestroyed(error) || Date.now() >= deadline) throw error
      signature = null
    }

    if (typeof signature === 'string' && signature.length > 0) {
      if (signature === lastSignature) {
        stable++
        if (stable >= settleSamples) return true
      } else {
        stable = 0
      }
      lastSignature = signature
    } else {
      stable = 0
      lastSignature = null
    }

    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}

/**
 * Read a compact description of the editor's current state.
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @returns {Promise<any>} targets, editing target and runtime flags
 */
export async function describeState (connection) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n${vmBootstrapSource()}
        const runtime = vm.runtime
    return {
      editingTarget: vm.editingTarget ? { id: vm.editingTarget.id, name: vm.editingTarget.getName() } : null,
      targets: runtime.targets.map((t) => ({
        id: t.id,
        name: t.getName(),
        isStage: t.isStage,
        isOriginal: t.isOriginal,
        visible: t.visible,
        x: t.x,
        y: t.y,
        direction: t.direction,
        size: t.size,
        costumes: t.sprite ? t.sprite.costumes.map((c) => c.name) : [],
        variables: Object.values(t.variables).map((v) => ({ id: v.id, name: v.name, type: v.type, value: v.value })),
        scripts: t.blocks.getScripts().length,
        blocks: Object.keys(t.blocks._blocks).length
      })),
      threads: runtime.threads.length,
      clones: runtime.targets.length - (runtime.targets.filter((t) => t.isOriginal).length)
    }
  })())`)
  return JSON.parse(raw)
}

/**
 * Read the whole project as sb3 project JSON.
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @returns {Promise<any>} the parsed project document
 */
export async function getProjectJson (connection) {
  const json = await evaluate(connection, `(() => {\n${vmBootstrapSource()}\nreturn vm.toJSON()\n})()`, { timeoutMs: 60000 })
  return JSON.parse(json)
}

/**
 * Replace the editor's project wholesale from a JSON document.
 *
 * WARNING: a project document does not carry assets. Costumes and sounds reference
 * them by md5, and if nothing has registered those bytes the costume loader waits
 * for a load that can never finish — the call then dies on a timeout, having
 * already replaced part of the project. Prefer {@link loadProjectBytes} whenever
 * the project has artwork; this path is for documents that have none, or whose
 * assets are already in the runtime's storage.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {any|string} project project document or its JSON text
 * @param {{timeoutMs?: number}} [options] timeout override
 * @returns {Promise<any>} post-load state
 * @throws {Error} with an explanation when the load does not settle
 */
export async function loadProjectJson (connection, project, options = {}) {
  const json = typeof project === 'string' ? project : JSON.stringify(project)
  let raw
  try {
    raw = await evaluate(connection, `(async () => {\n${vmBootstrapSource()}
      await vm.loadProject(${JSON.stringify(json)})
      const runtime = vm.runtime
      return JSON.stringify({
        targets: runtime.targets.map((t) => ({ id: t.id, name: t.getName(), isStage: t.isStage, blocks: Object.keys(t.blocks._blocks).length }))
      })
    })()`, { awaitPromise: true, timeoutMs: options.timeoutMs ?? 30000 })
  } catch (error) {
    if (!/timed out/i.test(String(error.message))) throw error
    // Say what this symptom means. A bare "timed out" sends the reader looking at
    // the bridge, when the real cause is a project whose assets nobody registered.
    throw new Error(
      'loading this project document did not finish: its costumes or sounds reference assets that nothing has registered, ' +
      'so the asset loader waits forever. A project document carries no assets — ' +
      'load the .sb3 archive instead (gandi_open, or gandi_apply with a path), or use a document that has no artwork.',
      { cause: error }
    )
  }
  return JSON.parse(raw)
}

/**
 * Apply a compiled fragment to one sprite without reloading the project.
 *
 * Creates any variables the fragment declares, removes the target's existing
 * top-level scripts when `mode` is `replace`, then creates every block and asks
 * the GUI to rebuild its Blockly workspace from VM state
 * (`vm.emitWorkspaceUpdate()` → `blocks.jsx`'s `onWorkspaceUpdate`, which detaches
 * `vm.blockListener` first, so there is no feedback loop).
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string, blocks: any[], variables?: any[], mode?: 'replace'|'append'}} request engine blocks plus placement
 * @returns {Promise<any>} before/after block counts and the resolved target
 */
export async function applyFragment (connection, request) {
  const mode = request.mode ?? 'replace'
  const raw = await evaluate(connection, `JSON.stringify((() => {\n${vmBootstrapSource()}
        const runtime = vm.runtime
    ${PRUNE_ORPHANS_SOURCE}
    const args = ${JSON.stringify({
      target: request.target ?? null,
      blocks: request.blocks,
      variables: request.variables ?? [],
      comments: request.comments ?? [],
      mode
    })}

    const resolveTarget = () => {
      if (!args.target) return vm.editingTarget || runtime.targets.find((t) => !t.isStage) || runtime.getTargetForStage()
      return runtime.targets.find((t) => t.id === args.target || t.getName() === args.target) || null
    }
    const target = resolveTarget()
    if (target === null) throw new Error('no such sprite: ' + args.target)
    vm.setEditingTarget(target.id)

    // Variables must exist before the blocks that reference them, or Scratch shows
    // an unresolved reporter. Broadcasts always live on the stage; ordinary
    // variables default to global (the Scratch default when a user clicks "Make a
    // Variable") and opt into sprite-locality with scope: 'local'.
    const stage = runtime.getTargetForStage()
    const createdVariables = []
    for (const declaration of args.variables) {
      const wantsStage = declaration.type === 'broadcast_msg' || declaration.scope !== 'local'
      const owner = wantsStage ? stage : target
      if (owner.variables[declaration.id]) continue
      if (typeof owner.createVariable !== 'function') continue
      owner.createVariable(declaration.id, declaration.name, declaration.type || '')
      createdVariables.push(declaration.scope === 'local' ? declaration.name + ' (local)' : declaration.name)
    }

    // Stop first. A live thread holds references into the block graph, and deleting
    // its blocks out from under it makes the runtime throw later ("Tried to glow
    // stack on block that does not exist") at a point far from the actual edit.
    // Editing a running project is not meaningful anyway.
    vm.stopAll()

    const before = Object.keys(target.blocks._blocks).length
    let removed = 0
    if (args.mode === 'replace') {
      // SNAPSHOT the script list before deleting any of it. getScripts() hands back
      // the runtime's own array, and deleteBlock shortens it, so iterating it while
      // deleting skips every second script — silently, and only when a target has
      // more than one, which is why it survived so long.
      for (const scriptId of [...target.blocks.getScripts()]) {
        // deleteBlock cascades through the stack on the runtime side.
        target.blocks.deleteBlock(scriptId)
        removed++
      }
    }

    // Deleting the scripts can leave blocks nothing points at any more. Cleaning
    // them up here is what keeps "replace" from accumulating invisible junk.
    const removedOrphans = args.mode === 'replace' ? pruneOrphans() : 0

    // A comment whose block no longer exists is a note pointing at nothing, which is
    // what a deleted script would leave behind. Checked AFTER the delete rather than
    // predicted before it, because deleteBlock decides for itself what cascades.
    let removedComments = 0
    target.comments = target.comments || {}
    for (const [commentId, comment] of Object.entries({ ...target.comments })) {
      const blockId = comment.blockId
      if (blockId === null || blockId === undefined) continue
      if (target.blocks.getBlock(blockId) === undefined) {
        delete target.comments[commentId]
        removedComments++
      }
    }

    const created = []
    for (const block of args.blocks) {
      target.blocks.createBlock(block)
      created.push(block.id)
    }

    // Comments are target state, not block state, and they must be REAL Comment
    // instances: emitWorkspaceUpdate calls comment.toXML() on every one of them, so
    // a plain object here breaks the editor's workspace sync.
    //
    // Gandi's createComment is (id, blockId, text, x, y, width, height, minimized,
    // isRemoteOperation) and returns nothing — the instance lands in
    // target.comments[id]. So the comment is read back from the map rather than from
    // the call, and isRemoteOperation keeps the runtime from broadcasting an "add"
    // event for a comment the GUI is about to receive anyway through
    // emitWorkspaceUpdate.
    let createdComments = 0
    for (const comment of args.comments) {
      if (typeof target.createComment !== 'function') break
      if (target.comments[comment.id] !== undefined) {
        delete target.comments[comment.id]
      }
      target.createComment(
        comment.id,
        comment.blockId === undefined ? null : comment.blockId,
        comment.text === undefined ? '' : String(comment.text),
        Number.isFinite(comment.x) ? comment.x : 0,
        Number.isFinite(comment.y) ? comment.y : 0,
        Number.isFinite(comment.width) ? comment.width : 200,
        Number.isFinite(comment.height) ? comment.height : 200,
        comment.minimized === true,
        true
      )
      const instance = target.comments[comment.id]
      if (instance !== undefined && comment.blockId !== null && comment.blockId !== undefined) {
        instance.blockId = comment.blockId
      }
      createdComments++
    }

    vm.emitWorkspaceUpdate()

    return {
      target: { id: target.id, name: target.getName() },
      mode: args.mode,
      removedScripts: removed,
      createdBlocks: created.length,
      createdVariables,
      createdComments,
      removedComments,
      removedOrphans,
      blocksBefore: before,
      blocksAfter: Object.keys(target.blocks._blocks).length,
      topLevelScripts: target.blocks.getScripts().length
    }
  })())`, { timeoutMs: 60000 })
  return JSON.parse(raw)
}

/**
 * Delete the target's top-level scripts.
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string}} [request] which sprite; defaults to the editing target
 * @returns {Promise<any>} how many scripts were removed
 */
export async function clearScripts (connection, request = {}) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n${vmBootstrapSource()}
        const runtime = vm.runtime
    const target = ${JSON.stringify(request.target ?? null)}
      ? runtime.targets.find((t) => t.id === ${JSON.stringify(request.target ?? null)} || t.getName() === ${JSON.stringify(request.target ?? null)})
      : (vm.editingTarget || runtime.targets.find((t) => !t.isStage))
    if (!target) throw new Error('no such sprite')
    vm.stopAll()
    let removed = 0
    // Snapshot: getScripts() returns the runtime's live array and deleteBlock shrinks it.
    for (const scriptId of [...target.blocks.getScripts()]) { target.blocks.deleteBlock(scriptId); removed++ }
    vm.emitWorkspaceUpdate()
    return { target: target.getName(), removed, blocksAfter: Object.keys(target.blocks._blocks).length }
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}

/** Resolve after `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Press the green flag and advance the project by `seconds` of project time.
 *
 * The editor's own loop is driven by the renderer's animation frames, which
 * Chromium throttles hard whenever the window is not in the foreground (measured:
 * ~1s between ticks instead of 100ms), so the bridge drives the stepping itself.
 * `runtime._step()` is unaffected by that throttling — it is a plain method call — so
 * this is what makes "run N frames and look" work on a window nobody is watching.
 *
 * Stepping is PACED by default, and that is not cosmetic. `runtime.currentStepTime`
 * is a fixed frame duration (1000/30, runtime.js:345), while the wall clock lives in
 * `runtime._lastStepTime = Date.now()` (runtime.js:469, :2597). Timer-based blocks
 * (`wait 1 seconds`, glide, `ask and wait`) read that wall clock, so bursting N steps
 * as fast as possible makes a one-second wait need thousands of steps. Advancing one
 * frame every `currentStepTime` of REAL time keeps project time and wall time
 * together. Node's timers are the pacer because the page's own are what got
 * throttled in the first place.
 *
 * `mode: 'turbo'` skips the pacing for scripts known to contain no timers; it is
 * faster but will stretch any `wait` block.
 *
 * `events` are page-side statements run at a chosen frame, which is the only honest
 * way to test anything interactive. Two reasons it has to be mid-run rather than
 * before it:
 *
 *   1. `runtime.greenFlag()` calls `stopAll()`, so a key posted before the flag is
 *      discarded along with every thread — a "hold space to move" test written that way
 *      passes on nothing at all.
 *   2. This runtime's `event_whenkeypressed` hat is started by the KEY_PRESSED event,
 *      not polled per frame (Gandi's `scratch3_event.js` listens for it and calls
 *      `startHats`), so the key has to be posted while the project is stepping.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{seconds?: number, stopAfter?: boolean, mode?: 'paced'|'turbo', maxSteps?: number, events?: {atFrame: number, source: string}[]}} [options] run options
 * @returns {Promise<any>} steps taken, threads started/left, and the run duration
 */
export async function runSteps (connection, options = {}) {
  const seconds = options.seconds ?? 1
  const stopAfter = options.stopAfter ?? false
  const mode = options.mode ?? 'paced'
  const maxSteps = options.maxSteps ?? Math.ceil((options.maxSeconds ?? 120) * 30)
  /** Frame index -> page source to run before that frame's step. */
  const events = (options.events ?? []).slice().sort((a, b) => a.atFrame - b.atFrame)
  let fired = 0

  const started = JSON.parse(await evaluate(connection, `JSON.stringify((() => {\n${vmBootstrapSource()}
    
    // Switch script glowing OFF for the duration of a bridge-driven run, and drain
    // the glow bookkeeping it left behind.
    //
    // Glow state is keyed by block id and lives in the UI layer: the runtime emits
    // an event naming a top block and the editor looks that block up. Once scripts
    // have been replaced, a stale id makes that lookup fail, and the editor rejects
    // with the string "Tried to glow stack on block that does not exist" — a message
    // that names neither the block nor the edit responsible, and arrives as a bare
    // promise rejection so it has no stack either. Nobody is watching a headless run
    // animate, so the honest fix is to not request the animation at all.
    vm.__dshGandiGlowFlags = vm.runtime.targets.map((target) => {
      const container = target.blocks
      const previous = container.forceNoGlow
      container.forceNoGlow = true
      return { container, previous }
    })
    for (const staleId of [...(vm.runtime._scriptGlowsPreviousFrame ?? [])]) {
      vm.runtime.quietGlow(staleId)
    }
    for (const thread of vm.runtime.threads) {
      thread.requestScriptGlowInFrame = false
      thread.blockGlowInFrame = null
    }

    vm.greenFlag()
    return {
      stepMs: vm.runtime.currentStepTime,
      startedThreads: vm.runtime.threads.length
    }
  })())`, { timeoutMs: 30000 }))

  const steps = Math.min(maxSteps, Math.ceil((seconds * 1000) / started.stepMs))

  if (mode === 'turbo') {
    await evaluate(connection, `(() => {\n${vmBootstrapSource()}\n${events.map((event) => `{ ${event.source} }`).join('\n')}\nfor (let i = 0; i < ${steps}; i++) vm.runtime._step()\nreturn true\n})()`, { timeoutMs: 120000 })
    fired = events.length
  } else {
    const wallStart = Date.now()
    for (let index = 0; index < steps; index++) {
      while (fired < events.length && events[fired].atFrame <= index) {
        const event = events[fired]
        await evaluate(connection, `(() => {\n${vmBootstrapSource()}\n${event.source}\nreturn true\n})()`, { timeoutMs: 10000 })
        fired++
      }
      await evaluate(connection, `(() => {\n${vmBootstrapSource()}vm.runtime._step();\nreturn true\n})()`, { timeoutMs: 10000 })
      const dueAt = wallStart + (index + 1) * started.stepMs
      const remaining = dueAt - Date.now()
      if (remaining > 0) await sleep(remaining)
    }
  }

  const finished = JSON.parse(await evaluate(connection, `JSON.stringify((() => {\n${vmBootstrapSource()}
        const result = { threadsLeft: vm.runtime.threads.length }
    if (${JSON.stringify(stopAfter)}) { vm.stopAll(); result.stopped = true }
    // Put the glow settings back: they belong to the user's editor, not to the bridge.
    for (const entry of vm.__dshGandiGlowFlags ?? []) entry.container.forceNoGlow = entry.previous
    delete vm.__dshGandiGlowFlags
    return result
  })())`, { timeoutMs: 30000 }))

  return {
    mode,
    stepMs: started.stepMs,
    steps,
    startedThreads: started.startedThreads,
    eventsFired: fired,
    ...finished
  }
}

/**
 * Stop every running script.
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @returns {Promise<boolean>} always true
 */
export async function stopAll (connection) {
  return evaluate(connection, `(() => {\n${vmBootstrapSource()}vm.stopAll();\nreturn true\n})()`, { timeoutMs: 15000 })
}

/**
 * Read runtime observations: target positions, variable values and monitors.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{includeClones?: boolean}} [options] observation options
 * @returns {Promise<any>} the observation snapshot
 */
export async function observe (connection, options = {}) {
  const includeClones = options.includeClones ?? true
  const raw = await evaluate(connection, `JSON.stringify((() => {\n${vmBootstrapSource()}
        const runtime = vm.runtime
    const targets = runtime.targets
      .filter((t) => ${JSON.stringify(includeClones)} || t.isOriginal)
      .map((t) => ({
        name: t.getName(),
        isStage: t.isStage,
        isClone: !t.isOriginal,
        x: t.x, y: t.y,
        direction: t.direction,
        size: t.size,
        visible: t.visible,
        costume: t.sprite && t.sprite.costumes[t.currentCostume] ? t.sprite.costumes[t.currentCostume].name : null,
        costumes: t.sprite ? t.sprite.costumes.map((c) => c.name) : [],
        sounds: t.sprite ? t.sprite.sounds.map((s) => s.name) : [],
        scripts: t.blocks.getScripts().length,
        blocks: Object.keys(t.blocks._blocks).length,
        variables: Object.values(t.variables).map((v) => ({ name: v.name, type: v.type, value: v.value }))
      }))
    // getMonitorState() hands back the monitor RECORD container, not a map of monitor
    // values, and its shape differs between the two editors this bridge speaks to:
    // TurboWarp wraps the records in a plain { map, dirty } object, while Gandi's VM
    // returns an Immutable.js OrderedMap directly. Walking it as a value map produced
    // "undefined undefined = undefined" on one and a list of raw ids on the other, so
    // the values are extracted by trying the accessors each shape offers. It is empty
    // unless the project shows a monitor.
    const monitorRecords = (() => {
      if (typeof runtime.getMonitorState !== 'function') return []
      const container = runtime.getMonitorState()
      if (container === null || typeof container !== 'object') return []
      const raw = typeof container.map === 'object' && container.map !== null ? container.map : container
      let values
      if (raw !== null && typeof raw.values === 'function') {
        // Immutable.js Map/OrderedMap, or a native Map.
        values = [...raw.values()]
      } else if (Array.isArray(raw)) {
        values = raw
      } else {
        values = Object.values(raw)
      }
      return values.slice(0, 30).map((record) => {
        const fields = {
          id: record && record.id !== undefined ? String(record.id) : null,
          opcode: record && record.opcode !== undefined ? String(record.opcode) : null,
          params: record && record.params !== undefined ? record.params : null,
          value: record && record.value !== undefined ? record.value : null,
          visible: record && record.visible !== undefined ? record.visible === true : null,
          mode: record && record.mode !== undefined ? String(record.mode) : null
        }
        if (fields.id !== null || fields.opcode !== null) return fields
        try {
          return { raw: JSON.parse(JSON.stringify(record)) }
        } catch {
          return { raw: String(record) }
        }
      })
    })()
    const projectTimer = runtime.ioDevices && runtime.ioDevices.clock &&
      typeof runtime.ioDevices.clock.projectTimer === 'function'
      ? runtime.ioDevices.clock.projectTimer()
      : null
    return {
      editingTarget: vm.editingTarget ? { id: vm.editingTarget.id, name: vm.editingTarget.getName() } : null,
      targets,
      threads: runtime.threads.length,
      projectTimer,
      monitors: monitorRecords
    }
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}

/**
 * Capture the stage as a PNG data URI.
 *
 * A snapshot is emitted from INSIDE a draw pass, and `RenderWebGL.draw()`
 * short-circuits unless the renderer is dirty (`scratch-render/src/RenderWebGL.js:927-962`).
 * Requesting a redraw is not enough on its own: the draw has to actually happen,
 * and the app's own loop is driven by animation frames that Chromium throttles
 * whenever the window is in the background (observed: the callback never fired
 * within 8s while the editor sat behind another window). So the draw is forced
 * here, which also makes the capture independent of window focus.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{timeoutMs?: number}} [options] capture options
 * @returns {Promise<{dataUri: string, width: number, height: number}>} the capture
 */
export async function screenshot (connection, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000
  const raw = await evaluate(connection, `new Promise((resolve) => {\n${vmBootstrapSource()}
        const renderer = vm.runtime.renderer
    if (!renderer || typeof renderer.requestSnapshot !== 'function') {
      resolve(JSON.stringify({ error: 'this renderer cannot take snapshots' }))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(JSON.stringify({ error: 'snapshot timed out even after forcing a draw' }))
    }, ${timeoutMs})
    renderer.requestSnapshot((uri) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (typeof uri !== 'string') {
        resolve(JSON.stringify({ error: 'snapshot callback received ' + typeof uri }))
        return
      }
      const canvas = renderer.canvas
      resolve(JSON.stringify({ dataUri: uri, width: canvas.width, height: canvas.height }))
    })
    vm.runtime.requestRedraw()
    renderer.dirty = true
    // Force the draw pass that emits the snapshot. The app's own loop would do it
    // eventually, but only while the window is visible.
    renderer.draw()
    // Belt and braces: if this renderer's draw() did not deliver (for example a
    // future version defers to a frame callback), the app's loop still will.
    vm.runtime.requestRedraw()
  })`, { awaitPromise: true, timeoutMs: timeoutMs + 5000 })
  const parsed = JSON.parse(raw)
  if (parsed.error !== undefined) throw new ScratchOpError(parsed.error)
  return parsed
}

/**
 * Feed a keyboard event to the running project.
 *
 * `vm.postIOData('keyboard', {key})` speaks DOM `KeyboardEvent.key` values: `' '`
 * for the spacebar, `'ArrowLeft'`, `'Enter'`. A name longer than one character
 * that is not in scratch-vm's switch list is treated as a modifier and dropped
 * WITHOUT an error (`keyboard.js:96-98`), so the caller's spelling is translated
 * first rather than silently pressing nothing.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{key: string, isDown: boolean}} event key name and state
 * @returns {Promise<{posted: string}|boolean>} what was posted
 */
export async function postKey (connection, event) {
  const domKey = toDomKey(event.key)
  if (domKey.length === 0) {
    throw new ScratchOpError(`"${event.key}" is not a key this can press; try one of ${knownKeyNames().slice(0, 12).join(', ')}, or a single character`)
  }
  await evaluate(connection, `(() => {\n${vmBootstrapSource()}
    vm.postIOData('keyboard', { key: ${JSON.stringify(domKey)}, isDown: ${JSON.stringify(event.isDown)} })
    return true
  })()`, { timeoutMs: 15000 })
  return { posted: domKey }
}

/**
 * Move and/or click the mouse on the stage, in Scratch stage coordinates.
 *
 * `vm.postIOData('mouse', …)` expects CLIENT coordinates relative to the renderer
 * canvas, so the conversion happens in the page where the canvas geometry is known
 * (`scratch-vm/src/io/mouse.js:65-90`).
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{x?: number, y?: number, isDown?: boolean, click?: boolean}} request stage coordinates
 * @returns {Promise<any>} the client coordinates actually posted
 */
export async function postMouse (connection, request) {
  const raw = await evaluate(connection, `(async () => {\n${vmBootstrapSource()}
        const renderer = vm.runtime.renderer
    const canvas = renderer.canvas
    const rect = canvas.getBoundingClientRect()
    const toClient = (stageX, stageY) => ({
      x: (stageX + 240) / 480 * rect.width,
      y: (180 - stageY) / 360 * rect.height
    })
    const point = ${request.x === undefined || request.y === undefined ? 'null' : `toClient(${JSON.stringify(request.x)}, ${JSON.stringify(request.y)})`}
    const send = (isDown) => {
      const payload = { isDown }
      if (point) { payload.x = point.x; payload.y = point.y }
      vm.postIOData('mouse', payload)
    }
    send(${JSON.stringify(request.isDown ?? false)})
    ${request.click === true ? `send(true)
    await new Promise((r) => setTimeout(r, 60))
    send(false)` : ''}
    return JSON.stringify({ posted: point, rect: { width: rect.width, height: rect.height } })
  })()`, { awaitPromise: true, timeoutMs: 20000 })
  return JSON.parse(raw)
}

/**
 * Export the current project as `.sb3` bytes.
 *
 * The bytes are base64-encoded in the page (chunked, to avoid blowing the argument
 * limit of `String.fromCharCode`) and decoded here.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{maxBytes?: number}} [options] size guard
 * @returns {Promise<Buffer>} the archive
 */
export async function exportSb3 (connection, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_TRANSFER_BYTES
  const base64 = await evaluate(connection, `(async () => {\n${vmBootstrapSource()}
    const buffer = await vm.saveProjectSb3('arraybuffer')
    const bytes = new Uint8Array(buffer)
    if (bytes.length > ${JSON.stringify(maxBytes)}) return 'ERROR:too large:' + bytes.length
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  })()`, { awaitPromise: true, timeoutMs: 120000 })

  if (typeof base64 === 'string' && base64.startsWith('ERROR:too large:')) {
    const size = Number(base64.split(':')[2])
    throw new ScratchOpError(`the project is ${size} bytes, over the ${maxBytes}-byte transfer limit; export JSON instead`)
  }
  return Buffer.from(base64, 'base64')
}

/**
 * Replace the editor's project with `.sb3` bytes.
 *
 * `vm.loadProject` accepts an ArrayBuffer and runs it through the real
 * deserializer, assets included — which is the only correct way to open a project
 * that has costumes. The bytes travel as base64 in chunks: a single
 * `Runtime.evaluate` argument holding a multi-megabyte project is fragile, and
 * `String.fromCharCode.apply` on a whole archive would blow the argument limit.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {Uint8Array} bytes the archive
 * @param {{chunkChars?: number, timeoutMs?: number}} [options] transfer options
 * @returns {Promise<any>} post-load target summary
 */
export async function loadProjectBytes (connection, bytes, options = {}) {
  const chunkChars = options.chunkChars ?? 256 * 1024
  const base64 = Buffer.from(bytes).toString('base64')

  await evaluate(connection, '(() => { window.__dshGandiChunks = []; return true })()', { timeoutMs: 10000 })
  for (let offset = 0; offset < base64.length; offset += chunkChars) {
    const chunk = base64.slice(offset, offset + chunkChars)
    await evaluate(connection, `(() => { window.__dshGandiChunks.push(${JSON.stringify(chunk)}); return true })()`, { timeoutMs: 30000 })
  }

  const raw = await evaluate(connection, `(async () => {\n${vmBootstrapSource()}
    const joined = window.__dshGandiChunks.join('')
    delete window.__dshGandiChunks
    const binary = atob(joined)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    await vm.loadProject(bytes.buffer)
    const runtime = vm.runtime
    return JSON.stringify({
      targets: runtime.targets.map((t) => ({
        id: t.id,
        name: t.getName(),
        isStage: t.isStage,
        blocks: Object.keys(t.blocks._blocks).length,
        costumes: t.sprite ? t.sprite.costumes.map((c) => c.name) : []
      }))
    })
  })()`, { awaitPromise: true, timeoutMs: options.timeoutMs ?? 180000 })

  return JSON.parse(raw)
}

/**
 * Resolve a target reference inside the page.
 *
 * Kept in one place so every operation agrees on the fallback order: an explicit
 * name or id, then the editing target, then the first sprite, then the stage.
 */
/**
 * Page-source snippet: delete blocks that nothing points at any more.
 *
 * Deleting a script can leave children behind — a duplicated custom block leaves its
 * argument reporters, for instance. They are invisible in the editor (no script
 * reaches them) but real in the project file, and they accumulate quietly.
 *
 * Expects `target` to be in scope, and defines `pruneOrphans()` which returns the
 * number removed.
 */
const PRUNE_ORPHANS_SOURCE = `
    const pruneOrphans = () => {
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
      let removed = 0
      for (const id of Object.keys({ ...target.blocks._blocks })) {
        if (reachable.has(id)) continue
        target.blocks.deleteBlock(id)
        removed++
      }
      return removed
    }`

/**
 * Shared prologue for page sources that name a target.
 *
 * Declares `vm` (through the bootstrap) and `runtime`, then the two lookups. Keeping
 * `runtime` here rather than at each call site is deliberate: nothing in a page script
 * must be parsed for the source to be valid, and `const runtime = vm.runtime` is
 * harmless wherever else it appears — `vm.runtime` is a plain property read.
 */
const RESOLVE_TARGET_SOURCE = `\n${vmBootstrapSource()}
    const runtime = vm.runtime

    const resolveTarget = (ref) => {
      if (!ref) return vm.editingTarget || runtime.targets.find((t) => !t.isStage) || runtime.getTargetForStage()
      // "stage" is an explicit convention: the stage's own name is not translated,
      // but it also is not "stage", so a case-insensitive literal is what callers
      // can actually remember.
      if (String(ref).toLowerCase() === 'stage') return runtime.getTargetForStage()
      return runtime.targets.find((t) => t.id === ref || t.getName() === ref) || null
    }
    const resolveSprite = (ref) => {
      if (ref && String(ref).toLowerCase() === 'stage') return null
      return ref
        ? runtime.targets.find((t) => (t.id === ref || t.getName() === ref) && !t.isStage) || null
        : runtime.targets.find((t) => !t.isStage) || null
    }`

/**
 * Duplicate a sprite, costumes and all.
 *
 * `duplicateSprite` deep-copies the sprite including its assets, which is the one
 * way to get a working new sprite into a project without uploading artwork — and
 * exactly what a project needs when several actors share a look.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string, name?: string}} request which sprite and what to call the copy
 * @returns {Promise<any>} the new sprite
 */
export async function duplicateSprite (connection, request) {
  // NOTE: the async IIFE returns the JSON text itself. Stringifying the *promise*
  // outside would serialise to "{}" and silently yield an empty result.
  const raw = await evaluate(connection, `(async () => {\n
        ${RESOLVE_TARGET_SOURCE}
    const source = resolveSprite(${JSON.stringify(request.target ?? null)})
    if (source === null) throw new Error('no sprite to duplicate')
    const before = vm.runtime.targets.map((t) => t.id)
    await vm.duplicateSprite(source.id)
    const created = vm.runtime.targets.find((t) => !before.includes(t.id))
    if (!created) throw new Error('duplication produced no new sprite')
    let renamed = created.getName()
    if (${JSON.stringify(request.name ?? null)}) {
      vm.renameSprite(created.id, ${JSON.stringify(request.name ?? null)})
      renamed = created.getName()
    }
    return JSON.stringify({
      source: source.getName(),
      name: renamed,
      id: created.id,
      costumes: created.sprite ? created.sprite.costumes.map((c) => c.name) : [],
      sprites: vm.runtime.targets.filter((t) => !t.isStage).map((t) => t.getName())
    })
  })()`, { awaitPromise: true, timeoutMs: 60000 })
  return JSON.parse(raw)
}

/**
 * Rename or delete a sprite.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target: string, name?: string, delete?: boolean}} request the operation
 * @returns {Promise<any>} the resulting sprite list
 */
export async function editSprite (connection, request) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n
        ${RESOLVE_TARGET_SOURCE}
    const sprite = resolveSprite(${JSON.stringify(request.target)})
    if (sprite === null) throw new Error('no such sprite: ' + ${JSON.stringify(request.target)})
    const name = sprite.getName()
    if (${JSON.stringify(request.delete === true)}) {
      vm.deleteSprite(sprite.id)
    } else if (${JSON.stringify(request.name ?? null)}) {
      vm.renameSprite(sprite.id, ${JSON.stringify(request.name ?? null)})
    } else {
      throw new Error('nothing to do: pass name or delete')
    }
    return { renamedFrom: name, sprites: vm.runtime.targets.filter((t) => !t.isStage).map((t) => t.getName()) }
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}

/**
 * Make a sprite the editor's current target.
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target: string}} request which sprite
 * @returns {Promise<any>} the selected sprite
 */
export async function selectTarget (connection, request) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n
        ${RESOLVE_TARGET_SOURCE}
    const sprite = resolveTarget(${JSON.stringify(request.target)})
    if (sprite === null) throw new Error('no such target: ' + ${JSON.stringify(request.target)})
    vm.setEditingTarget(sprite.id)
    return { selected: sprite.getName(), isStage: sprite.isStage }
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}

/**
 * Add a costume to a sprite, or a backdrop to the stage, from raw bytes.
 *
 * A costume and a backdrop are the same thing to the runtime — the stage is just a
 * target whose costumes are its backdrops — so both go through `loadCostume`. The
 * only difference is which install method to call: `vm.addCostume(md5ext, obj,
 * targetId)` (`virtual-machine.js:944`) or `vm.addBackdrop(md5ext, obj)`
 * (`virtual-machine.js:1303`), the latter of which always targets the stage.
 *
 * The asset type is the MEDIA type, not a "costume" category:
 * `load-costume.js:465-468` resolves `AssetType.ImageVector` for `svg` and
 * `AssetType.ImageBitmap` for everything else, and loads with that. It is read off
 * `runtime.storage.AssetType` — the same place the loader gets it — rather than
 * imported, because this code runs inside the bundled editor where the module
 * object is not on `window`.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string, name: string, dataFormat: string, base64: string, rotationCenterX?: number, rotationCenterY?: number, bitmapResolution?: number}} request the costume or backdrop
 * @returns {Promise<any>} the installed costume
 */
export async function addCostume (connection, request) {
  // The async IIFE returns the JSON text: stringifying the promise outside would
  // serialise to "{}" (see duplicateSprite).
  const raw = await evaluate(connection, `(async () => {\n
    ${RESOLVE_TARGET_SOURCE}
    const target = resolveTarget(${JSON.stringify(request.target ?? null)})
    if (target === null) throw new Error('no such target')

    const binary = atob(${JSON.stringify(request.base64)})
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const storage = runtime.storage
    if (!storage || typeof storage.createAsset !== 'function') throw new Error('this runtime has no asset storage')
    const AssetType = storage.AssetType
    const dataFormat = ${JSON.stringify(request.dataFormat)}
    const assetType = dataFormat === 'svg' ? AssetType.ImageVector : AssetType.ImageBitmap

    // createAsset(assetType, dataFormat, data, id, generateId) — five arguments.
    // With generateId the asset id is the md5 of the data alone; the md5ext Scratch
    // uses everywhere is that id plus the format, and the caller composes it.
    const asset = storage.createAsset(assetType, dataFormat, bytes, null, true)
    const md5ext = asset.assetId + '.' + dataFormat

    const costume = {
      name: ${JSON.stringify(request.name)},
      asset,
      md5ext,
      // The serializer reads the LEGACY property name: sb3.js:451 does
      // 'obj.md5ext = costumeToSerialize.md5', and the deserializer sets both
      // (sb3.js:1074-1076). A costume carrying only 'md5ext' serializes with
      // md5ext undefined, which writes the asset to the archive under a name the
      // project never references.
      md5: md5ext,
      assetId: asset.assetId,
      dataFormat,
      bitmapResolution: ${JSON.stringify(request.bitmapResolution ?? 1)},
      rotationCenterX: ${JSON.stringify(request.rotationCenterX ?? 0)},
      rotationCenterY: ${JSON.stringify(request.rotationCenterY ?? 0)},
      // loadCostume reads this to decide vector vs bitmap handling.
      assetType
    }

    const isStage = target.isStage === true
    if (isStage) {
      await vm.addBackdrop(md5ext, costume)
    } else {
      await vm.addCostume(md5ext, costume, target.id)
    }

    const sprite = target.sprite
    return JSON.stringify({
      target: target.getName(),
      isStage,
      kind: isStage ? 'backdrop' : 'costume',
      costume: costume.name,
      md5ext,
      bytes: bytes.length,
      costumes: sprite ? sprite.costumes.map((c) => c.name) : []
    })
  })()`, { awaitPromise: true, timeoutMs: 60000 })
  return JSON.parse(raw)
}

/**
 * Create, rename, set or delete a variable or list.
 *
 * Variables are ordinary target state: `Target.createVariable(id, name, type)`,
 * `renameVariable(id, name)` and `deleteVariable(id)` (`target.js:271`, `:318`,
 * `:369`). Scope is the meaningful choice — Scratch keeps globals on the stage and
 * sprite-locals on the sprite — and the default here follows Scratch's own default,
 * which is global.
 *
 * Two details are load-bearing, both found by probing a live editor:
 *
 *   1. `createVariable` needs a REAL unique id. Passing null keys the variable
 *      under the literal string "null" while the Variable object carries a
 *      generated id, so a second creation collides on that key and is dropped.
 *   2. rename and delete look the map up BY ID, and the id that works is the map
 *      key — which is not necessarily the object's own `id` field.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{action: 'create'|'set'|'delete'|'rename', name: string, id?: string, newName?: string, value?: string|number, type?: 'scalar'|'list', scope?: 'global'|'local', target?: string}} request the operation
 * @returns {Promise<any>} the resulting variable list
 */
export async function editVariable (connection, request) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n
    ${RESOLVE_TARGET_SOURCE}
    const stage = runtime.getTargetForStage()
    const sprite = resolveSprite(${JSON.stringify(request.target ?? null)})
    const name = ${JSON.stringify(request.name)}
    const type = ${JSON.stringify(request.type === 'list' ? 'list' : '')}
    const wantsLocal = ${JSON.stringify(request.scope === 'local')}
    const owner = wantsLocal && sprite !== null ? sprite : stage
    const describe = (t) => Object.values(t.variables).map((v) => ({ name: v.name, type: v.type, value: v.value, scope: t.isStage ? 'global' : 'local' }))

    const find = () => {
      // Return the MAP KEY alongside the object. They are not always the same:
      // Target.createVariable stores under the id it was given, while the Variable
      // object may carry a different generated id, and rename/delete look the map
      // up by the id they are handed. Deleting by the object's own id therefore
      // silently does nothing for such a variable.
      for (const t of [owner, stage, sprite].filter(Boolean)) {
        for (const [key, variable] of Object.entries(t.variables)) {
          if (variable.name === name) return { target: t, variable, key }
        }
      }
      return null
    }

    const action = ${JSON.stringify(request.action)}
    if (action === 'create') {
      if (find() !== null) throw new Error('a variable named "' + name + '" already exists')
      if (typeof owner.createVariable !== 'function') throw new Error('this target cannot hold variables')
      // An explicit id is required. With a null id scratch-vm keys the variable
      // under the literal string "null", so the next creation collides on that one
      // key and the new variable is silently dropped.
      owner.createVariable(${JSON.stringify(request.id)}, name, type)
    } else if (action === 'set') {
      const hit = find()
      if (hit === null) throw new Error('no variable named "' + name + '"')
      hit.variable.value = ${JSON.stringify(request.value ?? '')}
    } else if (action === 'rename') {
      const hit = find()
      if (hit === null) throw new Error('no variable named "' + name + '"')
      hit.target.renameVariable(hit.key, ${JSON.stringify(request.newName ?? '')})
    } else if (action === 'delete') {
      const hit = find()
      if (hit === null) throw new Error('no variable named "' + name + '"')
      hit.target.deleteVariable(hit.key)
    } else {
      throw new Error('unknown action: ' + action)
    }

    return {
      action,
      name,
      stage: describe(stage),
      sprites: runtime.targets.filter((t) => !t.isStage && t.isOriginal).map((t) => ({ name: t.getName(), variables: describe(t) }))
    }
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}

/**
 * Set a sprite's position, direction, size or visibility directly, without a script.
 *
 * This is the cheap way to place something before a screenshot, and it keeps the
 * runtime state consistent because it goes through the target's own setters.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string, x?: number, y?: number, direction?: number, size?: number, visible?: boolean}} request what to change
 * @returns {Promise<any>} the sprite's state afterwards
 */
export async function setTargetState (connection, request) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n
        ${RESOLVE_TARGET_SOURCE}
    const target = resolveSprite(${JSON.stringify(request.target ?? null)})
    if (target === null) throw new Error('no sprite to change')
    const applied = {}
    if (${JSON.stringify(request.x ?? null)} !== null || ${JSON.stringify(request.y ?? null)} !== null) {
      const x = ${JSON.stringify(request.x ?? null)} !== null ? ${JSON.stringify(request.x ?? null)} : target.x
      const y = ${JSON.stringify(request.y ?? null)} !== null ? ${JSON.stringify(request.y ?? null)} : target.y
      target.setXY(x, y)
      applied.x = x; applied.y = y
    }
    if (${JSON.stringify(request.direction ?? null)} !== null) { target.setDirection(${JSON.stringify(request.direction ?? null)}); applied.direction = target.direction }
    if (${JSON.stringify(request.size ?? null)} !== null) { target.setSize(${JSON.stringify(request.size ?? null)}); applied.size = target.size }
    if (${JSON.stringify(request.visible ?? null)} !== null) { target.setVisible(${JSON.stringify(request.visible ?? null)}); applied.visible = target.visible }
    vm.runtime.requestRedraw()
    return { target: target.getName(), x: target.x, y: target.y, direction: target.direction, size: target.size, visible: target.visible, applied }
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}

/**
 * Read a target's scripts as scratch-blocks XML, comments included.
 *
 * The fragment is read out of the live target — its block map, script order,
 * variables and comments — and rendered by the plugin's OWN decompiler rather than
 * by `Blocks.toXML()`. Two reasons:
 *
 *   - comments live on the target, not in the block graph, and `toXML()` only
 *     renders them when it is handed the comment objects. `emitWorkspaceUpdate` does
 *     that; a bare `toXML()` call does not, and silently drops every note.
 *   - one renderer for the live and the offline path means the XML a caller reads is
 *     the XML `gandi_apply` accepts, whichever way it was produced.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string}} [request] which sprite; defaults to the editing target
 * @returns {Promise<{target: string, fragment: any, xml: string, scripts: number, comments: number}>} the scripts as scratch-blocks XML
 */
export async function getTargetXml (connection, request = {}) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n
    ${RESOLVE_TARGET_SOURCE}
    const ref = ${JSON.stringify(request.target ?? null)}
    const target = resolveTarget(ref)
    if (target === null) throw new Error('no such sprite: ' + ref)

    // The map KEY is the id a field refers to; a Variable object can carry a
    // different generated id, so the key is what belongs in the registry.
    const declarationsOf = (t) => Object.entries(t.variables || {}).map(([id, variable]) => ({
      id,
      name: variable.name,
      type: variable.type || ''
    }))
    const stage = runtime.getTargetForStage()
    const own = declarationsOf(target)
    const globals = target.isStage ? [] : declarationsOf(stage)
    const seen = new Set(own.map((declaration) => declaration.id))
    const variables = own.concat(globals.filter((declaration) => !seen.has(declaration.id)))

    const comments = Object.values(target.comments || {}).map((comment) => ({
      id: comment.id,
      blockId: comment.blockId === undefined ? null : comment.blockId,
      text: comment.text,
      x: comment.x,
      y: comment.y,
      width: comment.width,
      height: comment.height,
      minimized: comment.minimized === true
    }))

    return {
      target: target.getName(),
      fragment: {
        // The live block map is in ENGINE form; the decompiler reads the wire form.
        // Converting here keeps one renderer for both paths.
        engine: {
          blocks: Object.values(target.blocks._blocks),
          topLevelIds: target.blocks.getScripts()
        },
        variables,
        comments
      }
    }
  })())`, { timeoutMs: 60000 })
  const parsed = JSON.parse(raw)
  const wire = engineToFragment(parsed.fragment.engine)
  const fragment = { ...wire, variables: parsed.fragment.variables, comments: parsed.fragment.comments }
  return {
    target: parsed.target,
    fragment,
    xml: decompileScripts(fragment),
    scripts: fragment.topLevelIds.length,
    comments: fragment.comments.length
  }
}

/**
 * Add a sound to a sprite from raw bytes.
 *
 * Upstream contract (`scratch-vm/src/import/load-sound.js:88-105`): the loader reads
 * the LEGACY `sound.md5` property, splits it into md5 and extension, and then
 * prefers `sound.asset` over a storage lookup — so handing over a created asset is
 * enough and nothing has to be registered in storage. It then overwrites
 * `rate`/`sampleCount` from the decoded buffer, so those are advisory.
 *
 * `format` stays the empty string for uncompressed PCM, which is what the sb3
 * serializer writes for a plain WAV.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string, name: string, dataFormat: string, base64: string, rate?: number, sampleCount?: number}} request the sound
 * @returns {Promise<any>} the installed sound
 */
export async function addSound (connection, request) {
  const raw = await evaluate(connection, `(async () => {\n
    ${RESOLVE_TARGET_SOURCE}
    const target = resolveSprite(${JSON.stringify(request.target ?? null)})
    if (target === null) throw new Error('no sprite to add a sound to')

    const binary = atob(${JSON.stringify(request.base64)})
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

    const storage = runtime.storage
    const assetType = storage.AssetType.Sound
    const dataFormat = ${JSON.stringify(request.dataFormat)}
    const asset = storage.createAsset(assetType, dataFormat, bytes, null, true)
    const md5ext = asset.assetId + '.' + dataFormat

    const sound = {
      name: ${JSON.stringify(request.name)},
      asset,
      // The loader reads 'md5'; the serializer writes 'md5ext' from it.
      md5: md5ext,
      md5ext,
      assetId: asset.assetId,
      dataFormat,
      format: '',
      rate: ${JSON.stringify(request.rate ?? 48000)},
      sampleCount: ${JSON.stringify(request.sampleCount ?? 0)}
    }

    await vm.addSound(sound, target.id)
    return JSON.stringify({
      target: target.getName(),
      sound: sound.name,
      md5ext,
      bytes: bytes.length,
      sounds: target.sprite ? target.sprite.sounds.map((s) => s.name) : []
    })
  })()`, { awaitPromise: true, timeoutMs: 60000 })
  return JSON.parse(raw)
}

/**
 * Empty a sprite: remove its scripts and its own variables.
 *
 * Used when building a fresh actor out of a duplicated one. Deleting the scripts
 * cascades through the stack on the runtime side (`Blocks.deleteBlock` walks the
 * tree), and the target's own variables are the sprite-locals — globals live on the
 * stage and are deliberately left alone.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string}} request which sprite
 * @returns {Promise<any>} what was removed
 */
export async function stripSprite (connection, request = {}) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n
        ${RESOLVE_TARGET_SOURCE}
    ${PRUNE_ORPHANS_SOURCE}
    const target = resolveSprite(${JSON.stringify(request.target ?? null)})
    if (target === null) throw new Error('no sprite to strip')
    vm.stopAll()

    let removedScripts = 0
    // Snapshot first: getScripts() returns the runtime's live array, and deleting
    // through it while iterating skips every second script.
    for (const id of [...target.blocks.getScripts()]) {
      target.blocks.deleteBlock(id)
      removedScripts++
    }

    // "Empty" has to mean empty, or the next edit inherits invisible junk.
    const removedOrphans = pruneOrphans()

    let removedVariables = 0
    for (const key of Object.keys({ ...target.variables })) {
      if (typeof target.deleteVariable !== 'function') break
      target.deleteVariable(key)
      removedVariables++
    }
    vm.setEditingTarget(target.id)
    vm.emitWorkspaceUpdate()
    return {
      target: target.getName(),
      removedScripts,
      removedOrphans,
      removedVariables,
      costumes: target.sprite ? target.sprite.costumes.map((c) => c.name) : [],
      blocksAfter: Object.keys(target.blocks._blocks).length
    }
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}

/**
 * Delete every costume of a sprite except one, by name.
 *
 * Deleting from the end keeps the indices of the entries still to check valid, and
 * the keeper is chosen so a target is never left with no costume at all.
 *
 * @param {import('./cdp.mjs').CdpConnection} connection open connection
 * @param {{target?: string, keep: string}} request which costume to keep
 * @returns {Promise<any>} the remaining costumes
 */
export async function keepOnlyCostume (connection, request) {
  const raw = await evaluate(connection, `JSON.stringify((() => {\n
        ${RESOLVE_TARGET_SOURCE}
    const target = resolveSprite(${JSON.stringify(request.target ?? null)})
    if (target === null) throw new Error('no sprite to clean up')
    const keep = ${JSON.stringify(request.keep)}
    const costumes = target.getCostumes()
    if (!costumes.some((costume) => costume.name === keep)) {
      throw new Error('the costume to keep is not on this sprite: ' + keep)
    }
    let removed = 0
    for (let index = costumes.length - 1; index >= 0; index--) {
      if (target.getCostumes()[index].name === keep) continue
      target.deleteCostume(index)
      removed++
    }
    target.setCostume(target.getCostumes().findIndex((costume) => costume.name === keep))
    vm.emitWorkspaceUpdate()
    vm.runtime.requestRedraw()
    return { target: target.getName(), removed, costumes: target.sprite.costumes.map((c) => c.name) }
  })())`, { timeoutMs: 30000 })
  return JSON.parse(raw)
}
