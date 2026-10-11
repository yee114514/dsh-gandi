/**
 * Question for the editor: will a project that uses an EXTENSION actually open?
 *
 * `gandi_spike_extensions` answers what the extension API looks like; this one answers
 * the question the plugin's design depends on:
 *
 *   1. does a project whose blocks are `music_*` — an opcode prefix that is NOT a
 *      Scratch category — load at all, and does the editor load the extension by itself
 *      when the blocks name it (with or without the document's `extensions` array)?
 *   2. what does an extension block, and the dropdown shadow under it, look like in a
 *      SAVED archive? That byte shape is the one the offline compiler has to produce.
 *   3. does the dropdown value survive a save -> load -> save round trip?
 *
 * It writes three archives under .spike/ so the answers can be read with plain unzip
 * rather than trusted from this script's summary.
 *
 * Safety: it snapshots the open project to .spike/ext-backup-<stamp>.sb3 first, loads
 * its own scratch project (which REPLACES whatever was open), and restores the snapshot
 * at the end unless --keep is passed. Nothing on disk outside .spike/ is touched.
 *
 * Usage:
 *   node tools/spike-gandi-extension-project.mjs [--keep] [--ext music] [--restore <file>]
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { vmBootstrapSource } from '../src/bridge/gandi-vm.mjs'
import { starterProject, writeSb3, readSb3 } from '../src/scratch/sb3.mjs'
import { compileScripts } from '../src/scratch/xml.mjs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT ?? 9222)
const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const extFlag = argv.indexOf('--ext')
const EXT = extFlag === -1 ? 'music' : argv[extFlag + 1]
const restoreFlag = argv.indexOf('--restore')

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', '.spike')
await mkdir(outDir, { recursive: true })

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const log = (...args) => console.log(...args)

const target = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
if (target === undefined) {
  console.log('editor not open')
  process.exit(1)
}
const conn = await CdpConnection.connect(target.webSocketDebuggerUrl)

/** Run page source that ends in an expression. */
const run = async (label, body, options = {}) => {
  const source = `(async () => {\n${vmBootstrapSource()}${body}\n})()`
  try {
    const value = await evaluate(conn, source, { awaitPromise: true, timeoutMs: options.timeoutMs ?? 120000 })
    if (options.quiet !== true) {
      log(`\n=== ${label} ===`)
      log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
    }
    return value
  } catch (error) {
    log(`\n=== ${label} === FAILED`)
    log(String(error && error.message ? error.message : error))
    return null
  }
}

/** The open project as archive bytes (the only faithful snapshot: JSON has no assets). */
const snapshot = async (path) => {
  const base64 = await run('snapshot', `
    const buffer = await vm.saveProjectSb3('arraybuffer');
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(binary);
  `, { quiet: true })
  if (typeof base64 !== 'string') throw new Error('could not snapshot the open project')
  await writeFile(path, Buffer.from(base64, 'base64'))
  return path
}

/** Load an archive into the editor, chunked so no single evaluate payload is huge. */
const load = async (bytes, label) => {
  const base64 = Buffer.from(bytes).toString('base64')
  await evaluate(conn, '(() => { globalThis.__dshChunks = []; return true })()', { timeoutMs: 10000 })
  for (let offset = 0; offset < base64.length; offset += 256 * 1024) {
    const chunk = base64.slice(offset, offset + 256 * 1024)
    await evaluate(conn, `(() => { globalThis.__dshChunks.push(${JSON.stringify(chunk)}); return true })()`, { timeoutMs: 30000 })
  }
  return run(`load ${label}`, `
    const joined = globalThis.__dshChunks.join('');
    delete globalThis.__dshChunks;
    const binary = atob(joined);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const t0 = Date.now();
    await vm.loadProject(bytes.buffer);
    const rt = vm.runtime;
    return JSON.stringify({
      ms: Date.now() - t0,
      targets: rt.targets.map((t) => t.getName()),
      blockOpcodes: rt.targets.flatMap((t) => Object.values(t.blocks._blocks ?? {}).map((b) => b.opcode).filter(Boolean)),
      blockInfo: (rt._blockInfo ?? []).map((i) => ({ id: i.id, blocks: (i.blocks ?? []).length })),
      isMusicLoaded: rt.extensionManager === undefined ? null : rt.extensionManager.isExtensionLoaded !== undefined ? 'manager' : null,
      extensionsArray: vm.runtime.getTargetForStage() === null ? null : undefined
    }, null, 1);
  `)
}

