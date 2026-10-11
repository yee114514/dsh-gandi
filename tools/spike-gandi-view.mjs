/**
 * Probe: what does Gandi's shell preload actually expose — and can it be instrumented?
 *
 * This is the probe that explains why every view behaviour in this repo had to be found by
 * OBSERVATION (`tools/spike-gandi-surface.mjs`) instead of by reading the app: the whole
 * `ViewPreload` object is exposed through Electron's contextBridge, which freezes it. Its
 * members are non-writable, non-configurable and compiled native code, so there is no
 * wrapper to install, no source to read and no way to log what the app itself passes.
 *
 * Measured on Gandi Desktop 1.0.5:
 *
 *   Object.isFrozen(window.ViewPreload)          -> true
 *   descriptor of window.ViewPreload             -> writable: false, configurable: false
 *   Object.defineProperty(window, 'ViewPreload') -> "Cannot redefine property"
 *   String(ViewPreload.addView)                  -> "function () { [native code] }"
 *
 * The only thing left is to CALL these functions and see what happens — which is how
 * `{ tabId }` (an object, not a bare string) turned out to be the argument shape that
 * `switchView` and `removeView` need, and how `Page.bringToFront` turned out to steal the
 * window focus without switching the view inside it.
 *
 * Read-only: opens no views, closes nothing.
 *
 * Usage: node tools/spike-gandi-view.mjs [--port 9222]
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const portArg = process.argv.indexOf('--port')
const PORT = Number(portArg === -1 ? process.env.GANDI_PORT ?? '9222' : process.argv[portArg + 1])

const targets = await listTargets(PORT).catch(() => [])
if (targets.length === 0) {
  console.error(`nothing is listening on the debug port ${PORT}. Start Gandi first:`)
  console.error(`  Start-Process 'E:\\Gandi\\Gandi.exe' -ArgumentList '--remote-debugging-port=${PORT}'`)
  process.exit(1)
}

console.log(`targets on ${PORT}:`)
for (const target of targets) {
  const kind = target.url.startsWith('file://')
    ? target.url.split('/').pop()
    : (target.url.includes('/gandi') ? `editor ${new URL(target.url).searchParams.get('tabId')}` : target.url.slice(0, 60))
  console.log(`  ${target.type.padEnd(6)} ${kind}`)
}

/** One shell-like page is enough: home.html and index.html expose the same object. */
const page = targets.find((target) => typeof target.url === 'string' && target.url.startsWith('file://'))
if (page === undefined || page.webSocketDebuggerUrl === undefined) {
  console.error('no shell page found among the targets; is that really Gandi?')
  process.exit(1)
}

const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)
const report = await evaluate(connection, `(() => {
  const preloads = ['ViewPreload', 'EventsPreload', 'CommonPreload', 'SettingsPreload', 'GandiEditorPreload', 'ccwDesktop'];
  const shape = {};
  for (const name of preloads) {
    const value = window[name];
    if (value === undefined) { shape[name] = 'absent'; continue }
    shape[name] = {
      frozen: Object.isFrozen(value),
      ownKeys: Object.getOwnPropertyNames(value),
      nativeCode: typeof value[Object.getOwnPropertyNames(value)[0]] === 'function'
        ? String(value[Object.getOwnPropertyNames(value)[0]]).includes('[native code]')
        : null
    };
  }
  const descriptor = Object.getOwnPropertyDescriptor(window, 'ViewPreload');
  let redefinable = false;
  let why = null;
  try {
    Object.defineProperty(window, 'ViewPreload', { value: window.ViewPreload, configurable: true });
    redefinable = true;
  } catch (error) {
    why = String(error.message);
  }
  return JSON.stringify({
    url: location.href.split('/').pop(),
    viewPreloadDescriptor: descriptor === undefined ? null : { writable: descriptor.writable, configurable: descriptor.configurable },
    instrumentable: redefinable,
    why,
    shape
  }, null, 1);
})()`)

console.log(`\n=== ${page.url.split('/').pop()} ===`)
console.log(report)
console.log('\n(not instrumentable = every view behaviour has to be learned by calling it and watching the result)')

connection.close()
