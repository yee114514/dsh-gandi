import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const findEditor = async () => (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
let editor = await findEditor()
if (!editor) { console.log('no editor target; run probe-open-editor first'); process.exit(1) }
console.log('editor target:', editor.url)

const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const probe = `JSON.stringify((() => {
  const keys = Object.keys(window);
  const interesting = keys.filter((k) => /^(vm|Scratch|Redux|Blockly|Gandi|gandi|GUI|gui|__)/.test(k));
  const vm = window.vm;
  const out = {
    readyState: document.readyState,
    title: document.title,
    href: location.href,
    origin: location.origin,
    interestingGlobals: interesting,
    vmType: typeof vm,
    scratchBlocksType: typeof window.ScratchBlocks,
    reduxType: typeof window.ReduxStore
  };
  if (vm && typeof vm === 'object') {
    out.vmKeys = Object.keys(vm).slice(0, 60);
    out.hasRuntime = typeof vm.runtime === 'object';
    out.hasBlocks = typeof vm.editingTarget === 'object';
    if (vm.runtime) {
      out.targetCount = vm.runtime.targets ? vm.runtime.targets.length : null;
      out.targetNames = vm.runtime.targets ? vm.runtime.targets.map((t) => t.getName && t.getName()) : null;
      out.hasRequestRedraw = typeof vm.runtime.requestRedraw === 'function';
      out.hasStep = typeof vm.runtime._step === 'function';
      out.storage = !!vm.runtime.storage;
      out.assetTypes = vm.runtime.storage ? Object.keys(vm.runtime.storage.AssetType || {}) : null;
    }
    out.vmMethods = ['loadProject','greenFlag','stopAll','addCostume','addBackdrop','addSprite','emitWorkspaceUpdate','createBlock','deleteBlock','addSound','renameSprite','deleteSprite','duplicateSprite','setEditingTarget','start','refreshWorkspace']
      .filter((m) => typeof vm[m] === 'function');
  }
  return out;
})())`

for (let i = 0; i < 40; i++) {
  const res = await evaluate(conn, probe).catch((e) => `ERR ${e.message}`)
  if (typeof res === 'string' && res.startsWith('{')) {
    const parsed = JSON.parse(res)
    console.log(JSON.stringify(parsed, null, 1))
    if (parsed.vmType === 'object' || i > 25) break
  } else {
    console.log('evaluate:', res)
  }
  await sleep(2000)
}
conn.close()
