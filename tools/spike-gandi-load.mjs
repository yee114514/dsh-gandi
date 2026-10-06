/**
 * Does the Gandi VM answer the same calls the TurboWarp bridge makes?
 *
 * Read-only against a scratch tab prepared by probe-open-seq/probe-open-local.
 */
import { readFileSync } from 'node:fs'
import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const tab = process.argv[2]
const editor = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi') && t.url.includes(tab))
if (!editor) { console.log('tab not found'); process.exit(1) }
console.log('tab:', editor.url)
const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const FIND_VM = `(() => {
  const root = document.getElementById('root');
  const key = root ? Object.keys(root).find((k) => k.startsWith('__reactContainer')) : null;
  const looksLikeVM = (v) => v && typeof v === 'object' && v.runtime && 'editingTarget' in v && typeof v.greenFlag === 'function';
  let vm = null; const seen = new Set(); let visited = 0;
  const walk = (f, depth) => {
    if (!f || vm || visited > 40000 || depth > 90) return;
    visited++; if (seen.has(f)) return; seen.add(f);
    if (f.memoizedProps && looksLikeVM(f.memoizedProps.vm)) { vm = f.memoizedProps.vm; return }
    walk(f.child, depth + 1); walk(f.sibling, depth);
  };
  if (key) walk(root[key], 0);
  return vm;
})()`

const bytes = readFileSync(new URL('./fixtures/blank-project.sb3', import.meta.url))
const b64 = bytes.toString('base64')
console.log('project bytes:', bytes.length)

const script = `(async () => {
  const out = {};
  const vm = ${FIND_VM};
  if (!vm) return JSON.stringify({ error: 'no vm' });

  // 1. loadProject with archive bytes, exactly how loadProjectBytes does it
  const bin = atob(${JSON.stringify(b64)});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const t0 = Date.now();
  try {
    await vm.loadProject(arr.buffer);
    out.loadProject = { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    out.loadProject = { ok: false, ms: Date.now() - t0, error: String(e && e.message || e) };
  }

  out.targets = vm.runtime.targets.map((t) => ({
    name: t.getName(), isStage: t.isStage,
    blocks: Object.keys(t.blocks._blocks || {}).length,
    costumes: t.getCostumes().map((c) => ({ name: c.name, md5ext: c.md5ext, asset: !!(c.asset && c.asset.assetId) })),
    x: t.x, y: t.y, size: t.size, direction: t.direction, visible: t.visible
  }));

  // 2. the read path the bridge uses to decompile
  const et = vm.editingTarget;
  out.editingTarget = et ? et.getName() : null;
  try {
    const xml = et.blocks.toXML(et.comments);
    out.toXML = { ok: true, kind: typeof xml, head: String(xml).slice(0, 200) };
  } catch (e) { out.toXML = { ok: false, error: String(e && e.message || e) } }

  // 3. serialization both ways
  try {
    const json = vm.toJSON();
    out.toJSON = { ok: true, chars: json.length, targets: JSON.parse(json).targets.map((t) => t.name) };
  } catch (e) { out.toJSON = { ok: false, error: String(e && e.message || e) } }
  try {
    const buf = await vm.saveProjectSb3('arraybuffer');
    out.saveProjectSb3 = { ok: true, bytes: buf.byteLength };
  } catch (e) { out.saveProjectSb3 = { ok: false, error: String(e && e.message || e) } }

  // 4. variables + comments live on the target, as the bridge assumes
  out.targetSurface = et ? {
    createVariable: typeof et.createVariable,
    createComment: typeof et.createComment,
    comments: typeof et.comments,
    variables: Object.keys(et.variables),
    blocksContainer: typeof et.blocks.createBlock,
    deleteBlock: typeof et.blocks.deleteBlock,
    getScripts: typeof et.blocks.getScripts
  } : null;

  // 5. workspace sync surface
  out.workspace = {
    hasBlockly: typeof window.Blockly,
    hasGetMainWorkspace: !!(window.Blockly && window.Blockly.getMainWorkspace),
    hasScratchBlocks: typeof window.ScratchBlocks,
    hasEmitWorkspaceUpdate: typeof vm.emitWorkspaceUpdate
  };
  const ws = window.Blockly && window.Blockly.getMainWorkspace ? window.Blockly.getMainWorkspace() : null;
  if (ws) out.workspace.main = { isFlyout: !!ws.isFlyout, rendered: !!ws.rendered, blocks: ws.getAllBlocks(false).length };
  return JSON.stringify(out);
})()`

console.log(JSON.stringify(JSON.parse(await evaluate(conn, script, { awaitPromise: true, timeoutMs: 90000 })), null, 1))
conn.close()
