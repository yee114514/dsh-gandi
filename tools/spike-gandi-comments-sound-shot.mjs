import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { synthesizeToneWav } from '../src/scratch/wav.mjs'

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

// --- 1. What does the sound path actually expect? (read the VM's own source) ---
const soundSource = await evaluate(conn, `(() => {
  const vm = (${RESOLVE});
  const target = vm.runtime.targets.find((t) => t.getName() === 'runner');
  const fn = vm.runtime.targets[0].constructor;
  return JSON.stringify({
    targetProto: Object.getOwnPropertyNames(Object.getPrototypeOf(target)).filter((m) => /comment|sound|variable|costume/i.test(m)),
    vmAddSoundSrc: String(vm.addSound).slice(0, 400),
    rtLoadSoundSrc: String(vm.runtime.constructor).length > 0
  });
})()`)
console.log('=== target + addSound ===')
console.log(JSON.stringify(JSON.parse(soundSource), null, 1))

// --- 2. Comments: createComment signature, changeBlock-based delete, XML ---
const commentApi = await evaluate(conn, `(() => {
  const vm = (${RESOLVE});
  const target = vm.runtime.targets.find((t) => t.getName() === 'runner');
  vm.setEditingTarget(target.id);
  const out = { changeBlockArity: target.blocks.changeBlock.length };
  target.createComment('probeComment', null, 'hi there', 20, 20, 200, 100, false);
  const c = target.comments.probeComment;
  out.created = { ctor: c && c.constructor ? c.constructor.name : typeof c, hasToXML: !!(c && typeof c.toXML === 'function'), text: c && c.text, w: c && c.width, h: c && c.height };
  out.xmlHasComment = String(target.blocks.toXML(target.comments)).includes('probeComment');
  try {
    target.blocks.changeBlock({ id: 'n/a', element: 'comment_delete', commentId: 'probeComment', blockId: null }, false);
    out.deletedViaChangeBlock = Object.keys(target.comments).length === 0;
  } catch (e) { out.deletedViaChangeBlock = 'threw ' + String(e && e.message || e) }
  return JSON.stringify(out);
})()`)
console.log('=== comments ===')
console.log(JSON.stringify(JSON.parse(commentApi), null, 1))

// --- 2b. Sound with the historical `md5` field, as loadSound expects ---
const soundApi = await evaluate(conn, `(async () => {
  const vm = (${RESOLVE});
  const target = vm.runtime.targets.find((t) => t.getName() === 'runner');
  const out = {};
  const bin = atob(${JSON.stringify(synthesizeToneWav({ frequency: 440, seconds: 0.2, waveform: 'sine', volume: 0.5 }).toString('base64'))});
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const sound = { name: 'probe-sound', md5: 'probe.wav', dataFormat: 'wav', format: '', rate: 44100, sampleCount: 8820, data: arr.buffer };
  try {
    await vm.addSound(sound, target.id);
    out.addSound = { ok: true, sounds: target.getSounds().map((s) => ({ name: s.name, id: s.id, md5: s.md5, rate: s.rate, sampleCount: s.sampleCount, hasSoundId: !!s.soundId })) };
    target.deleteSound(target.getSounds().find((s) => s.name === 'probe-sound').id);
    out.afterDelete = target.getSounds().map((s) => s.name);
  } catch (e) { out.addSound = { ok: false, error: String(e && e.message || e) } }
  return JSON.stringify(out);
})()`, { awaitPromise: true, timeoutMs: 60000 })
console.log('=== sound ===')
console.log(JSON.stringify(JSON.parse(soundApi), null, 1))

// --- 3. Screenshot ---
const shot = await evaluate(conn, `(async () => {
  const vm = (${RESOLVE});
  const rt = vm.runtime;
  const r = rt.renderer;
  const out = {
    hasRequestSnapshot: typeof r.requestSnapshot,
    hasDraw: typeof r.draw,
    dirty: r.dirty,
    canvas: r.canvas ? { w: r.canvas.width, h: r.canvas.height } : null
  };
  const grab = () => new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT'), 5000);
    try { r.requestSnapshot((d) => { clearTimeout(timer); resolve(String(d).slice(0, 40)) }) } catch (e) { clearTimeout(timer); resolve('THREW ' + e.message) }
  });
  rt.requestRedraw();
  r.dirty = true;
  out.afterRedraw = await grab();
  r.dirty = true;
  try { r.draw() } catch (e) { out.drawError = String(e && e.message || e) }
  r.dirty = true;
  out.afterDraw = await grab();
  out.dirtyAfter = r.dirty;
  return JSON.stringify(out);
})()`, { awaitPromise: true, timeoutMs: 90000 })
console.log('=== screenshot ===')
console.log(JSON.stringify(JSON.parse(shot), null, 1))
conn.close()
