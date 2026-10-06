/**
 * Readiness gate test: wait for the editor's own bootstrap to settle, then load.
 * Run three times to check it is not itself racy.
 */
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

const openTab = async () => {
  const shell = (await listTargets(PORT)).find((t) => t.url.includes('renderer/index.html'))
  const shellConn = await CdpConnection.connect(shell.webSocketDebuggerUrl)
  const tabId = 'ready' + Date.now().toString(36)
  const url = `https://www.ccw.site/gandi?tabId=${tabId}&lang=zh-cn`
  await evaluate(shellConn, `(async () => { await ViewPreload.addView(${JSON.stringify({ url, tabId, offline: false, lang: 'zh-cn' })}); return 'ok' })()`, { awaitPromise: true })
  shellConn.close()
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const t = (await listTargets(PORT)).find((x) => typeof x.url === 'string' && x.url.includes(tabId))
    if (t) return { tabId, target: t }
  }
  throw new Error('no target')
}

/** Wait until the editor's own project is present AND stable for two samples. */
const waitForEditorReady = async (conn, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  let lastSignature = null
  let stable = 0
  while (Date.now() < deadline) {
    const signature = await evaluate(conn, `(() => {
      const vm = (${RESOLVE});
      if (!vm) return 'none';
      return vm.runtime.targets.map((t) => t.getName() + ':' + t.getCostumes().length).join(',');
    })()`).catch(() => 'err')
    if (signature !== 'none' && signature !== 'err' && signature.length > 0 && signature === lastSignature) {
      stable++
      if (stable >= 2) return signature
    } else {
      stable = 0
    }
    lastSignature = signature
    await sleep(600)
  }
  return null
}

for (let attempt = 1; attempt <= 3; attempt++) {
  const { tabId, target } = await openTab()
  const conn = await CdpConnection.connect(target.webSocketDebuggerUrl)
  const t0 = Date.now()
  const settled = await waitForEditorReady(conn)
  const readyMs = Date.now() - t0
  const res = await evaluate(conn, `(async () => {
    const vm = (${RESOLVE});
    const bin = atob(${JSON.stringify(b64)});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    await vm.loadProject(arr.buffer);
    await new Promise((r) => setTimeout(r, 4000));
    const ws = window.Blockly && window.Blockly.getMainWorkspace ? window.Blockly.getMainWorkspace() : null;
    return JSON.stringify({
      targets: vm.runtime.targets.map((t) => t.getName()),
      editingTarget: vm.editingTarget ? vm.editingTarget.getName() : null,
      workspaceBlocks: ws ? ws.getAllBlocks(false).length : null
    });
  })()`, { awaitPromise: true, timeoutMs: 60000 })
  const parsed = JSON.parse(res)
  const ok = parsed.targets && parsed.targets.includes('runner') && parsed.targets.length === 2
  console.log(`attempt ${attempt} (${tabId}): ready after ${readyMs}ms, settled="${settled}" -> ${ok ? 'PASS' : 'FAIL'} ${res}`)
  conn.close()
}
