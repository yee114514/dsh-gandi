/**
 * Why does a posted key not move a sprite on Gandi?
 *
 * Loads a project whose script is "when space pressed -> change x by 10", posts the key
 * exactly the way gandi_input does, and reports every layer of the keyboard path.
 */
import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { starterProject, writeSb3 } from '../src/scratch/sb3.mjs'
import { compileScripts } from '../src/scratch/xml.mjs'
import { fragmentToEngine } from '../src/scratch/engine.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { project, assets } = starterProject({ spriteName: 'runner' })
const xml = `<xml>
  <block type="event_whenkeypressed" id="keyhat">
    <field name="KEY_OPTION">space</field>
    <next><block type="motion_changexby" id="move"><value name="DX"><shadow type="math_number"><field name="NUM">10</field></shadow></value></block></next>
  </block>
</xml>`
const fragment = compileScripts(xml, { newId: (() => { let n = 0; return () => `kb_${++n}` })() })
const engine = fragmentToEngine(fragment)
console.log('compiled:', engine.blocks.map((b) => b.opcode).join(', '))

const bytes = writeSb3(project, assets)

const RESOLVE = `(() => {
  const looksLikeVm = (v) => v !== null && typeof v === 'object' && typeof v.greenFlag === 'function' &&
    v.runtime !== null && typeof v.runtime === 'object' && 'editingTarget' in v;
  const root = document.getElementById('root');
  const key = root ? Object.keys(root).find((k) => k.startsWith('__reactContainer')) : null;
  let vm = null; const seen = new Set();
  const walk = (f, d) => {
    if (!f || vm || d > 90) return;
    if (seen.has(f)) return; seen.add(f);
    const p = f.memoizedProps, st = f.stateNode;
    for (const s of [p && p.store, st && st.store]) {
      if (s && typeof s.getState === 'function') { try { const v = s.getState().scratchGui.vm; if (looksLikeVm(v)) { vm = v; return } } catch (e) {} }
    }
    if (looksLikeVm(p && p.vm)) { vm = p.vm; return }
    walk(f.child, d + 1); walk(f.sibling, d);
  };
  if (key) walk(root[key], 0);
  return vm;
})()`

// Open a fresh tab.
const shell = (await listTargets(PORT)).find((t) => t.url.includes('renderer/index.html'))
const shellConn = await CdpConnection.connect(shell.webSocketDebuggerUrl)
const tabId = 'kb' + Date.now().toString(36)
const url = `https://www.ccw.site/gandi?tabId=${tabId}&lang=zh-cn`
await evaluate(shellConn, `(async () => { await ViewPreload.addView(${JSON.stringify({ url, tabId, offline: false, lang: 'zh-cn' })}); return 'ok' })()`, { awaitPromise: true })
shellConn.close()
console.log('tab:', tabId)

let target = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  target = (await listTargets(PORT)).find((x) => typeof x.url === 'string' && x.url.includes(tabId))
  if (target) break
}
const conn = await CdpConnection.connect(target.webSocketDebuggerUrl)

// Wait for the editor to settle the way the bridge does.
let last = null
let stable = 0
for (let i = 0; i < 120; i++) {
  const sig = await evaluate(conn, `(() => { const vm = (${RESOLVE}); return vm === null ? null : vm.runtime.targets.map((t) => t.getName() + ':' + t.getCostumes().length).join(',') })()`).catch(() => null)
  if (typeof sig === 'string' && sig.length > 0) {
    if (sig === last) { stable++; if (stable >= 2) { console.log('settled:', sig); break } } else stable = 0
    last = sig
  }
  await sleep(600)
}

const out = await evaluate(conn, `(async () => {
  const res = {};
  const vm = (${RESOLVE});
  const rt = vm.runtime;
  const bin = atob(${JSON.stringify(bytes.toString('base64'))});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  await vm.loadProject(arr.buffer);
  const target = rt.targets.find((t) => t.getName() === 'runner');
  res.targets = rt.targets.map((t) => t.getName());
  if (!target) return JSON.stringify(res);

  vm.stopAll();
  vm.setEditingTarget(target.id);
  for (const b of ${JSON.stringify(engine.blocks)}) target.blocks.createBlock(b, 'default');
  vm.emitWorkspaceUpdate();
  res.scripts = target.blocks.getScripts().length;
  res.blocks = Object.keys(target.blocks._blocks).length;
  res.hatField = Object.values(target.blocks._blocks).filter((b) => b.opcode === 'event_whenkeypressed').map((b) => b.fields);

  const keyboard = rt.ioDevices.keyboard;
  res.keyboard = {
    ctor: keyboard.constructor.name,
    methods: Object.getOwnPropertyNames(Object.getPrototypeOf(keyboard)).filter((m) => /key|post|data/i.test(m)),
    pressedBefore: [...(keyboard._keysPressed || [])]
  };

  // Post the key exactly as gandi_input does.
  vm.postIOData('keyboard', { key: ' ', isDown: true });
  res.pressedAfterPost = [...(keyboard._keysPressed || [])];
  res.lastKeyPressed = keyboard.lastKeyPressed;

  target.setXY(0, 0);
  vm.greenFlag();
  res.threadsAfterFlag = rt.threads.length;
  const before = target.x;
  for (let i = 0; i < 12; i++) rt._step();
  res.movedBy = target.x - before;
  res.threadsLeft = rt.threads.length;

  // Second attempt: does a hat thread appear at all?
  vm.stopAll();
  target.setXY(0, 0);
  rt._step();
  res.threadsAfterIdleStep = rt.threads.length;
  for (let i = 0; i < 12; i++) rt._step();
  res.movedByNoGreenFlag = target.x;

  // Third: what does the runtime's own key state say?
  res.startHatsResults = (() => {
    try { return rt.startHats('event_whenkeypressed').length } catch (e) { return 'ERR ' + e.message }
  })();
  return JSON.stringify(res);
})()`, { awaitPromise: true, timeoutMs: 90000 })

console.log(JSON.stringify(JSON.parse(out), null, 1))
conn.close()
