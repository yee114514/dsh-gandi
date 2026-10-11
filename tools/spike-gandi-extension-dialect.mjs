/**
 * Exercise `src/bridge/extensions.mjs` against the live editor — the module the new
 * `gandi_extension` tool is built on. Not a spike about upstream behaviour (that is
 * `spike-gandi-extensions.mjs`); this checks the plugin's own reader.
 *
 * Usage: node tools/spike-gandi-extension-dialect.mjs [id …]
 */

import { listTargets, CdpConnection } from '../src/bridge/cdp.mjs'
import { extensionFacts, formatExtensionCatalogue, formatExtensionDialect, loadExtension } from '../src/bridge/extensions.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
const ids = wanted.length > 0 ? wanted : ['music']

const target = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
if (target === undefined) {
  console.log('editor not open')
  process.exit(1)
}
const conn = await CdpConnection.connect(target.webSocketDebuggerUrl)

let facts = await extensionFacts(conn)
console.log('=== before ===')
console.log(formatExtensionCatalogue(facts, { filter: '' }))
console.log(`catalogue entries: ${(facts.catalogue ?? []).length}`)

for (const id of ids) {
  console.log(`\n=== load ${id} ===`)
  try {
    const result = await loadExtension(conn, id)
    console.log(JSON.stringify({ id: result.id, alreadyLoaded: result.alreadyLoaded, ms: result.ms, loadedIds: result.loadedIds }))
    console.log(formatExtensionDialect(result.extension))
    console.log('menu shadows:')
    for (const menu of result.extension.menus) {
      console.log(`  ${menu.shadow}  field=${JSON.stringify(menu.field)} first=${JSON.stringify(menu.firstOption)} options=${menu.optionCount} guessed=${menu.guessed === true}`)
    }
  } catch (error) {
    console.log(`FAILED: ${String(error && error.message ? error.message : error)}`)
  }
}

facts = await extensionFacts(conn)
console.log('\n=== after ===')
console.log(`loaded: ${(facts.loadedIds ?? []).join(', ')}`)
conn.close()
