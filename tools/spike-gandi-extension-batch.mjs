/**
 * Question for the editor: can it load **every** extension in its library?
 *
 * The single-extension probes answered "how does loading work" (see
 * `spike-gandi-extensions.mjs`). This one answers "does it work for all of them" —
 * which is the difference between "there is a tool that loads an extension" and "the
 * model can use the extension library".
 *
 * It walks the editor's own catalogue (93 ids on Gandi 1.0.5) and loads each one in
 * turn, recording what actually happened. Loading is the editor's own call, so a failure
 * here is the editor's answer, not this script's opinion.
 *
 * What each row means:
 *   - ok        : registered block info; `blocks`/`menus` say how much of its dialect
 *                 the plugin can read out.
 *   - noBlocks  : it loaded but registered nothing (a library entry with no blocks, or
 *                 one that only makes sense in another editor).
 *   - error     : loadExtensionURL rejected. The editor's own message is kept.
 *
 * Usage:
 *   node tools/spike-gandi-extension-batch.mjs                 # every enabled id, SKIPPING device-backed ones
 *   node tools/spike-gandi-extension-batch.mjs --devices       # include the camera/microphone ones (opens them!)
 *   node tools/spike-gandi-extension-batch.mjs --filter Gandi  # only ids containing this
 *   node tools/spike-gandi-extension-batch.mjs --limit 20      # stop after N
 *   node tools/spike-gandi-extension-batch.mjs --pause 400     # ms between loads (default 120)
 *   node tools/spike-gandi-extension-batch.mjs --json .spike/ext-batch.json
 *
 * DEVICE-BACKED EXTENSIONS ARE SKIPPED BY DEFAULT, and that default was earned: loading
 * one makes the editor open the camera or the microphone, which stays open until
 * something stops it. A full run of this script left the user's camera on (Windows
 * recorded Gandi.exe with lastUsedStop=0, and nothing else). Pass --devices to include
 * them, knowing that you are turning a camera on.
 *
 * It REPLACES nothing and writes nothing to the editor's project: loading an extension
 * adds a toolbox category, which cannot be undone without reloading the page. That is
 * the same thing a user does by clicking 添加扩展, so it is safe, but it does persist.
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { vmBootstrapSource } from '../src/bridge/gandi-vm.mjs'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const PORT = Number(process.env.PORT ?? 9222)
const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}
const filter = argOf('--filter', null)
const limit = Number(argOf('--limit', '0')) || null
const pause = Number(argOf('--pause', '120'))
const includeDevices = argv.includes('--devices')
const jsonOut = argOf('--json', join(root, '.spike', 'ext-batch.json'))

/**
 * Extensions whose LOAD opens the camera or the microphone. Kept as a list here as well
 * as in the plugin because this script must be safe by default: the plugin stops the
 * device again, but a probe that leaves a camera running is a probe nobody should run.
 */
const DEVICE_BACKED = /kamera|camera|face|video|recording|media|spine|dolly|pocket|voice|mic/i

const target = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
if (target === undefined) {
  console.log('editor not open')
  process.exit(1)
}
const conn = await CdpConnection.connect(target.webSocketDebuggerUrl)

/** Run page source that ends in an expression. */
const run = async (body, options = {}) => {
  const source = `(async () => {\n${vmBootstrapSource()}${body}\n})()`
  return evaluate(conn, source, { awaitPromise: true, timeoutMs: options.timeoutMs ?? 120000 })
}

/** The catalogue, in the order the editor lists it. */
const catalogue = await run(`
  const manager = vm.extensionManager || vm.runtime.extensionManager;
  const rows = [];
  const push = (map) => {
    for (const [key, entry] of Object.entries(map || {})) {
      const info = entry && entry.info !== undefined ? entry.info : entry;
      const inner = info && info.info !== undefined ? info.info : info;
      rows.push({
        id: String((inner && inner.extensionId) || key),
        key,
        disabled: inner && inner.disabled === true,
        featured: inner && inner.featured === true,
        hasOwnUrl: typeof info === 'object' && info !== null && typeof info.url === 'string' && info.url.length > 0
      });
    }
  };
  push(manager._officialExtensionInfo);
  push(manager._customExtensionInfo);
  return JSON.stringify({ rows, builtinIds: Object.keys(manager.builtinExtensions || {}) });
`)
const { rows, builtinIds } = JSON.parse(catalogue)
const builtin = new Set(builtinIds)

const selected = rows
  .filter((row) => row.disabled !== true)
  .filter((row) => filter === null || row.id.toLowerCase().includes(String(filter).toLowerCase()))
  .filter((row) => includeDevices || !DEVICE_BACKED.test(row.id))
  .slice(0, limit === null ? rows.length : limit)

const skippedDevices = rows.filter((row) => row.disabled !== true && DEVICE_BACKED.test(row.id)).map((row) => row.id)
console.log(`catalogue: ${rows.length} entries (${rows.filter((r) => r.disabled === true).length} disabled), loading ${selected.length}`)
if (skippedDevices.length > 0) {
  console.log(`skipping ${skippedDevices.length} device-backed extension(s) — loading them opens the camera/microphone: ${skippedDevices.join(', ')}`)
  console.log('(pass --devices to include them; the plugin stops the device afterwards, this script does not)')
}
console.log('id'.padEnd(34) + 'kind'.padEnd(10) + 'ms'.padStart(7) + '  blocks menus  result')