// ---- 1. work out the dialect by asking the editor for the extension's own definitions
await run('load extension', `
  const rt = vm.runtime;
  const em = vm.extensionManager ?? rt.extensionManager;
  if (em === null || em === undefined) return 'no manager';
  const url = ${JSON.stringify(EXT)};
  await em.loadExtensionURL(url);
  const info = (rt._blockInfo ?? []).find((i) => i.id === ${JSON.stringify(EXT)});
  if (info === undefined) return 'extension did not register any block info';
  return JSON.stringify({
    id: info.id,
    name: info.name,
    color1: info.color1,
    blocks: (info.blocks ?? []).map((b) => ({
      opcode: b.info.opcode,
      blockType: b.info.blockType,
      text: b.info.text,
      args: Object.entries(b.info.arguments ?? {}).map(([name, spec]) => ({
        name,
        type: spec.type,
        menu: spec.menu === undefined ? null : String(spec.menu),
        defaultValue: spec.defaultValue === undefined ? null : spec.defaultValue
      }))
    })),
    menus: (info.menus ?? []).map((m) => ({ id: m.id ?? m.name, json: String(m.json ?? '').slice(0, 300) }))
  }, null, 1);
`, { timeoutMs: 60000 })

// ---- 2. build a project that uses it: one command block with a literal, and the
// dropdown block whose menu shadow is the interesting one.
const { project, assets } = starterProject({ spriteName: 'extSprite' })
project.extensions = [EXT]

const commandOpcode = `${EXT}_restForBeats`
const menuOpcode = `${EXT}_playDrumForBeats`
const xml = `<xml>
  <block type="event_whenflagclicked" x="40" y="40">
    <next>
      <block type="${commandOpcode}">
        <value name="BEATS"><shadow type="math_number"><field name="NUM">0.5</field></shadow></value>
        <next>
          <block type="${menuOpcode}">
            <value name="DRUM"><shadow type="${EXT}_menu_DRUM"><field name="DRUM">3</field></shadow></value>
            <value name="BEATS"><shadow type="math_number"><field name="NUM">0.5</field></shadow></value>
          </block>
        </next>
      </block>
    </next>
  </block>
</xml>`

const compiled = compileScripts(xml)
log(`\ncompiled: ${Object.keys(compiled.blocks).length} blocks, warnings=${JSON.stringify(compiled.warnings)}, errors=${JSON.stringify(compiled.errors ?? [])}`)
const sprite = project.targets.find((t) => t.name === 'extSprite')
Object.assign(sprite.blocks, compiled.blocks)

const withExt = writeSb3(project, assets)
const withExtPath = join(outDir, `ext-project-${EXT}.sb3`)
await writeFile(withExtPath, withExt)
log(`wrote ${withExtPath} (${withExt.length} bytes)`)

// The same project WITHOUT the extensions array: the deserializer is supposed to read
// the prefix off the opcode, so this decides whether the array is load-bearing.
const withoutArray = JSON.parse(JSON.stringify(project))
delete withoutArray.extensions
const noArrayPath = join(outDir, `ext-project-${EXT}-no-array.sb3`)
const missing = { ...assets }
const noArrayBytes = writeSb3(withoutArray, missing)
await writeFile(noArrayPath, noArrayBytes)
log(`wrote ${noArrayPath} (${noArrayBytes.length} bytes)`)

