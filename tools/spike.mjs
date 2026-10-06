/**
 * Phase 0 de-risking spike.
 *
 * Answers the three questions the plan refuses to assume, against a real running
 * TurboWarp, and writes the evidence to docs/spike.md's raw log:
 *
 *   0.3 Can CDP evaluate reach `window.vm` (and ScratchBlocks / ReduxStore)?
 *   0.4 Does `blocks.createBlock` + `vm.emitWorkspaceUpdate()` actually make the
 *       editor's Blockly workspace show the new block?
 *   0.5 Does `renderer.requestSnapshot()` return a usable stage PNG?
 *
 * The 0.4 probe creates a block and then deletes it again, so the user's open
 * project is left exactly as it was found.
 *
 * Usage: node tools/spike.mjs [--port 9222] [--out .spike]
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}
const port = Number(argOf('--port', process.env.TW_PORT ?? '9222'))
const outDir = resolve(root, argOf('--out', '.spike'))

const lines = []
/** Record one evidence line to stdout and the report. */
const record = (label, value) => {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value)
  const line = `${label}: ${rendered}`
  lines.push(line)
  console.log(line)
}

/** Decode a `data:image/png;base64,...` URI and read its IHDR dimensions. */
const inspectPng = (dataUri) => {
  const match = /^data:image\/png;base64,(.*)$/s.exec(dataUri)
  if (match === null) return { ok: false, reason: `not a base64 PNG data URI (starts with ${dataUri.slice(0, 24)})` }
  const bytes = Buffer.from(match[1], 'base64')
  const signature = bytes.subarray(0, 8).toString('hex')
  const isPng = signature === '89504e470d0a1a0a'
  return {
    ok: isPng,
    bytes: bytes.length,
    signature,
    width: isPng ? bytes.readUInt32BE(16) : null,
    height: isPng ? bytes.readUInt32BE(20) : null,
    buffer: bytes
  }
}

