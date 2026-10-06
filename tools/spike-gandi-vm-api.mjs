import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const editor = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
if (!editor) { console.log('editor not open'); process.exit(1) }
const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const probe = [
  'JSON.stringify((() => {',
  '  const root = document.getElementById("root");',
  '  const key = Object.keys(root).find((k) => k.startsWith("__reactContainer"));',
  '  const looksLikeVM = (v) => v && typeof v === "object" && v.runtime && "editingTarget" in v && typeof v.greenFlag === "function";',
  '  const seen = new Set(); let visited = 0; let vm = null;',
  '  const walk = (f, depth) => {',
  '    if (!f || vm || visited > 40000 || depth > 90) return;',
  '    visited++; if (seen.has(f)) return; seen.add(f);',
  '    if (f.memoizedProps && looksLikeVM(f.memoizedProps.vm)) { vm = f.memoizedProps.vm; return }',
  '    walk(f.child, depth + 1); walk(f.sibling, depth);',
  '  };',
  '  walk(root[key], 0);',
  '  if (!vm) return { found: false, visited };',
  '  const out = { found: true, visited };',
  '  const want = ["loadProject","greenFlag","stopAll","start","quit","addCostume","addBackdrop","addSprite","addSound",',
  '    "emitWorkspaceUpdate","createBlock","deleteBlock","renameSprite","deleteSprite","duplicateSprite","setEditingTarget",',
  '    "refreshWorkspace","getEditingTarget","toJSON","saveProjectSb3","loadProjectFromJSON","postIOData","shareBlocks",',
  '    "attachRenderer","setTurboMode","collectAssets","exportSprite","updateSvg","setCompatibilityMode"];',
  '  out.methods = Object.fromEntries(want.map((m) => [m, typeof vm[m]]));',
  '  out.keys = Object.keys(vm);',
  '  out.listenerProps = Object.keys(vm).filter((k) => /block|workspace|listener|plugin|event/i.test(k));',
  '  const rt = vm.runtime;',
  '  out.runtime = {',
  '    targets: rt.targets.map((t) => ({ name: t.getName(), isStage: t.isStage, blocks: Object.keys(t.blocks._blocks || {}).length, costumes: t.getCostumes().length, sounds: t.getSounds().length })),',
  '    requestRedraw: typeof rt.requestRedraw,',
  '    step: typeof rt._step,',
  '    stepTime: rt.currentStepTime,',
  '    threads: rt.threads.length,',
  '    assetTypes: Object.keys(rt.storage.AssetType),',
  '    createAssetArity: rt.storage.createAsset.length,',
  '    getMonitorState: typeof rt.getMonitorState,',
  '    ioDevices: Object.keys(rt.ioDevices),',
  '    rendererType: rt.renderer ? rt.renderer.constructor.name : null,',
  '    rendererMethods: rt.renderer ? Object.getOwnPropertyNames(Object.getPrototypeOf(rt.renderer)).filter((m) => /snapshot|redraw|draw|dirty|canvas|size/i.test(m)) : null,',
  '    ccwAPIKeys: rt.ccwAPI ? Object.keys(rt.ccwAPI) : null',
  '  };',
  '  const et = vm.editingTarget;',
  '  out.editingTarget = et ? { name: et.getName(), isStage: et.isStage, proto: Object.getOwnPropertyNames(Object.getPrototypeOf(et)).filter((m) => /comment|variable|costume|sound|block|visual/i.test(m)) } : null;',
  '  out.blocksProto = et && et.blocks ? Object.getOwnPropertyNames(Object.getPrototypeOf(et.blocks)).filter((m) => !m.startsWith("_")).slice(0, 60) : null;',
  '  const B = window.Blockly;',
  '  const ws = B && B.getMainWorkspace ? B.getMainWorkspace() : null;',
  '  out.workspace = ws ? { isFlyout: !!ws.isFlyout, rendered: !!ws.rendered, blockCount: ws.getAllBlocks(false).length, proto: Object.getOwnPropertyNames(Object.getPrototypeOf(ws)).slice(0, 45) } : String(ws);',
  '  return out;',
  '})())'
].join('\n')

console.log(JSON.stringify(JSON.parse(await evaluate(conn, probe)), null, 1))
conn.close()