const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

for (const row of selected) {
  const outcome = await run(`
    const manager = vm.extensionManager || vm.runtime.extensionManager;
    const id = ${JSON.stringify(row.id)};
    const out = { id, kind: ${JSON.stringify(builtin.has(row.id) ? 'builtin' : 'library')} };
    const before = (vm.runtime._blockInfo || []).map((e) => String(e.id));
    if (before.includes(id)) {
      out.result = 'already';
    } else {
      const started = Date.now();
      try {
        await manager.loadExtensionURL(id);
        out.ms = Date.now() - started;
        out.result = 'ok';
      } catch (error) {
        out.ms = Date.now() - started;
        out.result = 'error';
        out.error = String(error && error.message ? error.message : error);
      }
    }
    const entry = (vm.runtime._blockInfo || []).find((e) => String(e.id) === id);
    out.loaded = entry !== undefined;
    out.blocks = entry === undefined || !Array.isArray(entry.blocks)
      ? 0
      : entry.blocks.filter((b) => b && b.info && typeof b.info.opcode === 'string' && b.info.opcode.length > 0).length;
    out.skipped = entry === undefined || !Array.isArray(entry.blocks)
      ? 0
      : entry.blocks.length - out.blocks;
    out.menus = entry === undefined || !Array.isArray(entry.menus) ? 0 : entry.menus.length;
    // A menu whose generated JSON has no type is the one shape the reader has to guess
    // at, so it is counted separately rather than hidden inside the total.
    out.menusWithoutType = entry === undefined || !Array.isArray(entry.menus)
      ? 0
      : entry.menus.filter((m) => m === null || m === undefined || m.json === undefined || typeof m.json !== 'object' || typeof m.json.type !== 'string').length;
    // The whole point: can the plugin turn each entry into a dialect?
    try {
      const describe = (info) => {
        const args = Object.entries(info.arguments || {}).map(([name, spec]) => ({
          name,
          shadow: spec && typeof spec.menu === 'string' && spec.menu.length > 0 ? true : false
        }));
        return { opcode: String(info.opcode), args };
      };
      out.describable = entry === undefined ? 0 : (entry.blocks || []).filter((b) => b && b.info && typeof b.info.opcode === 'string' && b.info.opcode.length > 0).length;
    } catch (error) {
      out.describable = -1;
    }
    // Some extensions arrive asynchronously (a worker, or a downloaded bundle); the
    // block info can still be filling in when loadExtensionURL resolves. Measure the
    // delay rather than assume it.
    if (out.result === 'ok') {
      const seen = out.blocks;
      await new Promise((r) => setTimeout(r, 1200));
      const entry2 = (vm.runtime._blockInfo || []).find((e) => String(e.id) === id);
      out.blocksAfterWait = entry2 === undefined ? 0 : (entry2.blocks || []).filter((b) => typeof b.info.opcode === 'string').length;
      out.arrivedLater = out.blocksAfterWait - seen;
    }
    return JSON.stringify(out);
  `, { timeoutMs: 180000 })

  const result = outcome === null || outcome === undefined ? { id: row.id, result: 'no-answer' } : JSON.parse(outcome)
  results.push({ ...row, ...result })
  console.log(
    String(result.id).padEnd(34) +
    String(result.kind ?? '').padEnd(10) +
    String(result.ms ?? '').padStart(7) + '  ' +
    String(result.blocks ?? 0).padStart(6) + ' ' +
    String(result.menus ?? 0).padStart(5) + '  ' +
    (result.result === 'error' ? `ERROR: ${String(result.error).slice(0, 60)}` : result.result) +
    (result.arrivedLater > 0 ? ` (+${result.arrivedLater} blocks arrived later)` : '')
  )
  await sleep(pause)
}

const summary = {
  total: results.length,
  ok: results.filter((r) => r.result === 'ok' || r.result === 'already').length,
  errors: results.filter((r) => r.result === 'error').length,
  noBlocks: results.filter((r) => (r.result === 'ok' || r.result === 'already') && (r.blocks ?? 0) === 0).length,
  arrivedLater: results.filter((r) => (r.arrivedLater ?? 0) > 0).map((r) => r.id),
  errorIds: results.filter((r) => r.result === 'error').map((r) => ({ id: r.id, error: r.error })),
  emptyIds: results.filter((r) => (r.result === 'ok' || r.result === 'already') && (r.blocks ?? 0) === 0).map((r) => r.id),
  menusWithoutType: results.filter((r) => (r.menusWithoutType ?? 0) > 0).map((r) => ({ id: r.id, count: r.menusWithoutType }))
}

console.log('\n=== summary ===')
console.log(JSON.stringify(summary, null, 1))
await writeFile(jsonOut, `${JSON.stringify({ summary, results }, null, 1)}\n`, 'utf8')
console.log(`written to ${jsonOut}`)

conn.close()
