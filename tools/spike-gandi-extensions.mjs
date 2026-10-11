/**
 * Question for the editor: how does loading an EXTENSION work here?
 *
 * "Extension" in Scratch means the block categories you add from the 「添加扩展」 button
 * (music, pen, video sensing, text-to-speech, …). Their blocks are not in the project
 * document until the extension is loaded into the running VM, so the plugin currently
 * cannot write them and the project parser treats their opcode prefix as an unknown
 * extension id.
 *
 * This probe answers, with the editor's own output:
 *   - where the extension API lives on the VM (and what its methods are);
 *   - what an already-loaded extension looks like (id, blocks, menus, toolbox category);
 *   - whether `extensionManager.loadExtensionURL(...)` is a usable entry point, and
 *     what it does to `vm.runtime._blockInfo`, `vm.extensionManager._loadedExtensions`
 *     and the project's `extensions` list;
 *   - where Gandi actually fetches extension bundles from (so a URL can be built
 *     without guessing a CDN host).
 *
 * Usage:
 *   node tools/spike-gandi-extensions.mjs                  # inspect only
 *   node tools/spike-gandi-extensions.mjs --load music     # then load `music` and re-inspect
 *   node tools/spike-gandi-extensions.mjs --load music --url <url>
 *
 * The load step runs INSIDE the editor's page, one step at a time, so every failure is
 * reported by the editor rather than swallowed.
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { vmBootstrapSource } from '../src/bridge/gandi-vm.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const argv = process.argv.slice(2)
const loadIndex = argv.indexOf('--load')
const wantLoad = loadIndex === -1 ? null : argv[loadIndex + 1]
const urlIndex = argv.indexOf('--url')
const wantUrl = urlIndex === -1 ? null : argv[urlIndex + 1]

const target = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
if (target === undefined) {
  console.log('editor not open')
  process.exit(1)
}
const conn = await CdpConnection.connect(target.webSocketDebuggerUrl)

/** Run page-side source that ends in an expression, and print whatever comes back. */
const run = async (label, body) => {
  const source = `(async () => {\n${vmBootstrapSource()}${body}\n})()`
  try {
    // awaitPromise: the page source is an async IIFE, and without it the reply is an
    // unresolved Promise serialised as {} — which reads exactly like "no extension API".
    const raw = await evaluate(conn, source, { awaitPromise: true })
    console.log(`\n=== ${label} ===`)
    console.log(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 1))
    return raw
  } catch (error) {
    console.log(`\n=== ${label} === FAILED`)
    console.log(String(error && error.message ? error.message : error))
    return null
  }
}

