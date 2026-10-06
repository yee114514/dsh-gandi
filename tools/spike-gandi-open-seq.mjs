import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const file = fileURLToPath(new URL('./fixtures/blank-project.sb3', import.meta.url))

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

const shell = (await listTargets(PORT)).find((t) => t.url.includes('renderer/index.html'))
const shellConn = await CdpConnection.connect(shell.webSocketDebuggerUrl)
const tabId = 'seq' + Date.now().toString(36)
const url = `https://www.ccw.site/gandi?tabId=${tabId}&lang=zh-cn&fromComputer=true`

// Step 1: open the tab WITHOUT a file, so the editor comes up normally (no pending import).
await evaluate(shellConn, `(async () => { await ViewPreload.addView(${JSON.stringify({ url, tabId, offline: false, lang: 'zh-cn' })}); return 'ok' })()`, { awaitPromise: true })
console.log('step 1: tab opened without a file:', tabId)

let editor = null
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  editor = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes(tabId))
  if (editor) break
}
if (!editor) { console.log('no editor target'); process.exit(1) }

const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)
console.log('step 2: waiting for the VM inside the editor')
let vmReady = false
for (let i = 0; i < 60; i++) {
  vmReady = await evaluate(conn, `(() => !!(${FIND_VM}))()`).catch(() => false)
  if (vmReady) break
  await sleep(1000)
}
console.log('  vm ready:', vmReady)
console.log('  body:', await evaluate(conn, 'JSON.stringify((document.body.innerText||"").slice(0,90))'))

// Step 3: subscribe FIRST, then trigger the file handoff through the main process.
const subscribe = evaluate(conn, `(async () => {
  window.__handoff = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ delivered: false }), 30000);
    GandiEditorPreload.onLoadProjectFromDisk((data) => {
      clearTimeout(timer);
      resolve({ delivered: true, bytes: data && data.fileData ? data.fileData.byteLength : null });
    });
  });
  return 'subscribed';
})()`, { awaitPromise: true, timeoutMs: 40000 }).catch((e) => 'ERR ' + e.message)
await sleep(1500)

// `ViewPreload.addView` is what stashes the pending file in the main process; the
// editor's own import button uses it together with a real file dialog.
const second = 'seq2' + Date.now().toString(36)
const url2 = `https://www.ccw.site/gandi?tabId=${second}&lang=zh-cn&fromComputer=true`
console.log('step 3: stashing the file via a second addView')
await evaluate(shellConn, `(async () => { await ViewPreload.addView(${JSON.stringify({ url: url2, tabId: second, filePath: file, offline: false, lang: 'zh-cn' })}); return 'ok' })()`, { awaitPromise: true }).catch((e) => console.log('  addView err', e.message))
console.log('  subscribe result:', await subscribe)
console.log('  handoff seen by tab A:', await evaluate(conn, 'JSON.stringify(window.__handoff)'))
shellConn.close()
conn.close()
