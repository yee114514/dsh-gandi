/**
 * Reset the editor to a plain project: no scripts, no test variables, no test
 * costumes, and sprites back at their defaults.
 *
 * Test runs leave things behind — in particular a run that fails partway never
 * reaches its own restore step, and the e2e snapshots whatever it finds. Without
 * this, leftovers accumulate across runs and assertions start depending on history
 * (a costume name gets a "2" suffix, a variable already exists, and so on).
 *
 * `--reset` goes further and loads a brand-new project built from scratch. That is
 * the only way to recover from a project whose costumes reference assets nothing
 * registered: such a project cannot be exported faithfully, and no amount of
 * deleting scripts and costumes repairs it. Loading the replacement as ARCHIVE BYTES
 * is what carries the assets along — a JSON load of the same document hangs in the
 * costume loader instead.
 *
 * The e2e deletes its own output directory, so this lives in tools/ rather than
 * beside the e2e's artifacts.
 *
 * Run with: node tools/cleanup-editor.mjs [--port 9222] [--reset]
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { starterProject, writeSb3 } from '../src/scratch/sb3.mjs'

/** Backups must outlive the run that made them, so NOT under .e2e/ — the e2e wipes that. */
const here = dirname(fileURLToPath(import.meta.url))
const backupDir = join(resolve(here, '..'), 'backups')

const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const port = Number(portFlag === -1 ? (process.env.TW_PORT ?? '9222') : argv[portFlag + 1])
const reset = argv.includes('--reset')

const targets = await listTargets(port)
const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
if (page === undefined) throw new Error('no tw-editor:// page target found')
const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)

/**
 * Save whatever is open before touching it.
 *
 * This script edits whichever editor holds the debug port, and it has no way to
 * tell a disposable test instance from somebody's work in progress. Replacing a
 * project is not recoverable — TurboWarp does not keep a history — so the only
 * honest thing to do is put a copy on disk first and say where it went.
 */
const backup = async (label) => {
  const base64 = await evaluate(connection, `(async () => {
    const buffer = await window.vm.saveProjectSb3('arraybuffer')
    const bytes = new Uint8Array(buffer)
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  })()`, { awaitPromise: true, timeoutMs: 120000 })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(backupDir, `${label}-${stamp}.sb3`)
  await mkdir(backupDir, { recursive: true })
  await writeFile(path, Buffer.from(base64, 'base64'))
  console.log(`backed up the project that was open -> ${path}`)
  return path
}

if (reset) {
  await backup('before-reset')
  const { project, assets } = starterProject({ spriteName: 'Sprite1' })
  const bytes = writeSb3(project, assets)
  const base64 = Buffer.from(bytes).toString('base64')
  // Chunked for the same reason the bridge chunks: one huge evaluate payload is
  // fragile, and this keeps a single code path for transferring bytes.
  await evaluate(connection, '(() => { window.__cleanupChunks = []; return true })()', { timeoutMs: 10000 })
  for (let offset = 0; offset < base64.length; offset += 256 * 1024) {
    const chunk = base64.slice(offset, offset + 256 * 1024)
    await evaluate(connection, `(() => { window.__cleanupChunks.push(${JSON.stringify(chunk)}); return true })()`, { timeoutMs: 30000 })
  }
  const summary = await evaluate(connection, `(async () => {
    const joined = window.__cleanupChunks.join('')
    delete window.__cleanupChunks
    const binary = atob(joined)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    await window.vm.loadProject(bytes.buffer)
    return JSON.stringify({
      reset: true,
      targets: window.vm.runtime.targets.map((t) => ({
        name: t.getName(),
        costumes: t.sprite ? t.sprite.costumes.map((c) => c.name) : [],
        blocks: Object.keys(t.blocks._blocks).length
      }))
    })
  })()`, { awaitPromise: true, timeoutMs: 60000 })
  console.log(summary)
  connection.close()
  process.exit(0)
}

// NOTE: this whole page body is a template literal. Do not put backticks in the
// comments below — a single one closes the literal and the syntax error surfaces
// far away from the line that caused it. test/page-source.test.mjs enforces this.
// The delete-only path mutates too, so it backs up as well.
await backup('before-cleanup')

const result = await evaluate(connection, `JSON.stringify((() => {
  const vm = window.vm
  const runtime = vm.runtime
  vm.stopAll()

  let removedScripts = 0
  let removedVariables = 0
  let removedCostumes = 0

  for (const target of runtime.targets) {
    // Snapshot: getScripts() returns the runtime's own array, and deleteBlock shrinks
    // it, so iterating it directly deletes only every second script.
    for (const id of [...target.blocks.getScripts()]) {
      target.blocks.deleteBlock(id)
      removedScripts++
    }
  }

  const junky = (name) => /^(score|counter|e2e)/i.test(name)

  // Variables and lists live on the stage (globals) or on a sprite (locals).
  // Delete by the MAP KEY: a variable can be keyed under one id while carrying a
  // different generated id, and deleteVariable looks the map up by what it is
  // handed.
  for (const target of runtime.targets) {
    for (const [key, variable] of Object.entries({ ...target.variables })) {
      if (!junky(variable.name)) continue
      if (typeof target.deleteVariable === 'function') {
        target.deleteVariable(key)
        removedVariables++
      }
    }
  }

  // Costumes and backdrops are both sprite.costumes. Delete from the end so the
  // indices of the entries still to check stay valid, and never leave a target
  // with no costume at all.
  for (const target of runtime.targets) {
    const costumes = target.sprite ? target.sprite.costumes : []
    for (let index = costumes.length - 1; index >= 0; index--) {
      if (!junky(costumes[index].name)) continue
      if (target.getCostumes().length <= 1) continue
      if (typeof target.deleteCostume === 'function') {
        target.deleteCostume(index)
        removedCostumes++
      }
    }
  }

  for (const target of runtime.targets) {
    if (target.isStage) continue
    target.setXY(0, 0)
    target.setDirection(90)
    target.setSize(100)
    target.setVisible(true)
    if (typeof target.setRotationStyle === 'function') target.setRotationStyle('all around')
  }

  vm.emitWorkspaceUpdate()
  runtime.requestRedraw()

  return {
    removedScripts,
    removedVariables,
    removedCostumes,
    remaining: runtime.targets.map((t) => ({
      name: t.getName(),
      blocks: Object.keys(t.blocks._blocks).length,
      costumes: t.sprite ? t.sprite.costumes.map((c) => c.name) : [],
      variables: Object.values(t.variables).map((v) => v.name)
    }))
  }
})())`, { timeoutMs: 30000 })

console.log(result)
connection.close()
