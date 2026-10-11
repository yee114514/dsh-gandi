/**
 * Acceptance for "the model can use the extension LIBRARY", not just one extension.
 *
 * `spike-gandi-extension-batch.mjs` proves every library extension LOADS and that its
 * block info can be read. Loading is necessary but not sufficient: what matters is that
 * a model can *write blocks* for an arbitrary extension and have them work. This script
 * does exactly that, through the plugin's own tool surface, for a spread of extensions
 * picked to be different from each other (see `PICKS`): the biggest block sets, one with
 * several menus, the 3D one, Gandi's own AI hub, and the plainest community ones.
 *
 * For each pick it:
 *   1. loads the extension through `gandi_extension {action:'load'}`;
 *   2. writes a three-block script through `gandi_apply`, USING ONLY THE DIALECT THE
 *      TOOL PRINTED — no hand-written opcode, no hand-written shadow type;
 *   3. runs it (`gandi_run`) and checks nothing threw at runtime;
 *   4. reads the editor's own project JSON back and checks the stored opcode carries the
 *      extension prefix and that a menu argument really became a shadow BLOCK.
 *
 * It snapshots the open project and restores it at the end (unless --keep), because
 * writing scripts into whatever is open would otherwise be destructive. Loading
 * extensions is not undone — it cannot be, short of reloading the page — which is the
 * same side effect as a user clicking 添加扩展.
 *
 * Usage:
 *   node tools/spike-gandi-extension-write.mjs [--keep] [--limit 3]
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { apply } from '../src/index.mjs'
import { extensionFacts, loadExtension } from '../src/bridge/extensions.mjs'
import { listTargets, CdpConnection } from '../src/bridge/cdp.mjs'
import { exportSb3, getProjectJson, loadProjectBytes } from '../src/bridge/ops.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, '.spike')
const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const limitFlag = argv.indexOf('--limit')
const limit = limitFlag === -1 ? null : Number(argv[limitFlag + 1])

/**
 * Extensions chosen to be unlike each other: the two biggest block sets (one of them a
 * community extension), one with many menus, the 3D one, Gandi's AI hub, and two small
 * community ones. If the writer works for these, the same code path works for the rest.
 */
const PICKS = [
  'moreDataTypes', 'arkosExtensions', 'witCat.dollyPro', 'WitCatMouse',
  'box2d', 'CCW3D', 'GandiAIHub', 'pen', 'text2speech', 'VIDateTime', 'rxfs', 'Biter'
]

const port = Number(process.env.GANDI_PORT ?? '9222')

let failures = 0
let checks = 0
const check = (label, condition, detail) => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

const harness = (config) => {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: () => undefined,
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    }
  }
  apply(ctx, config)
  const call = async (name, args = {}) => {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`no such tool: ${name}`)
    const value = await definition.execute(args, { agent: { id: 'ext-write', session: { header: { id: 'ext-write-session', cwd: root } } } })
    const blocks = definition.output.render(args, value)
    return { value, text: blocks[0].text }
  }
  call.dispose = () => { while (disposers.length > 0) disposers.pop()() }
  return call
}

/**
 * A block type is usable in XML when its inputs are either plain values or dropdown
 * shadows. Every input in an extension dialect is one or the other; a block with no
 * inputs at all is the only thing this cannot make a script out of.
 */
const writable = (block) => block.valueInputs.length > 0 || block.statementInputs.length > 0

/**
 * Turn ONE dialect block into the XML a model would write for it, using only what the
 * tool printed: the opcode, the input names, and each menu's shadow type + field name.
 */
const xmlForBlock = (block, menus) => {
  const shadowFor = (input) => {
    const shadow = block.menuInputs[input]
    if (shadow === undefined) return '<shadow type="math_number"><field name="NUM">1</field></shadow>'
    const shape = menus.find((menu) => menu.shadow === shadow)
    const field = shape?.field ?? input
    const value = shape?.firstOption ?? '1'
    return `<shadow type="${shadow}"><field name="${field}">${value}</field></shadow>`
  }
  const args = block.valueInputs.map((input) => `<value name="${input}">${shadowFor(input)}</value>`).join('')
  return `<block type="${block.opcode}"${args ? '' : ''}>${args}</block>`
}