const main = async () => {
  await mkdir(outDir, { recursive: true })

  // ── 0.3a: find the editor page ────────────────────────────────────────────
  const targets = await listTargets(port)
  record('0.3 targets', targets.map((t) => ({ type: t.type, url: t.url, title: t.title })))
  const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
  if (page === undefined) throw new Error('no tw-editor:// page target found on the debug port')

  const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)
  record('0.3 connected', page.webSocketDebuggerUrl)

  // Capture page errors so a silent failure is visible in the report.
  const consoleErrors = []
  await connection.send('Runtime.enable')
  connection.on('Runtime.exceptionThrown', (params) => {
    consoleErrors.push(params?.exceptionDetails?.exception?.description ?? params?.exceptionDetails?.text ?? 'unknown')
  })
  connection.on('Runtime.consoleAPICalled', (params) => {
    if (params?.type === 'error') {
      consoleErrors.push((params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })

  // ── 0.3b: are the documented globals really reachable? ────────────────────
  const vmReady = await evaluate(connection, `(async () => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (window.vm && window.vm.runtime && Array.isArray(window.vm.runtime.targets) && window.vm.runtime.targets.length > 0) return true
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  })()`, { awaitPromise: true, timeoutMs: 25000 })
  record('0.3 window.vm ready', vmReady)

  const globals = await evaluate(connection, `JSON.stringify({
    vm: typeof window.vm,
    ScratchBlocks: typeof window.ScratchBlocks,
    ReduxStore: typeof window.ReduxStore,
    workspaceDbs: (window.ScratchBlocks && window.ScratchBlocks.Workspace && window.ScratchBlocks.Workspace.WorkspaceDB_)
      ? Object.keys(window.ScratchBlocks.Workspace.WorkspaceDB_).length : null,
    renderer: !!(window.vm && window.vm.runtime && window.vm.runtime.renderer),
    requestSnapshot: typeof (window.vm && window.vm.runtime && window.vm.runtime.renderer && window.vm.runtime.renderer.requestSnapshot),
    canvas: (() => { const c = window.vm && window.vm.runtime && window.vm.runtime.renderer && window.vm.runtime.renderer.canvas; return c ? c.width + 'x' + c.height : null })()
  })`)
  record('0.3 globals', JSON.parse(globals))

  const snapshot = await evaluate(connection, `JSON.stringify({
    editingTarget: window.vm.editingTarget ? { id: window.vm.editingTarget.id, name: window.vm.editingTarget.getName() } : null,
    targets: window.vm.runtime.targets.map((t) => ({ id: t.id, name: t.getName(), isStage: t.isStage, blocks: Object.keys(t.blocks._blocks).length }))
  })`)
  record('0.3 project', JSON.parse(snapshot))

  // ── 0.4: createBlock + emitWorkspaceUpdate ───────────────────────────────
  const probe = await evaluate(connection, `(() => {
    const vm = window.vm
    const SB = window.ScratchBlocks
    const target = vm.editingTarget || vm.runtime.getTargetForStage()
    const workspaceBlocks = () => Object.values(SB.Workspace.WorkspaceDB_)
      .filter((ws) => ws.rendered && !ws.isFlyout)
      .map((ws) => ws.getAllBlocks(false).length)

    const before = { vm: Object.keys(target.blocks._blocks).length, workspaces: workspaceBlocks() }
    const id = 'spike' + Math.random().toString(36).slice(2, 12)
    target.blocks.createBlock({
      id, opcode: 'event_whenflagclicked', next: null, parent: null,
      inputs: {}, fields: {}, shadow: false, topLevel: true, x: 60, y: 60
    })
    vm.emitWorkspaceUpdate()
    const created = { vm: Object.keys(target.blocks._blocks).length, workspaces: workspaceBlocks() }

    target.blocks.deleteBlock(id)
    vm.emitWorkspaceUpdate()
    const afterDelete = { vm: Object.keys(target.blocks._blocks).length, workspaces: workspaceBlocks() }
    return JSON.stringify({ target: target.getName(), blockId: id, before, created, afterDelete })
  })()`, { timeoutMs: 20000 })
  record('0.4 createBlock + emitWorkspaceUpdate', JSON.parse(probe))

  // ── 0.5: stage snapshot ──────────────────────────────────────────────────
  const dataUri = await evaluate(connection, `new Promise((resolve) => {
    const vm = window.vm
    const renderer = vm.runtime.renderer
    if (!renderer || typeof renderer.requestSnapshot !== 'function') {
      resolve('ERROR: renderer.requestSnapshot is unavailable')
      return
    }
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve('ERROR: requestSnapshot timed out even after a redraw request') } }, 8000)
    renderer.requestSnapshot((uri) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(typeof uri === 'string' ? uri : 'ERROR: snapshot callback got ' + typeof uri)
    })
    // A snapshot is emitted from INSIDE a draw pass, and draw() returns
    // immediately unless the renderer is dirty (scratch-render/src/RenderWebGL.js:927-962).
    // A stopped stage never redraws on its own, so the callback would never fire.
    vm.runtime.requestRedraw()
    renderer.dirty = true
  })`, { awaitPromise: true, timeoutMs: 15000 })

  if (typeof dataUri === 'string' && dataUri.startsWith('ERROR')) {
    record('0.5 requestSnapshot', dataUri)
  } else {
    const png = inspectPng(dataUri)
    if (png.ok) {
      const file = join(outDir, 'stage.png')
      await writeFile(file, png.buffer)
      record('0.5 requestSnapshot', { ok: true, bytes: png.bytes, size: `${png.width}x${png.height}`, file })
    } else {
      record('0.5 requestSnapshot', { ok: false, reason: png.reason })
    }
  }

  record('0.3 page errors during spike', consoleErrors.slice(0, 10))

  connection.close()

  await writeFile(join(outDir, 'spike.log'), `${lines.join('\n')}\n`, 'utf8')
  console.log(`\nlog written to ${join(outDir, 'spike.log')}`)
}

main().catch((error) => {
  console.error('spike failed:', error?.stack ?? error)
  process.exitCode = 1
})