const INSPECT = `
  const json = (v) => { try { return JSON.parse(JSON.stringify(v)) } catch (e) { return String(v) } };
  const proto = (o) => o === null || o === undefined ? null : Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter((m) => m !== 'constructor');
  const rt = vm.runtime;
  const em = vm.extensionManager ?? rt.extensionManager ?? null;
  const out = {};

  out.vmExtensionKeys = Object.keys(vm).filter((k) => /extension/i.test(k));
  out.runtimeExtensionKeys = Object.keys(rt).filter((k) => /extension/i.test(k));
  out.managerFound = em !== null;
  if (em !== null) {
    out.managerProto = proto(em);
    out.managerOwnKeys = Object.keys(em);
    out.loadedExtensions = json(em._loadedExtensions ?? null);
    out.loadedIds = em._loadedExtensions === undefined || em._loadedExtensions === null
      ? null : Object.keys(em._loadedExtensions);
    out.builtinExtensionIds = json(em.builtinExtensions === undefined ? null : Object.keys(em.builtinExtensions));
    out.builtinNames = json(em.builtinExtensions === undefined ? null
      : Object.fromEntries(Object.entries(em.builtinExtensions).map(([k, v]) => [k, v && v.name])));
    out.workerURL = em.workerURL ?? null;
    out.extensionURLs = json(em.extensionURLs ?? null);
  }

  // What a loaded extension looks like inside the runtime: this is the shape the plugin
  // needs in order to write its blocks and its dropdown shadows.
  out.blockInfo = (rt._blockInfo ?? []).map((info) => ({
    id: info.id,
    name: info.name,
    hasBlocks: Array.isArray(info.blocks),
    blockCount: Array.isArray(info.blocks) ? info.blocks.length : null,
    sampleOpcode: Array.isArray(info.blocks) && info.blocks.length > 0 ? info.blocks[0].info.opcode : null,
    menus: Array.isArray(info.menus) ? info.menus.map((m) => m.id ?? m.name) : null,
    color1: info.color1 ?? null
  }));

  // The extension blocks as the plugin would have to write them: opcode, shape,
  // argument names and the menu each dropdown points at. info.opcode is what lands in
  // the project document; whether it already carries the extension prefix decides
  // whether the plugin has to add it.
  out.extensionBlocks = (rt._blockInfo ?? []).map((info) => ({
    id: info.id,
    blocks: (info.blocks ?? []).map((b) => ({
      opcode: b.info.opcode,
      blockType: b.info.blockType,
      text: b.info.text,
      args: (Array.isArray(b.info.arguments)
        ? b.info.arguments
        : Object.entries(b.info.arguments ?? {}).map(([name, spec]) => ({ name, ...spec }))
      ).map((a) => ({
        name: a.name, type: a.type,
        menu: a.menu === undefined ? null : String(a.menu),
        defaultValue: a.defaultValue === undefined ? null : a.defaultValue
      })),
      rawArgKeys: Array.isArray(b.info.arguments) ? 'array' : Object.keys(b.info.arguments ?? {}),
      menuRaw: b.info.menu === undefined ? null : JSON.stringify(b.info.menu).slice(0, 200),
      func: b.info.func ?? null
    })),
    menus: (info.menus ?? []).map((m) => ({
      id: m.id ?? m.name,
      json: JSON.stringify(m.json ?? null).slice(0, 200),
      items: Array.isArray(m.items) ? m.items.map((i) => (Array.isArray(i) ? i[0] : i)) : null
    }))
  }));

  // How the editor says "this extension is loaded", and how a project records it.
  out.isExtensionLoadedMusic = em === null ? null : em.isExtensionLoaded('music');
  out.loadedMapKeys = em === null || em._loadedExtensions === undefined || em._loadedExtensions === null
    ? null : Object.keys(em._loadedExtensions);
  out.loadedMapSize = em === null || em._loadedExtensions === undefined || em._loadedExtensions === null
    ? null : (typeof em._loadedExtensions.size === 'number' ? em._loadedExtensions.size : Object.keys(em._loadedExtensions).length);
  out.runtimeExtensionIds = json(rt.extensionManager === undefined ? null : 'has');
  out.ccwAPIExtensionMethods = rt.ccwAPI === undefined || rt.ccwAPI === null ? null
    : Object.fromEntries(Object.entries(rt.ccwAPI)
      .filter(([k, v]) => /extension/i.test(k) && typeof v === 'function')
      .map(([k, v]) => [k, typeof v === 'function' ? String(v).slice(0, 220) : typeof v]));
  out.gandiKeys = rt.gandi === undefined || rt.gandi === null ? null : Object.keys(rt.gandi);
  out.wildExtensions = rt.gandi === undefined || rt.gandi === null ? null : json(rt.gandi.wildExtensions ?? null);
  out.extensionButtons = json(rt.extensionButtons ?? null) === undefined ? null : json(rt.extensionButtons ?? null);
  out.extensionStorage = typeof rt.extensionStorage;

  // The project document's own list, which is what the serializer writes at export.
  const docNow = (() => { try { return vm.toJSON() } catch (error) { return null } })();
  out.docExtensions = docNow === null ? null : docNow.extensions;
  out.docExtensionKeys = docNow === null ? null : Object.keys(docNow);
  out.docTopLevel = docNow === null ? null : Object.keys(docNow);

  // How the runtime names an extension block. This settles the one question the plugin
  // cannot guess: whether the opcode written into the project document carries the
  // extension id prefix. The editor's own XML for an extension block is the answer.
  const et = vm.editingTarget;
  if (et !== null && et !== undefined) {
    const ext = (rt._blockInfo ?? [])[0] ?? null;
    if (ext !== null && Array.isArray(ext.blocks) && ext.blocks.length > 0) {
      const info = ext.blocks[0].info;
      const id = 'dsh-probe-' + Date.now().toString(36);
      let created = null;
      let xml = null;
      try {
        et.blocks.createBlock({
          id,
          opcode: info.opcode,
          inputs: {},
          fields: {},
          next: null,
          parent: null,
          shadow: false,
          topLevel: true,
          x: 40,
          y: 40
        }, 'dsh-probe');
        created = id;
        xml = et.blocks.toXML ? String(et.blocks.toXML()).slice(0, 1200) : null;
        const stored = et.blocks.getBlock(id);
        out.createdBlock = {
          id,
          requestedOpcode: info.opcode,
          storedOpcode: stored === null || stored === undefined ? null : stored.opcode
        };
      } catch (error) {
        out.createdBlock = { id, requestedOpcode: info.opcode, threw: String(error && error.message ? error.message : error) };
      } finally {
        try { et.blocks.deleteBlock(id) } catch (error) { /* nothing to clean */ }
      }
      out.blockXmlSample = xml;
    }
  }

  // Gandi's own extension library, if the shell keeps one around.
  const store = globalThis.__dshGandiStore ?? null;
  out.storeSlices = store === null ? null : Object.keys(store.getState());
  if (store !== null) {
    const state = store.getState();
    out.extensionSlices = Object.fromEntries(Object.entries(state)
      .filter(([k]) => /extension|toolbox|library/i.test(k))
      .map(([k, v]) => [k, json(v) === undefined ? null : Object.keys(v ?? {})]));
    const tg = state.scratchGui ?? {};
    out.scratchGuiKeys = Object.keys(tg);
    out.toolboxSlice = tg.toolbox === undefined ? null : json(tg.toolbox);
  }

  // Where extension bundles come from: real network traffic beats guessing a host.
  out.hosts = [...new Set(performance.getEntriesByType('resource')
    .map((e) => e.name)
    .filter((n) => /extension|gandi\\/|ccw|xiaohongshu|assets/i.test(n))
    .map((n) => { try { return new URL(n).host + new URL(n).pathname.replace(/[^/]*$/, '') } catch (e) { return n } }))].slice(0, 40);

  // The workspace toolbox: extension categories appear here once loaded.
  const B = globalThis.Blockly;
  const ws = B && B.getMainWorkspace ? B.getMainWorkspace() : null;
  const flyout = ws === null ? null : (ws.getFlyout ? ws.getFlyout() : null);
  out.toolbox = ws === null ? null : {
    hasToolbox: typeof ws.getToolbox === 'function' ? ws.getToolbox() !== null : null,
    categories: (() => {
      const tb = typeof ws.getToolbox === 'function' ? ws.getToolbox() : null;
      if (tb === null || tb === undefined || typeof tb.getToolboxItems !== 'function') return null;
      return tb.getToolboxItems().map((it) => ({
        name: it.getName ? it.getName() : null,
        id: it.getId ? it.getId() : null,
        kind: it.getKind ? it.getKind() : null,
        contents: typeof it.getContents === 'function' && Array.isArray(it.getContents())
          ? it.getContents().length : null
      }));
    })(),
    flyoutBlockCount: flyout === null || typeof flyout.getWorkspace !== 'function'
      ? null : flyout.getWorkspace().getAllBlocks(false).length
  };

  // Where the editor's own extension library comes from. addOfficialExtensionInfo /
  // addCustomExtensionInfo take (id, info), so the constructors here are the map the
  // 添加扩展 button reads — including the URLs of Gandi's own (ccw) extensions.
  const describeInfo = (info) => info === null || info === undefined ? null : {
    keys: Object.keys(info),
    id: info.id ?? null, name: info.name ?? info.extensionName ?? null,
    url: info.url ?? info.extensionURL ?? null,
    blocks: Array.isArray(info.blocks) ? info.blocks.length : null,
    menus: Array.isArray(info.menus) ? info.menus.length : null
  };
  out.officialExtensionInfo = em === null ? null
    : Object.fromEntries(Object.entries(em._officialExtensionInfo ?? {}).map(([k, v]) => [k, describeInfo(v)]));
  out.customExtensionInfo = em === null ? null
    : Object.fromEntries(Object.entries(em._customExtensionInfo ?? {}).map(([k, v]) => [k, describeInfo(v)]));
  out.gandiExternalServices = em === null ? null : json(em._gandiExternalExtensionServices ?? null);

  // The full catalogue, one entry per extension the 「添加扩展」 button can offer:
  // id, human name, the URL its bundle is fetched from, and its block/menu counts.
  if (em !== null) {
    const flat = (map, kind) => Object.entries(map ?? {}).map(([key, entry]) => {
      const info = entry && entry.info !== undefined ? entry.info : entry;
      const inner = info && info.info !== undefined ? info.info : info;
      return {
        key, kind,
        entryKeys: entry === null || entry === undefined ? null : Object.keys(entry),
        infoKeys: inner === null || inner === undefined ? null : Object.keys(inner),
        id: inner && (inner.id ?? inner.extensionId) !== undefined ? (inner.id ?? inner.extensionId) : null,
        name: inner && (inner.name ?? inner.extensionName) !== undefined ? (inner.name ?? inner.extensionName) : null,
        url: inner && (inner.url ?? inner.extensionURL ?? inner.scriptURL) !== undefined
          ? (inner.url ?? inner.extensionURL ?? inner.scriptURL) : null,
        blocks: inner && Array.isArray(inner.blocks) ? inner.blocks.length : null,
        menus: inner && Array.isArray(inner.menus) ? inner.menus.length : null,
        l10nKeys: entry && entry.l10n !== undefined && entry.l10n !== null ? Object.keys(entry.l10n).slice(0, 12) : null,
        sampleBlock: inner && Array.isArray(inner.blocks) && inner.blocks.length > 0 ? json(inner.blocks[0]).slice(0, 400) : null
      };
    });
    out.catalogue = [...flat(em._officialExtensionInfo, 'official'), ...flat(em._customExtensionInfo, 'custom')];
    out.builtinIds = Object.keys(em.builtinExtensions ?? {});

    // For the extension we are about to load: what the catalogue entry actually holds,
    // and the source of the functions that load it. A catalogue entry with no URL means
    // the bundle is not fetched from the entry — loadExtensionIdSync must resolve it
    // some other way, and the only trustworthy answer is its own source text.
    const infoOf = (id) => {
      const entry = (em._officialExtensionInfo ?? {})[id] ?? (em._customExtensionInfo ?? {})[id] ?? null;
      if (entry === null) return null;
      const info = entry.info !== undefined ? entry.info : entry;
      const inner = info && info.info !== undefined ? info.info : info;
      return {
        entryKeys: Object.keys(entry),
        innerKeys: inner === null || inner === undefined ? null : Object.keys(inner),
        inner: JSON.stringify(json(inner)).slice(0, 1500),
        ctor: (() => {
          const c = inner && (inner.constructor ?? inner.extensionConstructor ?? inner.Extension);
          return typeof c === 'function' ? String(c).slice(0, 600) : null;
        })()
      };
    };
    if (${JSON.stringify(wantLoad)} !== null) {
      out.catalogueEntryForLoad = infoOf(${JSON.stringify(wantLoad)});
      out.loaderSources = {
        loadExtensionIdSync: String(em.loadExtensionIdSync).slice(0, 1200),
        loadExtensionURL: String(em.loadExtensionURL).slice(0, 900),
        isBuiltinExtension: String(em.isBuiltinExtension).slice(0, 700),
        loadExternalExtensionById: String(em.loadExternalExtensionById ?? '').slice(0, 700),
        _registerInternalExtension: String(em._registerInternalExtension ?? '').slice(0, 700),
        getLoadedExtensionURLs: String(em.getLoadedExtensionURLs ?? '').slice(0, 500)
      };
    }
  }

  // The VM's own view of "what extensions does this project use", which is what the
  // serializer writes into the project document's extensions array.
  out.vmExtensionMethods = Object.fromEntries(['extensionManager', 'getBlocksXML', 'toJSON', 'saveProjectSb3']
    .map((k) => [k, typeof vm[k]]));

  // What the editor's extension library UI is: is it a Scratch GUI tab (a React
  // component reading a catalogue) or something Gandi added?
  const root = document.getElementById('root');
  const entry = root === null ? undefined : Object.keys(root).find((k) => k.startsWith('__reactContainer'));
  out.guiTabs = [];
  out.libraryHints = [];
  if (entry !== undefined) {
    const seen = new Set(); let visited = 0;
    const walk = (fiber, depth) => {
      if (fiber === null || depth > 120 || visited > 60000) return;
      if (seen.has(fiber)) return;
      seen.add(fiber); visited++;
      const props = fiber.memoizedProps;
      if (props !== null && props !== undefined) {
        if (typeof props.onClickLibraryItem === 'function' || typeof props.onCategorySelected === 'function') {
          const name = props.name ?? (props.extension && props.extension.name) ?? null;
          if (name !== null) out.libraryHints.push(String(name));
        }
        if (Array.isArray(props.extensions) && props.extensions.length > 0 && out.guiTabs.length < 5) {
          out.guiTabs.push(json(props.extensions.slice(0, 3)));
        }
        if (props.extension !== undefined && props.extension !== null && out.libraryHints.length < 400) {
          const e = props.extension;
          if (e.extensionId !== undefined || e.id !== undefined) out.libraryHints.push(String(e.extensionId ?? e.id));
        }
      }
      walk(fiber.child, depth + 1); walk(fiber.sibling, depth);
    };
    walk(root[entry], 0);
  }
  out.libraryHints = [...new Set(out.libraryHints)].slice(0, 200);
  return JSON.stringify(out, null, 1);
`

await run('extension surface, before', INSPECT)

if (wantLoad !== null) {
  const url = wantUrl ?? wantLoad
  await run(`loadExtensionURL(${JSON.stringify(url)})`, `
    const rt = vm.runtime;
    const em = vm.extensionManager ?? rt.extensionManager ?? null;
    if (em === null) return 'no extension manager';
    const before = (rt._blockInfo ?? []).length;
    const t0 = Date.now();
    let result = null;
    try {
      result = await em.loadExtensionURL(${JSON.stringify(url)});
    } catch (error) {
      return JSON.stringify({ threw: String(error && error.message ? error.message : error), ms: Date.now() - t0 }, null, 1);
    }
    return JSON.stringify({
      url: ${JSON.stringify(url)},
      ms: Date.now() - t0,
      resultIsArray: Array.isArray(result),
      resultIds: Array.isArray(result) ? result.map((e) => e && e.id) : null,
      blockInfoBefore: before,
      blockInfoAfter: (rt._blockInfo ?? []).length,
      loadedIds: em._loadedExtensions === undefined || em._loadedExtensions === null ? null : Object.keys(em._loadedExtensions)
    }, null, 1);
  `)
  await run('extension surface, after', INSPECT)
}

conn.close()
