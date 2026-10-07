/**
 * Probe: which sprite-editing entry points does this VM actually have?
 *
 * Costume and sound management (rename, delete, reorder) is GUI work, not runtime work,
 * so the names live on the VM and on Target rather than in the sb3 format. Guessing them
 * fails the same way every time — `vm.renameCostume is not a function`, from a page
 * script whose stack points at the bridge rather than at the missing method.
 *
 * Read-only: lists method names and signatures, changes nothing.
 *
 * Usage: node tools/spike-gandi-sprite-api.mjs
 */

import { CdpConnection, evaluate, listTargets } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const editor = (await listTargets(PORT)).find((target) => typeof target.url === 'string' && target.url.includes('/gandi'))
if (!editor) {
  console.log('editor not open')
  process.exit(1)
}
const connection = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const raw = await evaluate(connection, `JSON.stringify((() => {
  const vm = (() => {
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
  })()
  if (!vm) return { error: 'no vm' }
  const runtime = vm.runtime
  const target = vm.editingTarget || runtime.targets.find((t) => !t.isStage)
  const stage = runtime.getTargetForStage()

  const vmMethods = ['renameCostume', 'renameSound', 'deleteCostume', 'deleteSound', 'addCostume', 'addBackdrop',
    'addSound', 'duplicateSprite', 'deleteSprite', 'renameSprite', 'setEditingTarget', 'emitWorkspaceUpdate',
    'refreshWorkspace', 'shareBlocks', 'collectAssets', 'toJSON', 'saveProjectSb3', 'loadProject',
    'setVariableValue', 'createVariable', 'deleteVariable', 'renameVariable', 'getEditingTarget', 'updateSvg',
    'setTurboMode', 'start', 'stop', 'greenFlag', 'stopAll', 'postIOData', 'attachRenderer', 'extensionManager']
  const targetMethods = ['deleteCostume', 'renameCostume', 'deleteSound', 'renameSound', 'getCostumes', 'getSounds',
    'createVariable', 'renameVariable', 'deleteVariable', 'createComment', 'setXY', 'setSize', 'setVisible',
    'setDirection', 'clone', 'makeClone', 'deleteClone', 'changeCostume', 'setCostume', 'addCostume', 'addSound',
    'getCurrentCostume', 'updateAllDrawableProperties', 'clearEdgeActivatedValues', 'toJSON', 'getName']
  const proto = (object) => Object.getOwnPropertyNames(Object.getPrototypeOf(object))

  return {
    vmMethods: Object.fromEntries(vmMethods.map((m) => [m, typeof vm[m] + (typeof vm[m] === 'function' ? '/' + vm[m].length : '')])),
    targetMethods: Object.fromEntries(targetMethods.map((m) => [m, typeof target[m] + (typeof target[m] === 'function' ? '/' + target[m].length : '')])),
    targetPrototype: proto(target).filter((m) => /costume|sound|variable|comment|clone/i.test(m)),
    vmPrototype: proto(vm).filter((m) => /costume|sound|variable|clone|sprite/i.test(m)),
    editingTarget: target.getName(),
    stageName: stage.getName(),
    costumeCount: target.getCostumes ? target.getCostumes().length : null,
    soundCount: target.getSounds ? target.getSounds().length : null,
    frameLoop: runtime.frameLoop ? {
      running: runtime.frameLoop.running,
      framerate: runtime.frameLoop.framerate,
      methods: proto(runtime.frameLoop)
    } : null,
    hasGetMonitorState: typeof runtime.getMonitorState,
    extensions: (() => {
      const manager = vm.extensionManager
      if (!manager) return null
      const loaded = manager._loadedExtensions
      return loaded ? [...(loaded.keys ? loaded.keys() : Object.keys(loaded))] : Object.keys(manager)
    })()
  }
})())`, { timeoutMs: 60000 })

console.log(JSON.stringify(JSON.parse(raw), null, 1))
connection.close()
