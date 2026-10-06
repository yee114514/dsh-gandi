/**
 * Everything else the bridge needs, in one pass: assets, costumes, backdrops,
 * sounds, sprite duplication, the run loop, glow handling and screenshots.
 */
import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { starterProject, writeSb3 } from '../src/scratch/sb3.mjs'
import { synthesizeToneWav } from '../src/scratch/wav.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tab = process.argv[2]

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

const wav = synthesizeToneWav({ frequency: 440, seconds: 0.2, waveform: 'sine', volume: 0.5 })
console.log('tone bytes:', wav.length)

const editor = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes(tab))
if (!editor) { console.log('tab not found'); process.exit(1) }
console.log('tab:', tab)
const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const script = `(async () => {
  const out = {};
  const vm = (${RESOLVE});
  const rt = vm.runtime;
  out.start = { targets: rt.targets.map((t) => t.getName()), assetTypes: Object.keys(rt.storage.AssetType) };
  const target = rt.targets.find((t) => t.getName() === 'runner');
  const stageTarget = rt.getTargetForStage();
  out.editingTargetIsRunner = vm.editingTarget && vm.editingTarget.getName() === 'runner';

  // 1. Vector costume asset, created the way createAsset is documented to work.
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#f0f"/></svg>';
  const bytes = new TextEncoder().encode(svg);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  out.note_sha256_available = !!digest;
  let asset;
  try {
    asset = rt.storage.createAsset(rt.storage.AssetType.ImageVector, 'svg', svg, null, true);
    out.createAsset = { ok: true, assetId: asset.assetId, dataFormat: asset.dataFormat, hasEncodeDataURI: typeof asset.encodeDataURI };
  } catch (e) { out.createAsset = { ok: false, error: String(e && e.message || e) } }

  if (asset) {
    const md5ext = asset.assetId + '.' + asset.dataFormat;
    const costume = {
      name: 'probe-costume',
      dataFormat: 'svg',
      assetId: asset.assetId,
      md5: asset.assetId,
      md5ext,
      rotationCenterX: 20,
      rotationCenterY: 20,
      asset
    };
    // sprite costume (md5ext, obj, targetId)
    try { await vm.addCostume(md5ext, costume, target.id); out.addCostume = { ok: true, costumes: target.getCostumes().map((c) => c.name) } }
    catch (e) { out.addCostume = { ok: false, error: String(e && e.message || e) } }
    // backdrop (md5ext, obj)
    try { await vm.addBackdrop(md5ext, { ...costume, name: 'probe-backdrop' }); out.addBackdrop = { ok: true, costumes: stageTarget.getCostumes().map((c) => c.name) } }
    catch (e) { out.addBackdrop = { ok: false, error: String(e && e.message || e) } }
  }

  // 2. Sound: bytes only, the shape load-sound expects.
  ${wav ? `{
    const bin = atob(${JSON.stringify(Buffer.from(wav).toString('base64'))});
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    try {
      await vm.addSound({ name: 'probe-sound', dataFormat: 'wav', format: '', rate: 44100, sampleCount: 8820, asset: null, md5ext: 'probe.wav', data: arr.buffer }, target.id);
      out.addSound = { ok: true, sounds: target.getSounds().map((s) => s.name) };
    } catch (e) { out.addSound = { ok: false, error: String(e && e.message || e) } }
  }` : 'out.addSound = { skipped: true };'}

  // 3. Duplicate + rename + delete a sprite.
  try {
    const before = rt.targets.map((t) => t.id);
    await vm.duplicateSprite(target.id);
    const created = rt.targets.find((t) => !before.includes(t.id));
    out.duplicate = { ok: true, name: created ? created.getName() : null };
    if (created) { vm.renameSprite(created.id, 'copy'); out.duplicate.renamed = created.getName(); vm.deleteSprite(created.id); out.duplicate.afterDelete = rt.targets.map((t) => t.getName()) }
  } catch (e) { out.duplicate = { ok: false, error: String(e && e.message || e) } }

  // 4. Comments: the bridge creates them with createComment(id, blockId, text, x, y, w, h, minimized).
  try {
    const c = target.createComment('probeComment', null, 'hello from the bridge', 20, 20, 200, 100, false);
    out.comment = { ok: true, type: c && c.constructor ? c.constructor.name : typeof c, hasToXML: !!(c && typeof c.toXML === 'function'), comments: Object.keys(target.comments) };
    const xml = target.blocks.toXML(target.comments);
    out.comment.xmlMentionsComment = String(xml).includes('probeComment');
    target.deleteComment('probeComment');
    out.comment.afterDelete = Object.keys(target.comments);
  } catch (e) { out.comment = { ok: false, error: String(e && e.message || e) } }

  // 5. Screenshot: request a redraw first, then snapshot.
  try {
    rt.requestRedraw();
    if (rt.renderer) rt.renderer.dirty = true;
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('snapshot timeout')), 10000);
      rt.renderer.requestSnapshot((d) => { clearTimeout(timer); resolve(d) });
    });
    out.snapshot = { ok: true, kind: typeof data, head: String(data).slice(0, 22), length: String(data).length };
  } catch (e) { out.snapshot = { ok: false, error: String(e && e.message || e) } }

  // 6. Run loop + glow handling.
  out.glow = { hasForceNoGlow: 'forceNoGlow' in target.blocks, scriptGlows: Array.isArray(rt._scriptGlowsPreviousFrame), quietGlow: typeof rt.quietGlow };
  out.postIO = { keyboard: typeof vm.postIOData };
  out.monitors = { getMonitorState: typeof rt.getMonitorState, timer: typeof rt.ioDevices.clock.projectTimer };
  return JSON.stringify(out);
})()`

console.log(JSON.stringify(JSON.parse(await evaluate(conn, script, { awaitPromise: true, timeoutMs: 120000 })), null, 1))
conn.close()
