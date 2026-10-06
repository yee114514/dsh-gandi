/**
 * The full write -> sync -> run loop against Gandi's VM, using the plugin's own
 * compiler and engine converter.
 */
import { readFileSync } from 'node:fs'
import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { starterProject, writeSb3 } from '../src/scratch/sb3.mjs'
import { compileScripts } from '../src/scratch/xml.mjs'
import { fragmentToEngine } from '../src/scratch/engine.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tab = process.argv[2]

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

// A project whose stage carries a costume, so scratch-parser accepts it.
const built = starterProject({ spriteName: 'runner', stageName: 'Stage' })
const stage = built.project.targets[0]
const { target: sprite, assets } = { target: built.project.targets[1], assets: built.assets }
stage.costumes = [{
  name: 'backdrop1',
  dataFormat: 'svg',
  assetId: 'cd21514d0531fdffb22204e0ec5ed84a',
  md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg',
  rotationCenterX: 240,
  rotationCenterY: 180
}]
assets.set('cd21514d0531fdffb22204e0ec5ed84a.svg', Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#ffffff"/></svg>', 'utf8'))
const bytes = writeSb3(built.project, assets)
console.log('probe project:', bytes.length, 'bytes;', built.project.targets.map((t) => t.name).join(', '))

const xml = '<xml><block type="event_whenflagclicked" id="hat1"><next><block type="motion_changexby" id="move1"><value name="DX"><shadow type="math_number"><field name="NUM">25</field></shadow></value></block></next></block></xml>'
const fragment = compileScripts(xml, { newId: (() => { let n = 0; return () => `probe_${++n}` })() })
console.log('fragment blocks:', Object.keys(fragment.blocks).length, 'warnings:', (fragment.warnings ?? []).length)
const engine = fragmentToEngine(fragment)
console.log('engine blocks:', engine.blocks.map((b) => `${b.id}:${b.opcode}`).join(' '))

const editor = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi') && t.url.includes(tab))
if (!editor) { console.log('tab not found'); process.exit(1) }
console.log('tab:', editor.url)
const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const script = `(async () => {
  const out = {};
  const vm = ${FIND_VM};
  if (!vm) return JSON.stringify({ error: 'no vm' });
  const bin = atob(${JSON.stringify(bytes.toString('base64'))});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  try {
    await vm.loadProject(arr.buffer);
    out.load = { ok: true };
  } catch (e) { return JSON.stringify({ load: { ok: false, error: String(e && e.message || e) } }) }

  out.targets = vm.runtime.targets.map((t) => ({ name: t.getName(), isStage: t.isStage, costumes: t.getCostumes().length, blocks: Object.keys(t.blocks._blocks || {}).length }));
  const target = vm.runtime.targets.find((t) => t.getName() === 'runner');
  if (!target) return JSON.stringify({ ...out, error: 'no runner target' });
  out.xBefore = target.x;

  // Write the fragment the way the bridge does: engine-form createBlock on the target.
  vm.stopAll();
  vm.setEditingTarget(target.id);
  const created = [];
  for (const block of ${JSON.stringify(engine.blocks)}) {
    try { created.push([block.id, target.blocks.createBlock(block, 'default')]) }
    catch (e) { out.createError = String(e && e.message || e); break }
  }
  out.created = created;
  out.vmBlockCount = Object.keys(target.blocks._blocks).length;
  out.scripts = target.blocks.getScripts();

  // Push to the editor's Blockly workspace (the TurboWarp bridge calls emitWorkspaceUpdate).
  try { vm.emitWorkspaceUpdate(); out.emitted = true }
  catch (e) { out.emitted = String(e && e.message || e) }
  await new Promise((r) => setTimeout(r, 400));

  const ws = window.Blockly && window.Blockly.getMainWorkspace ? window.Blockly.getMainWorkspace() : null;
  out.workspace = ws ? { blocks: ws.getAllBlocks(false).length, xml: String(ws.getAllBlocks(false).map((b) => b.type).join(',')) } : null;

  // Run: the bridge drives the runtime itself rather than waiting on the wall clock.
  vm.greenFlag();
  out.threadsStarted = vm.runtime.threads.length;
  const stepMs = vm.runtime.currentStepTime || 1000 / 30;
  const steps = Math.max(1, Math.ceil((1.0 * 1000) / stepMs));
  for (let i = 0; i < steps; i++) vm.runtime._step();
  out.steps = steps;
  out.threadsLeft = vm.runtime.threads.length;
  out.xAfter = target.x;
  out.movedBy = target.x - out.xBefore;

  // Read back through the compiler's own path.
  try {
    const backXml = target.blocks.toXML(target.comments);
    out.readBack = { ok: true, chars: String(backXml).length, head: String(backXml).slice(0, 160) };
  } catch (e) { out.readBack = { ok: false, error: String(e && e.message || e) } }
  return JSON.stringify(out);
})()`

console.log(JSON.stringify(JSON.parse(await evaluate(conn, script, { awaitPromise: true, timeoutMs: 120000 })), null, 1))
conn.close()