/** Wrap one block in a green-flag hat, so `gandi_run` has something to start. */
const scriptFor = (block, menus) => `<xml>
  <block type="event_whenflagclicked" x="40" y="40">
    <next>${xmlForBlock(block, menus)}</next>
  </block>
</xml>`

const call = harness({ port, debug: false })
const targets = await listTargets(port)
const page = targets.find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
if (page === undefined) throw new Error('no editor tab: call gandi_launch first')
const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)
await mkdir(outDir, { recursive: true })

const backup = join(outDir, `ext-write-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sb3`)
await writeFile(backup, await exportSb3(connection))
console.log(`snapshotted the open project -> ${backup}`)

const facts = await extensionFacts(connection)
const loaded = new Set(facts.loadedIds ?? [])

const picks = PICKS.filter((id) => (facts.catalogueIds ?? []).includes(id)).slice(0, limit === null ? PICKS.length : limit)

try {
  for (const id of picks) {
    console.log(`\n=== ${id} ===`)
    const loadedResult = await call('gandi_extension', { action: 'load', id })
    check(`${id}: loads through the tool`, /loaded .* into the editor|was already loaded/.test(loadedResult.text), loadedResult.text.split('\n')[0])
    const dialect = (await extensionFacts(connection)).loaded.find((extension) => extension.id === id)
    check(`${id}: the tool exposed a dialect`, dialect !== undefined && dialect.blocks.length > 0,
      dialect === undefined ? 'no dialect' : `${dialect.blocks.length} block(s), ${dialect.menus.length} menu(s)`)

    const block = dialect?.blocks.find(writable)
    if (block === undefined) {
      check(`${id}: has a writable block`, false, 'every block has no inputs')
      continue
    }

    const applied = await call('gandi_apply', { xml: scriptFor(block, dialect.menus) })
    check(`${id}: blocks applied for ${block.opcode}`, /applied \d+ block\(s\)/.test(applied.text), applied.text.split('\n')[0])
    check(`${id}: the report names the extension`, new RegExp(`extension blocks written: ${id}`).test(applied.text))

    const run = await call('gandi_run', { seconds: 0.4, screenshot: false })
    // `ran N frames … stopped afterwards` is the report of a project that stepped and
    // finished. A runtime error in an extension block shows up as a thrown page error
    // instead, which the bridge turns into a failed tool call rather than this text.
    check(`${id}: runs without a runtime error`, /ran \d+ frames/.test(run.text), run.text.split('\n')[0])

    const project = await getProjectJson(connection)
    const allBlocks = project.targets.flatMap((target) => Object.values(target.blocks ?? {}))
    const stored = allBlocks.filter((candidate) => !Array.isArray(candidate) && candidate.opcode === block.opcode)
    check(`${id}: the editor stored the prefixed opcode`, stored.length > 0, block.opcode)
    const menus = allBlocks.filter((candidate) => !Array.isArray(candidate) && candidate.shadow === true &&
      dialect.menus.some((menu) => menu.shadow === candidate.opcode))
    if (Object.keys(block.menuInputs).length > 0) {
      check(`${id}: a menu argument became a shadow block`, menus.length > 0, menus.map((menu) => menu.opcode))
    }

    loaded.add(id)
  }

  // One saved file with many extensions in it: the offline reader has to survive a
  // document that declares several at once, and the editor has to reopen it.
  const savedPath = join(outDir, 'extension-mixed.sb3')
  const saved = await call('gandi_save', { path: savedPath })
  check('a project using several extensions saves', /saved \d+ bytes/.test(saved.text), saved.text)
  const verify = await call('gandi_verify', { path: savedPath })
  check('the offline load check accepts a multi-extension document', !/errors \(/.test(verify.text), verify.text.split('\n').slice(0, 4).join(' '))

  const reopened = await call('gandi_open', { path: savedPath })
  check('the editor reopens the multi-extension document',
    /loaded|opened/.test(reopened.text.toLowerCase()), reopened.text.split('\n')[0])
} finally {
  if (!keep) {
    await loadProjectBytes(connection, await readFile(backup))
    console.log('\nrestored the project that was open before this script ran')
  } else {
    console.log(`\n--keep: the editor now holds the probe project; snapshot at ${backup}`)
  }
  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
  call.dispose()
  connection.close()
  // A lingering CDP socket keeps the event loop alive; leave deliberately like the e2e does.
  setTimeout(() => process.exit(process.exitCode ?? 0), 400)
}
