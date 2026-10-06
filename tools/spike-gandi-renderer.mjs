import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const tab = process.argv[2]
const editor = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes(tab))
if (!editor) { console.log('tab not found'); process.exit(1) }
const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)

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

const probe = `(async () => {
  const vm = (${RESOLVE});
  const rt = vm.runtime;
  const r = rt.renderer;
  const out = {};
  out.rendererCtor = r.constructor.name;
  out.rendererProtoSize = Object.getOwnPropertyNames(Object.getPrototypeOf(r)).length;
  out.ownProps = Object.keys(r).slice(0, 60);
  out.usesGl = /webgl/i.test(String(r.constructor.name)) || !!r.gl;
  out.requestSnapshotSrc = String(r.requestSnapshot).slice(0, 700);
  out.getCanvas = typeof r.getCanvas;
  out.canvasCtor = r.canvas && r.canvas.constructor ? r.canvas.constructor.name : null;
  out.gl = r.gl ? { ctor: r.gl.constructor.name } : null;
  out._snapshotCallbacks = r._snapshotCallbacks ? r._snapshotCallbacks.length : null;
  // Anything that might be swallowing the callbacks
  out.dirtyFlags = Object.keys(r).filter((k) => /dirty|draw|frame|render/i.test(k));
  out.dirtyValues = Object.fromEntries(Object.keys(r).filter((k) => /^(dirty|_dirty)/i.test(k)).map((k) => [k, r[k]]));
  // Direct canvas capture as an alternative
  try {
    const c = r.canvas;
    out.canvasDirect = { w: c.width, h: c.height, hasToDataURL: typeof c.toDataURL };
    const url = c.toDataURL('image/png');
    out.canvasDirect.dataUrlLength = url.length;
    out.canvasDirect.head = url.slice(0, 30);
    out.canvasDirect.allTransparent = url.length < 200;
  } catch (e) { out.canvasDirect = 'THREW ' + String(e && e.message || e) }
  return JSON.stringify(out);
})()`

console.log(JSON.stringify(JSON.parse(await evaluate(conn, probe, { awaitPromise: true, timeoutMs: 60000 })), null, 1))
conn.close()
