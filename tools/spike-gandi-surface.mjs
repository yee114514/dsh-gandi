/**
 * Probe: the Gandi window's VIEWS — which one is on screen, how to switch, how to close.
 *
 * Answers the questions behind "the model is editing but I can only see the home page"
 * (see `docs/gandi-spike.md` §19). Everything here is measured against a live editor, and
 * the interesting part is that three of these calls only work with an OBJECT argument:
 *
 *   ViewPreload.addView({url, tabId, offline, lang})   creates a view, in front
 *   ViewPreload.beforeSwitchView({tabId}) + switchView({tabId})   makes it the active one
 *   ViewPreload.removeView({tabId})                    closes it (the app's own close)
 *
 * Two things this probe deliberately does NOT do, because both kill Gandi Desktop:
 *   - Target.closeTarget on a view  (measured twice: the app dies seconds later)
 *   - addView with a tabId that already exists (leaves error.html behind, then dies)
 *
 * Usage:
 *   node tools/spike-gandi-surface.mjs               # press Enter at the prompts
 *   node tools/spike-gandi-surface.mjs --no-close    # leave the view it opened behind
 *
 * The one step that needs a human: the window has to be ON SCREEN for
 * `document.visibilityState` to mean anything. If it is behind another window, every view
 * reads `hidden` and the probe says so.
 */

import { findShellTarget, openEditorTab, probeTargets, DEFAULT_PORT } from '../src/bridge/app.mjs'
import { CdpConnection, evaluate, listTargets } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? DEFAULT_PORT)
const keepView = process.argv.includes('--no-close')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

if (!(await probeTargets(PORT, { timeoutMs: 2000 }).then((t) => t.length > 0).catch(() => false))) {
  console.error(`nothing is listening on the debug port ${PORT}. Start Gandi first:`)
  console.error(`  Start-Process 'E:\\Gandi\\Gandi.exe' -ArgumentList '--remote-debugging-port=${PORT}'`)
  process.exit(1)
}

/** Every page target, with the view id its URL carries. */
const describeTargets = async () => {
  const targets = await listTargets(PORT)
  const rows = []
  const connections = new Map()
  for (const target of targets) {
    if (target.type !== 'page' || typeof target.url !== 'string') continue
    const kind = target.url.startsWith('file://')
      ? target.url.split('/').pop()
      : (target.url.includes('/gandi') ? `editor ${new URL(target.url).searchParams.get('tabId')}` : 'other')
    let visibility = 'not a page we can ask'
    if (target.webSocketDebuggerUrl !== undefined) {
      const connection = await CdpConnection.connect(target.webSocketDebuggerUrl).catch(() => null)
      if (connection !== null) {
        connections.set(target.id, connection)
        visibility = await evaluate(connection, 'document.visibilityState').catch(() => 'gone')
      }
    }
    rows.push({ kind, targetId: target.id, urlTabId: target.url.includes('tabId=') ? new URL(target.url).searchParams.get('tabId') : null, visibility })
  }
  return { rows, connections }
}

const report = async (label) => {
  const { rows, connections } = await describeTargets()
  console.log(`\n--- ${label} ---`)
  for (const row of rows) {
    console.log(`  ${row.kind.padEnd(28)} visibility=${String(row.visibility).padEnd(8)} targetId=${row.targetId.slice(0, 8)} urlTabId=${row.urlTabId ?? '-'}`)
  }
  const shellVisible = rows.find((row) => row.kind === 'index.html')?.visibility === 'visible'
  console.log(`  (the window itself is ${shellVisible ? 'ON SCREEN' : 'behind another window'} — with it hidden, every view reads hidden)`)
  for (const connection of connections.values()) connection.close()
  return rows
}

const shellTarget = await findShellTarget(PORT)
if (shellTarget === null) {
  console.error('no shell page (index.html) among the targets; is that really Gandi?')
  process.exit(1)
}
const shell = await CdpConnection.connect(shellTarget.webSocketDebuggerUrl)

const strip = () => evaluate(shell, `([...document.querySelectorAll('.MuiTab-root')].map((tab) => (tab.getAttribute('aria-selected') === 'true' ? '[' + ((tab.innerText || '').trim() || 'icon') + ']' : ((tab.innerText || '').trim() || 'icon'))).join(' '))`)
  .catch((error) => `ERR ${error.message}`)

console.log(`port ${PORT} | shell ${shellTarget.id.slice(0, 8)} | tab strip: ${await strip()}`)
const before = await report('before: whatever the user is looking at')

console.log('\n1. addView — the call the bridge uses to get an editor')
const tabId = await openEditorTab(shellTarget, { port: PORT })
console.log(`   asked for tabId=${tabId}`)
await sleep(6000)
await report('after addView (the new view should be the visible one, and it will have NO tab)')
console.log(`   tab strip: ${await strip()}   <- a view created by addView never appears here`)

console.log('\n2. click the HOME tab in the shell — this is what the user does')
const box = await evaluate(shell, `(() => { const tab = document.querySelectorAll('.MuiTab-root')[0]; if (!tab) return null; const r = tab.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)
if (box !== null) {
  for (const type of ['mousePressed', 'mouseReleased']) await shell.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 })
}
await sleep(2500)
await report('after clicking home (the editor is hidden, and it has no tab to click back to)')

console.log('\n3. beforeSwitchView + switchView, with an OBJECT argument')
const switched = await evaluate(shell, `(async () => {
  try {
    await globalThis.ViewPreload.beforeSwitchView({ tabId: ${JSON.stringify(tabId)} })
    await globalThis.ViewPreload.switchView({ tabId: ${JSON.stringify(tabId)} })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) }
  }
})()`, { awaitPromise: true }).catch((error) => ({ ok: false, message: error.message }))
console.log(`   ${JSON.stringify(switched)}   (a bare string, or {id}, does nothing at all)`)
await sleep(2500)
await report('after the switch (the editor should be visible again, with nothing reloaded)')

console.log('\n4. removeView({tabId}) — the app\'s own close')
const removed = await evaluate(shell, `(async () => {
  try {
    await globalThis.ViewPreload.removeView({ tabId: ${JSON.stringify(tabId)} })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: String((error && error.message) || error) }
  }
})()`, { awaitPromise: true }).catch((error) => ({ ok: false, message: error.message }))
console.log(`   ${JSON.stringify(removed)}${keepView ? '   (--no-close: closing anyway, it is the only way to clean up)' : ''}`)
await sleep(3000)
await report('after removeView (the view is gone and the app is fine)')

console.log('\nNOT done here, on purpose: do NOT close a view with CDP Target.closeTarget, and do NOT')
console.log('addView a tabId that already exists — both take Gandi Desktop down (docs/gandi-spike.md §19).')
console.log(`\nport still answers: ${await probeTargets(PORT, { timeoutMs: 2000 }).then((t) => `${t.length} target(s)`).catch(() => 'NO')}`)

shell.close()
