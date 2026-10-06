import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const tab = process.argv[2]
const editor = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi') && t.url.includes(tab))
if (!editor) { console.log('tab not found'); process.exit(1) }
const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const probe = [
  'JSON.stringify((() => {',
  '  const looksLikeVM = (v) => v && typeof v === "object" && v.runtime && "editingTarget" in v && typeof v.greenFlag === "function";',
  '  const root = document.getElementById("root");',
  '  const key = Object.keys(root).find((k) => k.startsWith("__reactContainer"));',
  '  const out = { providers: [], storesWithVm: [], anchors: [] };',
  '  const seen = new Set(); let visited = 0;',
  '  const nameOf = (f) => { const t = f.type; if (typeof t === "function") return t.displayName || t.name || "anon"; if (typeof t === "string") return t; if (t && (t.displayName || t.name)) return t.displayName || t.name; if (t && t._context) return "Context.Provider"; return "?"; };',
  '  const checkStore = (store, label) => {',
  '    if (!store || typeof store.getState !== "function") return;',
  '    const state = store.getState();',
  '    if (state && state.scratchGui && looksLikeVM(state.scratchGui.vm)) out.storesWithVm.push({ label, keys: Object.keys(state), sgKeys: Object.keys(state.scratchGui).slice(0, 40) });',
  '  };',
  '  const walk = (f, depth) => {',
  '    if (!f || visited > 40000 || depth > 90) return;',
  '    visited++; if (seen.has(f)) return; seen.add(f);',
  '    const p = f.memoizedProps;',
  '    if (p && p.store) { out.providers.push({ name: nameOf(f), depth, hasGetState: typeof p.store.getState === "function" }); checkStore(p.store, "props.store of " + nameOf(f)); }',
  '    const st = f.stateNode;',
  '    if (st && st.store) checkStore(st.store, "stateNode.store of " + nameOf(f));',
  '    if (st && st.props && st.props.store) checkStore(st.props.store, "stateNode.props.store of " + nameOf(f));',
  '    if (looksLikeVM(p && p.vm)) out.anchors.push("props.vm of " + nameOf(f) + "@" + depth);',
  '    let hook = f.memoizedState, i = 0;',
  '    while (hook && i < 40) {',
  '      const m = hook.memoizedState;',
  '      if (m && typeof m === "object" && typeof m.getState === "function") checkStore(m, "hook" + i + " of " + nameOf(f));',
  '      if (m && typeof m === "object" && m.current && typeof m.current.getState === "function") checkStore(m.current, "hook" + i + ".current of " + nameOf(f));',
  '      hook = hook.next; i++;',
  '    }',
  '    walk(f.child, depth + 1); walk(f.sibling, depth);',
  '  };',
  '  walk(root[key], 0);',
  '  out.visited = visited;',
  '  out.providers = out.providers.slice(0, 10);',
  '  out.storesWithVm = out.storesWithVm.slice(0, 5);',
  '  out.anchors = [...new Set(out.anchors)].slice(0, 6);',
  '  out.globalReduxHints = Object.keys(window).filter((k) => /redux|store|vm/i.test(k));',
  '  return out;',
  '})())'
].join('\n')

console.log(JSON.stringify(JSON.parse(await evaluate(conn, probe)), null, 1))
conn.close()
