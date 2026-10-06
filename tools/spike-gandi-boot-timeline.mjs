import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { starterProject, writeSb3 } from '../src/scratch/sb3.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const built = starterProject({ spriteName: 'runner', stageName: 'Stage' })
const stage = built.project.targets[0]
const BACKDROP = 'cd21514d0531fdffb22204e0ec5ed84a.svg'
stage.costumes = [{ name: 'backdrop1', dataFormat: 'svg', assetId: BACKDROP.split('.')[0], md5ext: BACKDROP, rotationCenterX: 240, rotationCenterY: 180 }]
built.assets.set(BACKDROP, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#fff"/></svg>', 'utf8'))
const b64 = writeSb3(built.project, built.assets).toString('base64')

/** A resolver expression that can be pasted anywhere the VM is wanted. */
const RESOLVE = `(() => {
  const looksLikeVM = (v) => v && typeof v === 'object' && v.runtime && 'editingTarget' in v && typeof v.greenFlag === 'function';
  const root = document.getElementById('root');
  const key = root ? Object.keys(root).find((k) => k.startsWith('__reactContainer')) : null;
  let vm = null; const seen = new Set();
  const walk = (f, d) => {
    if (!f || vm || d > 90) return;
    if (seen.has(f)) return; seen.add(f);
    if (looksLikeVM(f.memoizedProps && f.memoizedProps.vm)) { vm = f.memoizedProps.vm; return }
    const p = f.memoizedProps, st = f.stateNode;
    for (const s of [p && p.store, st && st.store]) {
      if (s && typeof s.getState === 'function') { try { const v = s.getState().scratchGui.vm; if (looksLikeVM(v)) { vm = v; return } } catch (e) {} }
    }
    walk(f.child, d + 1); walk(f.sibling, d);
  };
  if (key) walk(root[key], 0);
  return vm;
})()`

const shell = (await listTargets(PORT)).find((t) => t.url.includes('renderer/index.html'))
const shellConn = await CdpConnection.connect(shell.webSocketDebuggerUrl)
const tabId = 'tl' + Date.now().toString(36)
const url = `https://www.ccw.site/gandi?tabId=${tabId}&lang=zh-cn`
await evaluate(shellConn, `(async () => { await ViewPreload.addView(${JSON.stringify({ url, tabId, offline: false, lang: 'zh-cn' })}); return 'ok' })()`, { awaitPromise: true })
shellConn.close()

let target = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  target = (await listTargets(PORT)).find((x) => typeof x.url === 'string' && x.url.includes(tabId))
  if (target) break
}
console.log('tab:', tabId)
const conn = await CdpConnection.connect(target.webSocketDebuggerUrl)

// Wait for the VM ourselves and record when it appears.
const started = Date.now()
let appearedAt = null
for (let i = 0; i < 120; i++) {
  const has = await evaluate(conn, `(() => !!(${RESOLVE}))()`).catch(() => false)
  if (has) { appearedAt = Date.now() - started; break }
  await sleep(250)
}
console.log('vm appeared after ~' + appearedAt + 'ms')

// Record the target list continuously from a page-side timer.
await evaluate(conn, `(() => {
  window.__log = [];
  const log = (w) => window.__log.push(Math.round(performance.now()) + ' ' + w);
  let last = null;
  window.__timer = setInterval(() => {
    const vm = (${RESOLVE});
    if (!vm) { if (last !== '<none>') { last = '<none>'; log('targets=[no vm]') } return }
    const names = vm.runtime.targets.map((t) => t.getName()).join(',');
    if (names !== last) { last = names; log('targets=[' + names + ']') }
  }, 200);
  log('recorder start');
  return true;
})()`)

const script = `(async () => {
  const out = {};
  const vm = (${RESOLVE});
  out.hasVm = !!vm;
  if (!vm) return JSON.stringify(out);
  out.targetsWhenFound = vm.runtime.targets.map((t) => t.getName());
  const bin = atob(${JSON.stringify(b64)});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  await vm.loadProject(arr.buffer);
  out.afterLoad = vm.runtime.targets.map((t) => t.getName());
  await new Promise((r) => setTimeout(r, 15000));
  out.after15s = vm.runtime.targets.map((t) => t.getName());
  out.sameVmObject = (((${RESOLVE}) === vm));
  return JSON.stringify(out);
})()`

console.log(JSON.stringify(JSON.parse(await evaluate(conn, script, { awaitPromise: true, timeoutMs: 90000 })), null, 1))
console.log('timeline:', await evaluate(conn, 'JSON.stringify(window.__log)'))
await evaluate(conn, '(() => { clearInterval(window.__timer); return true })()')
conn.close()