// ---- 3. look at what we just wrote, offline
const reread = readSb3(withExt)
const rereadSprite = reread.project.targets.find((t) => t.name === 'extSprite')
log('\n=== archive, offline read ===')
log(JSON.stringify({
  extensions: reread.project.extensions,
  blocks: Object.entries(rereadSprite.blocks).map(([id, b]) => ({
    id: id.slice(0, 6),
    opcode: b.opcode,
    inputs: b.inputs,
    fields: b.fields,
    topLevel: b.topLevel
  }))
}, null, 1))

// ---- 4. the live question: does it open?
const backupPath = join(outDir, `ext-backup-${stamp}.sb3`)
await snapshot(backupPath)
log(`\nsnapshotted the open project -> ${backupPath}`)

await load(withExt, `project with extensions: ["${EXT}"]`)
await run('state after loading, with the array', `
  const rt = vm.runtime;
  const em = vm.extensionManager ?? rt.extensionManager;
  const info = (rt._blockInfo ?? []).find((i) => i.id === ${JSON.stringify(EXT)});
  const sprite = rt.targets.find((t) => t.getName() === 'extSprite');
  return JSON.stringify({
    editorTargets: rt.targets.map((t) => t.getName()),
    extensionLoaded: em.isExtensionLoaded(${JSON.stringify(EXT)}),
    blockInfoIds: (rt._blockInfo ?? []).map((i) => i.id),
    opcodesInBlocks: sprite === undefined ? null : Object.values(sprite.blocks._blocks ?? {}).map((b) => b.opcode).filter(Boolean),
    toolboxHasExtensionCategory: (() => {
      const B = globalThis.Blockly;
      const ws = B && B.getMainWorkspace ? B.getMainWorkspace() : null;
      const tb = ws && ws.getToolbox ? ws.getToolbox() : null;
      if (tb === null || tb === undefined || typeof tb.getToolboxItems !== 'function') return null;
      return tb.getToolboxItems().map((it) => (it.getName ? it.getName() : null)).filter((n) => n !== null).slice(0, 40);
    })()
  }, null, 1);
`, { quiet: false })

await load(noArrayBytes, 'project WITHOUT the extensions array')
await run('state after loading, without the array', `
  const rt = vm.runtime;
  const em = vm.extensionManager ?? rt.extensionManager;
  return JSON.stringify({
    editorTargets: rt.targets.map((t) => t.getName()),
    extensionLoaded: em.isExtensionLoaded(${JSON.stringify(EXT)}),
    blockInfoIds: (rt._blockInfo ?? []).map((i) => i.id)
  }, null, 1);
`)

// ---- 5. round trip: save what the editor has, read it back offline
const roundTrip = await run('round trip: save', `
  const buffer = await vm.saveProjectSb3('arraybuffer');
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(binary);
`, { quiet: true })
if (typeof roundTrip === 'string') {
  const roundTripPath = join(outDir, `ext-roundtrip-${EXT}.sb3`)
  await writeFile(roundTripPath, Buffer.from(roundTrip, 'base64'))
  const back = readSb3(await readFile(roundTripPath))
  const spriteBack = back.project.targets.find((t) => t.name === 'extSprite')
  log(`\n=== round trip archive: ${roundTripPath} ===`)
  log(JSON.stringify({
    extensions: back.project.extensions,
    blocks: spriteBack === undefined ? null : Object.entries(spriteBack.blocks).map(([id, b]) => ({
      id: id.slice(0, 6), opcode: b.opcode, inputs: b.inputs, fields: b.fields, topLevel: b.topLevel
    }))
  }, null, 1))
}

// ---- restore
const restoreFrom = restoreFlag === -1 ? backupPath : argv[restoreFlag + 1]
if (!keep) {
  await load(await readFile(restoreFrom), `restored snapshot (${restoreFrom})`)
  log('\nrestored the project that was open before this probe ran')
} else {
  log(`\n--keep: the editor now holds the probe project; snapshot of the original: ${backupPath}`)
}

conn.close()
