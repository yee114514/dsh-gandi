/**
 * Locating, launching and attaching to Gandi Desktop.
 *
 * Gandi Desktop is an Electron shell around the online Gandi IDE. Two facts shape
 * everything here, both measured on v1.0.5 (see `docs/gandi-spike.md`):
 *
 *   - The app honours `--remote-debugging-port=<n>` exactly like any Electron app,
 *     so the bridge reaches it over CDP.
 *   - The editor is not the page the shell loads. The shell window is a `file://`
 *     page; each opened project is a separate `WebContentsView` pointing at
 *     `https://www.ccw.site/gandi?...`, and only that view has a VM. It therefore
 *     appears as its own CDP target, and "attaching" has two steps: find the shell,
 *     ask it for a tab, then attach to the editor target that appears.
 *
 * Unlike TurboWarp, Gandi has no single-instance lock — a second launch with the debug
 * port is enough to get an endpoint — so the launcher can bring up a plain Gandi and
 * then ask it for an editor tab itself.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { CdpConnection, CdpUnreachableError, evaluate, listTargets, readBrowserVersion } from './cdp.mjs'
import { vmResolverSource } from './gandi-vm.mjs'

/** Raised when the app cannot be found, started, or attached to. */
export class AppUnavailableError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'AppUnavailableError'
  }
}

/** Default debug port. Chosen to match common Electron debugging habits. */
export const DEFAULT_PORT = 9222

/** The origin every editor page lives on. */
const EDITOR_ORIGIN = 'https://www.ccw.site'

/** Where the editor's own project URL starts. */
const EDITOR_PATH_PREFIX = '/gandi'

/**
 * Candidate install locations for a packaged Gandi Desktop, in preference order.
 * @returns {string[]} absolute paths that may or may not exist
 */
export const candidateAppPaths = () => {
  const candidates = []
  const localAppData = process.env.LOCALAPPDATA
  const programFiles = process.env.PROGRAMFILES
  const programFilesX86 = process.env['PROGRAMFILES(X86)']
  if (localAppData) candidates.push(join(localAppData, 'Programs', 'Gandi', 'Gandi.exe'))
  if (programFiles) candidates.push(join(programFiles, 'Gandi', 'Gandi.exe'))
  if (programFilesX86) candidates.push(join(programFilesX86, 'Gandi', 'Gandi.exe'))
  return candidates
}

/**
 * Where a launch that worked is remembered between sessions.
 *
 * "Where is Gandi installed" is a machine-level fact, and the plugin is installed into
 * more than one profile — remembering it here means passing `appPath` to
 * `gandi_launch` once is enough, instead of configuring an environment variable in
 * every profile.
 *
 * @returns {string} absolute path of the state file
 */
const stateFile = () => {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'gandi.json')
}

/**
 * Read the remembered executable path.
 * @returns {string|null} the path, when one was remembered and still exists
 */
export const recallAppPath = () => {
  try {
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'))
    const remembered = state?.appPath
    if (typeof remembered === 'string' && existsSync(remembered)) return remembered
  } catch {
    // Missing or unreadable: fall through to discovery.
  }
  return null
}

/**
 * Remember an executable path that launched successfully.
 *
 * Failure is ignored on purpose: not being able to write a convenience file must never
 * fail the launch the caller actually asked for.
 *
 * @param {string} appPath the path that worked
 */
export const rememberAppPath = (appPath) => {
  try {
    mkdirSync(dirname(stateFile()), { recursive: true })
    writeFileSync(stateFile(), `${JSON.stringify({ appPath, rememberedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  } catch {
    // Convenience only.
  }
}

/**
 * Find a packaged Gandi executable.
 *
 * An explicit path is a decision and is honoured as given: if it does not exist this
 * returns null rather than quietly substituting a remembered path, because silently
 * ignoring configuration makes "I set appPath and it still used something else"
 * impossible to diagnose.
 *
 * @param {string} [configured] an explicit path from configuration
 * @returns {string|null} a usable path, or null
 */
export const resolveAppPath = (configured) => {
  if (typeof configured === 'string' && configured.length > 0) {
    return existsSync(configured) ? configured : null
  }
  const remembered = recallAppPath()
  if (remembered !== null) return remembered
  for (const candidate of candidateAppPaths()) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Whether a URL is one of the editor's own pages.
 *
 * Gandi's own trusted-editor check accepts `/gandi`, `/gandi/<type>` and
 * `/gandi/<type>/<id>`; this accepts anything on the editor origin whose first path
 * segment is `gandi`, which is that same family and survives new shapes being added.
 *
 * A freshly created tab reports an EMPTY `url` in `/json/list` until its navigation
 * commits, so URL matching alone can miss a tab that was just opened — see
 * `waitForEditorTarget`, which also matches on the requested tab's target id.
 *
 * @param {unknown} url the candidate URL
 * @returns {boolean} true for the editor's own pages
 */
export const isEditorUrl = (url) => {
  if (typeof url !== 'string' || !url.startsWith(EDITOR_ORIGIN)) return false
  const [first] = url.slice(EDITOR_ORIGIN.length).split(/[?#]/)[0].split('/').filter(Boolean)
  return first === EDITOR_PATH_PREFIX.slice(1)
}

/**
 * Both debug endpoints that matter: `/json/list` answers as soon as the DevTools
 * server is up, which is before any page has finished loading.
 * @param {number} port debug port
 * @param {{timeoutMs?: number}} [options] per-request timeout
 * @returns {Promise<import('./cdp.mjs').CdpTarget[]>} targets
 */
export const probeTargets = async (port, options = {}) => {
  try {
    return await listTargets(port, { timeoutMs: options.timeoutMs ?? 2000 })
  } catch (error) {
    if (error instanceof CdpUnreachableError) return []
    throw error
  }
}

/** @returns {Promise<import('./cdp.mjs').CdpTarget|null>} the shell window's target */
export const findShellTarget = async (port, options = {}) => {
  const targets = await probeTargets(port, options)
  return targets.find((target) => target.type === 'page' &&
    typeof target.url === 'string' && target.url.startsWith('file://')) ?? null
}

/** @returns {Promise<import('./cdp.mjs').CdpTarget|null>} an open editor tab, if any */
export const findEditorTarget = async (port, options = {}) => {
  const targets = await probeTargets(port, options)
  return targets.find((target) => target.type === 'page' && isEditorUrl(target.url)) ?? null
}

/**
 * The view id a page URL carries, when it has one.
 *
 * This is the id the shell was asked for, and the id the bridge keys its own bookkeeping
 * on. It is NOT the CDP target id — measured, they differ (`docs/gandi-spike.md` §13 was
 * written from a case where they happened to look alike, and believing it made
 * `waitForEditorTarget` fall back to "any editor tab", which is exactly the wrong tab
 * when the bridge has just opened a second one).
 *
 * A freshly created target has an EMPTY url until its navigation commits, so a missing
 * tab id means "not navigated yet", never "not ours".
 *
 * @param {unknown} url the page URL
 * @returns {string|null} the tab id, when the URL names one
 */
export const editorTabIdOf = (url) => {
  if (typeof url !== 'string' || url.length === 0) return null
  const match = /[?&]tabId=([^&#]+)/.exec(url)
  return match === null ? null : decodeURIComponent(match[1])
}

/**
 * Wait for an editor tab to appear.
 *
 * `tabId` pins the wait to one specific tab: it is the id we asked the shell for, and the
 * editor puts it in its URL. Pinning is what keeps a second editor tab from being
 * mistaken for the one just opened. Without a `tabId` any editor tab will do, which is
 * what "attach to whatever is open" needs.
 *
 * @param {number} port debug port
 * @param {{timeoutMs?: number, tabId?: string}} [options] how long to wait, and which tab
 * @returns {Promise<import('./cdp.mjs').CdpTarget>} the editor target
 * @throws {AppUnavailableError} when it never appears
 */
export const waitForEditorTarget = async (port, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 45000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const targets = await probeTargets(port)
    const editor = options.tabId === undefined
      ? targets.find((target) => target.type === 'page' && isEditorUrl(target.url))
      : targets.find((target) => target.type === 'page' && editorTabIdOf(target.url) === options.tabId)
    if (editor !== undefined) return editor
    if (Date.now() >= deadline) {
      const seen = targets.map((target) => `${target.type}:${target.url}`)
      throw new AppUnavailableError(
        `the debug port ${port} answered but no Gandi editor tab ` +
        `${options.tabId === undefined ? 'appeared' : `with tab id ${options.tabId} appeared`} within ${timeoutMs}ms` +
        (seen.length > 0 ? ` (saw ${seen.join(', ')})` : ' (no targets at all)')
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Ask the shell window to open a fresh editor tab.
 *
 * This is the same call the shell's own "create" button makes: the renderer invokes
 * `ViewPreload.addView`, the main process builds a `WebContentsView` pointed at
 * `https://www.ccw.site/gandi?tabId=...`, and that view is a new CDP target.
 *
 * The tab id only has to be unique within the session; the editor uses it to keep
 * per-tab state apart.
 *
 * @param {import('./cdp.mjs').CdpTarget} shell the shell window target
 * @param {{lang?: string, timeoutMs?: number}} [options] tab options
 * @returns {Promise<string>} the tab id that was requested
 */
export const openEditorTab = async (shell, options = {}) => {
  if (typeof shell?.webSocketDebuggerUrl !== 'string') {
    throw new AppUnavailableError('the Gandi shell window has no debugger URL; restart Gandi through gandi_launch')
  }
  const connection = await CdpConnection.connect(shell.webSocketDebuggerUrl)
  try {
    const lang = options.lang ?? process.env.DSH_GANDI_LANG ?? 'zh-cn'
    // The id must be one no view is using. Measured the hard way: asking the shell for a
    // tab id it already has leaves an `error.html` view behind and eventually takes the
    // whole app down, so a collision is not a theoretical concern. Both namespaces are
    // checked, because a view id lives in the page URL while the target has its own id.
    const taken = new Set()
    for (const target of await probeTargets(options.port ?? DEFAULT_PORT, { timeoutMs: 1500 })) {
      taken.add(target.id)
      const existing = editorTabIdOf(target.url)
      if (existing !== null) taken.add(existing)
    }
    const tabId = uniqueTabId(taken)
    const url = `${EDITOR_ORIGIN}${EDITOR_PATH_PREFIX}?tabId=${tabId}&lang=${lang}`
    const result = await evaluate(connection, `(async () => {
      try {
        await globalThis.ViewPreload.addView(${JSON.stringify({ url, tabId, offline: false, lang })})
        return { ok: true }
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) }
      }
    })()`, { awaitPromise: true, timeoutMs: options.timeoutMs ?? 15000 })
    if (result?.ok !== true) {
      throw new AppUnavailableError(`Gandi refused to open an editor tab: ${result?.message ?? 'unknown reason'}`)
    }
    return tabId
  } finally {
    connection.close()
  }
}

/**
 * A tab id no view is using.
 *
 * `make` is injectable so the collision rule can be tested without a live editor — the
 * rule matters because re-adding an existing tab id is one of the few ways to break
 * Gandi itself (it leaves an `error.html` view behind, and the app goes down later).
 *
 * @param {Set<string>} [existing] ids that are taken
 * @param {() => string} [make] id generator
 * @returns {string} a free id
 */
export const uniqueTabId = (existing = new Set(), make = () => `dsh${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`) => {
  const first = make()
  if (!existing.has(first)) return first
  for (let suffix = 1; suffix <= 100; suffix++) {
    const candidate = `${first}-${suffix}`
    if (!existing.has(candidate)) return candidate
  }
  return `${first}-${Date.now().toString(36)}`
}

/**
 * Wait until the editor in a tab is ready to be driven.
 *
 * Gandi boots its own default project after the page loads. Measured: the VM object
 * exists from roughly 2s, but the editor replaces its project at around 9-12s, so
 * anything written in between is silently thrown away — which looks exactly like "my
 * project never loaded". Waiting for the target list to be non-empty AND unchanged
 * across two samples is what makes a subsequent write stick; three runs of
 * `tools/probe-ready` style checks loaded a project correctly with this gate.
 *
 * @param {CdpConnection} connection an open connection to the editor target
 * @param {{timeoutMs?: number, settleSamples?: number, pollMs?: number}} [options] gate options
 * @returns {Promise<string>} the settled signature, describing the loaded project
 * @throws {AppUnavailableError} when the editor never settles
 */
export const waitForEditorReady = async (connection, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 90000
  const settleSamples = options.settleSamples ?? 2
  const pollMs = options.pollMs ?? 600
  const deadline = Date.now() + timeoutMs
  let lastSignature = null
  let stable = 0
  for (;;) {
    const signature = await evaluate(connection, `(() => {
      const vm = ${vmResolverSource()};
      if (vm === null) return null;
      const runtime = vm.runtime;
      if (!Array.isArray(runtime.targets) || runtime.targets.length === 0) return null;
      return runtime.targets.map((target) => {
        const costumes = typeof target.getCostumes === 'function' ? target.getCostumes().length : 0;
        return target.getName() + ':' + costumes;
      }).join(',');
    })()`, { timeoutMs: 20000 }).catch(() => null)

    if (typeof signature === 'string' && signature.length > 0) {
      if (signature === lastSignature) {
        stable++
        if (stable >= settleSamples) return signature
      } else {
        stable = 0
      }
      lastSignature = signature
    } else {
      stable = 0
      lastSignature = null
    }

    if (Date.now() >= deadline) {
      throw new AppUnavailableError(
        `the Gandi editor did not finish loading within ${timeoutMs}ms` +
        (lastSignature === null ? ' (no project ever appeared)' : ` (last saw "${lastSignature}")`)
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Attach to an editor tab, opening one if Gandi has none.
 *
 * @param {{port?: number, openTab?: boolean, timeoutMs?: number, readyTimeoutMs?: number}} [options] attach options
 * @returns {Promise<{connection: CdpConnection, target: any, port: number, tabId: string|null, opened: boolean}>} the attachment
 * @throws {AppUnavailableError} when the port is closed or no editor can be reached
 */
export const attach = async (options = {}) => {
  const port = options.port ?? DEFAULT_PORT
  const targets = await probeTargets(port, { timeoutMs: options.probeTimeoutMs ?? 2000 })
  if (targets.length === 0) {
    throw new AppUnavailableError(`nothing is listening on the DevTools port ${port}`)
  }

  let opened = false
  let tabId = null
  let target = targets.find((entry) => entry.type === 'page' && isEditorUrl(entry.url)) ?? null

  if (target === null && options.openTab !== false) {
    const shell = targets.find((entry) => entry.type === 'page' &&
      typeof entry.url === 'string' && entry.url.startsWith('file://')) ?? null
    if (shell === null) {
      throw new AppUnavailableError(
        `the debug port ${port} has no Gandi window to talk to (saw ${targets.map((entry) => entry.url).join(', ')})`
      )
    }
    tabId = await openEditorTab(shell, { timeoutMs: options.timeoutMs ?? 15000, port })
    opened = true
    // Wait for the tab we just asked for, by the id in its URL. Its `/json/list` entry has
    // no URL until the navigation commits, so URL matching alone would time out here —
    // and an unpinned wait would happily return a DIFFERENT editor tab.
    target = await waitForEditorTarget(port, { timeoutMs: options.timeoutMs ?? 45000, tabId })
  } else if (target === null) {
    target = await waitForEditorTarget(port, { timeoutMs: options.timeoutMs ?? 10000 })
  } else {
    // Reusing a tab that is already open: report which view it is, so the caller can ask
    // later whether the user can actually see it.
    tabId = editorTabIdOf(target.url)
  }

  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl)
  try {
    await waitForEditorReady(connection, { timeoutMs: options.readyTimeoutMs ?? 90000 })
  } catch (error) {
    connection.close()
    throw error
  }
  return { connection, target, port, tabId, opened }
}

/**
 * Whether a Gandi process exists, regardless of whether it has a debug port.
 *
 * Used only to produce an actionable message: "it is running, but not with a debug
 * port — close it and call gandi_launch" rather than "not found".
 *
 * @returns {Promise<boolean>} true when a Gandi process is present
 */
export const isGandiRunning = async () => {
  if (process.platform !== 'win32') return false
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq Gandi.exe', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(/\bGandi\.exe\b/i.test(output)))
  })
}

/**
 * Start Gandi with a debug port, open an editor tab and attach to it.
 *
 * The child is detached: closing the harness must not kill the user's editor, and the
 * plugin never terminates an app it did not need to keep alive.
 *
 * @param {{appPath: string, port?: number, extraArgs?: string[], timeoutMs?: number, readyTimeoutMs?: number, cwd?: string}} options launch options
 * @returns {Promise<{connection: CdpConnection, target: any, port: number, pid: number|undefined, tabId: string|null, opened: boolean}>} the attachment
 * @throws {AppUnavailableError} when the executable is missing or the app never comes up
 */
export const launchAndAttach = async (options) => {
  const appPath = options.appPath
  if (typeof appPath !== 'string' || appPath.length === 0) {
    throw new AppUnavailableError('no Gandi executable is configured and none was found in the usual locations')
  }
  if (!existsSync(appPath)) throw new AppUnavailableError(`no such executable: ${appPath}`)

  const port = options.port ?? DEFAULT_PORT
  const args = [`--remote-debugging-port=${port}`, ...(options.extraArgs ?? [])]

  const child = spawn(appPath, args, {
    detached: true,
    stdio: 'ignore',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd })
  })
  child.unref()

  // Wait for the DevTools server, then for a window to exist. A cold Gandi start
  // takes a few seconds before the shell page is up.
  const deadline = Date.now() + (options.timeoutMs ?? 60000)
  for (;;) {
    const targets = await probeTargets(port)
    if (targets.length > 0) break
    if (Date.now() >= deadline) {
      throw new AppUnavailableError(
        `Gandi started (pid ${child.pid}) but its DevTools port ${port} never answered within ${options.timeoutMs ?? 60000}ms`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const attachment = await attach({
    port,
    openTab: true,
    timeoutMs: options.timeoutMs ?? 60000,
    readyTimeoutMs: options.readyTimeoutMs ?? 90000
  })
  // A path that actually produced an editor is worth keeping: the next session then
  // needs no appPath argument at all.
  rememberAppPath(appPath)
  return { ...attachment, pid: child.pid }
}

// ── the Gandi that is already running ────────────────────────────────────────
//
// "Open Gandi, then ask the model to edit an .sb3" is the normal way round, and the old
// answer to it was "close Gandi and call gandi_launch" — which is why a delivery killed
// the window the user was looking at and started a second one. Two measured facts shape
// what can be done instead:
//
//   - A Gandi started WITHOUT `--remote-debugging-port` can never be attached to. The
//     DevTools server is created at browser-process start-up; nothing enables it later.
//     So the only cure is for the user's own Gandi to be started with the switch — which
//     is what `src/bridge/launcher.mjs` is for.
//   - A Gandi started WITH the switch may be on a port this process did not choose
//     (another tool, another profile, an older config). Attaching must therefore
//     discover the port rather than assume one, or "Gandi is open, but not on my port"
//     reads as "not attachable" and provokes exactly the relaunch this avoids.
//
// Everything below is read-only discovery plus a graceful close that only `gandi_launch`
// calls, and only when the caller explicitly asked for a restart.

/** Raised when a Gandi is running that the bridge cannot attach to. */
export class GandiRunningError extends AppUnavailableError {
  constructor (message, options) {
    super(message, options)
    this.name = 'GandiRunningError'
  }
}

/**
 * Run a PowerShell one-liner and return its stdout, or null when it is unavailable.
 *
 * Only used where Node genuinely cannot see the answer: another process's command line
 * and the shell-link COM object have no `node:*` equivalent, and this package may not
 * take a dependency. A machine without PowerShell degrades to the old behaviour
 * (assume the configured port), never to an error.
 *
 * @param {string} script PowerShell source (no backticks: template-literal safety)
 * @param {{timeoutMs?: number}} [options] how long to wait
 * @returns {Promise<string|null>} trimmed stdout, or null
 */
const runPowerShell = async (script, options = {}) => {
  if (process.platform !== 'win32') return null
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
    } catch {
      resolve(null)
      return
    }
    let output = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve(null)
    }, options.timeoutMs ?? 8000)
    child.stdout.on('data', (chunk) => { output += chunk })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(output.trim().length > 0 ? output.trim() : null)
    })
  })
}

/**
 * Every Gandi process, with its command line.
 *
 * `main` marks the browser process: the renderer/GPU/utility children all carry
 * `--type=…`, and only the browser process owns the DevTools server, so only its
 * command line says whether this Gandi is attachable.
 *
 * @returns {Promise<{pid: number, commandLine: string, main: boolean}[]|null>} the processes, or null when unknown
 */
export const listGandiProcesses = async () => {
  const raw = await runPowerShell('Get-CimInstance Win32_Process -Filter "Name=\'Gandi.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress')
  if (raw === null) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  const processes = []
  for (const entry of entries) {
    const pid = Number(entry?.ProcessId)
    if (!Number.isInteger(pid)) continue
    const commandLine = typeof entry?.CommandLine === 'string' ? entry.CommandLine : ''
    processes.push({ pid, commandLine, main: commandLine.length > 0 && !/--type=/.test(commandLine) })
  }
  return processes
}

/**
 * The debug port a command line asks for.
 * @param {string} commandLine a process command line
 * @returns {number|null} the port, when one is named
 */
export const debugPortOf = (commandLine) => {
  if (typeof commandLine !== 'string') return null
  const match = /--remote-debugging-port=(\d{1,5})/.exec(commandLine)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

/**
 * Where Gandi Desktop keeps its Chromium profile.
 * @returns {string} absolute path of the profile directory
 */
export const gandiProfileDir = () => {
  const appData = process.env.APPDATA
  return appData === undefined ? join(homedir(), 'AppData', 'Roaming', 'gandi-desktop') : join(appData, 'gandi-desktop')
}

/**
 * The port Chromium recorded for its own DevTools server.
 *
 * Written by Chromium whenever the server is enabled, including for
 * `--remote-debugging-port=0` where the port is chosen by the OS — the one case a
 * command line cannot reveal. The file is NOT cleaned up on exit, so a stale copy is
 * normal; callers must confirm the port really is Gandi's before trusting it.
 *
 * @returns {number|null} the recorded port, when the file names one
 */
export const readDevToolsActivePort = () => {
  try {
    const [first] = readFileSync(join(gandiProfileDir(), 'DevToolsActivePort'), 'utf8').split('\n')
    const port = Number(String(first).trim())
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}

/**
 * Whether a port is a Gandi debug endpoint (rather than some other Chromium app).
 * @param {number} port candidate port
 * @param {{timeoutMs?: number}} [options] probe timeout
 * @returns {Promise<boolean>} true when Gandi answers there
 */
export const isGandiEndpoint = async (port, options = {}) => {
  const version = await readBrowserVersion(port, { timeoutMs: options.timeoutMs ?? 1500 })
  if (version === null) return false
  const agent = typeof version['User-Agent'] === 'string' ? version['User-Agent'] : ''
  return /gandi-desktop/i.test(agent)
}

/**
 * Find a running Gandi that can be attached to, and say where its port came from.
 *
 * Candidate order matters: the port this process would have launched with first (so a
 * single-instance setup keeps using one port), then the ports actually on the command
 * lines of the Gandi processes that are running, then the recorded active port.
 *
 * @param {{preferredPort?: number, timeoutMs?: number, processes?: {pid: number, commandLine: string, main: boolean}[]|null}} [options] discovery options
 * @returns {Promise<{port: number, source: string, pid: number|null}|null>} the endpoint, or null
 */
export const discoverAttachableGandi = async (options = {}) => {
  const candidates = []
  const add = (port, source, pid = null) => {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return
    if (candidates.some((entry) => entry.port === port)) return
    candidates.push({ port, source, pid })
  }

  add(options.preferredPort, 'configured port')
  // `processes` lets a caller that already asked (status does) avoid a second PowerShell
  // round trip: this runs before every reconnect, and a spawn per call adds up.
  const processes = options.processes === undefined ? await listGandiProcesses() : options.processes
  if (processes !== null && processes !== undefined) {
    for (const entry of processes.filter((process) => process.main)) {
      add(debugPortOf(entry.commandLine), 'the command line of the running Gandi', entry.pid)
    }
  }
  add(readDevToolsActivePort(), 'DevToolsActivePort')

  for (const candidate of candidates) {
    if (await isGandiEndpoint(candidate.port, { timeoutMs: options.timeoutMs ?? 1500 })) return candidate
  }
  return null
}

/**
 * Close a running Gandi, the polite way.
 *
 * `CloseMainWindow` posts the same WM_CLOSE the window's X button sends, so the app gets
 * to ask about unsaved work. Nothing here ever forces: a Gandi that is asking the user a
 * question must be allowed to keep asking, and the caller is told it is still running
 * instead. (The plugin used to tell the MODEL to close Gandi — which meant `taskkill`,
 * and a project could go with it.)
 *
 * @param {{pids: number[], timeoutMs?: number}} options which processes, and how long to wait
 * @returns {Promise<{closed: boolean, remaining: number, note: string}>} the outcome
 */
export const closeGandiGracefully = async (options) => {
  const pids = (options.pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0)
  if (pids.length === 0) return { closed: true, remaining: 0, note: 'no Gandi process was named' }
  const timeoutMs = options.timeoutMs ?? 20000
  const script = pids
    .map((pid) => `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [void]$p.CloseMainWindow() }`)
    .join('; ')
  await runPowerShell(script, { timeoutMs: 8000 })

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const processes = await listGandiProcesses()
    const alive = processes === null ? [] : processes.map((entry) => entry.pid)
    const remaining = pids.filter((pid) => alive.includes(pid))
    if (remaining.length === 0) return { closed: true, remaining: 0, note: 'Gandi closed' }
    if (Date.now() >= deadline) {
      return {
        closed: false,
        remaining: remaining.length,
        note: `Gandi is still running after ${Math.round(timeoutMs / 1000)}s — it may be asking about unsaved work. Nothing was forced.`
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Close one editor view the way the app closes it.
 *
 * `ViewPreload.removeView({ tabId })` — an OBJECT, not a bare id: called with a string it
 * resolves to `undefined` and does nothing, which is how "removeView is a main→renderer
 * notification" got written down here once. It is the app's own close, the same one its
 * tab's ✕ runs, and it leaves the rest of the app healthy.
 *
 * The CDP route (`Target.closeTarget`) is NOT an alternative: measured twice, closing a
 * view that way takes the whole of Gandi Desktop down a few seconds later (the app keeps a
 * reference to a view whose webContents is gone). Never do it.
 *
 * @param {import('./cdp.mjs').CdpTarget} shell the shell window target
 * @param {string} tabId the view id (the one in the editor URL)
 * @param {{timeoutMs?: number}} [options] how long to wait
 * @returns {Promise<boolean>} true when the shell accepted the request
 */
export const removeEditorView = async (shell, tabId, options = {}) => {
  if (typeof tabId !== 'string' || tabId.length === 0) return false
  if (typeof shell?.webSocketDebuggerUrl !== 'string') return false
  let connection
  try {
    connection = await CdpConnection.connect(shell.webSocketDebuggerUrl, { timeoutMs: options.timeoutMs ?? 5000 })
    const result = await evaluate(connection, `(async () => {
      try {
        await globalThis.ViewPreload.removeView({ tabId: ${JSON.stringify(tabId)} })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) }
      }
    })()`, { awaitPromise: true, timeoutMs: options.timeoutMs ?? 8000 })
    return result?.ok === true
  } catch {
    return false
  } finally {
    try {
      connection?.close()
    } catch {
      // already gone
    }
  }
}

/**
 * Ask the shell to make one of its views the active one.
 *
 * `ViewPreload.switchView` is the app's own call for this, but it is not documented
 * anywhere and its argument shape had to be found by experiment — the object form is the
 * one that gets anywhere, exactly as for `removeView`. Whether it actually switches is
 * verified by the caller (the editor is asked whether it is now on screen) rather than
 * assumed, and `false` simply means "fall back to re-creating the view".
 *
 * @param {import('./cdp.mjs').CdpTarget} shell the shell window target
 * @param {string} tabId the view to activate
 * @param {{timeoutMs?: number}} [options] how long to wait
 * @returns {Promise<boolean>} true when the call was accepted
 */
export const requestViewSwitch = async (shell, tabId, options = {}) => {
  if (typeof tabId !== 'string' || tabId.length === 0) return false
  if (typeof shell?.webSocketDebuggerUrl !== 'string') return false
  let connection
  try {
    connection = await CdpConnection.connect(shell.webSocketDebuggerUrl, { timeoutMs: options.timeoutMs ?? 5000 })
    const result = await evaluate(connection, `(async () => {
      try {
        await globalThis.ViewPreload.beforeSwitchView({ tabId: ${JSON.stringify(tabId)} })
        await globalThis.ViewPreload.switchView({ tabId: ${JSON.stringify(tabId)} })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: String((error && error.message) || error) }
      }
    })()`, { awaitPromise: true, timeoutMs: options.timeoutMs ?? 8000 })
    return result?.ok === true
  } catch {
    return false
  } finally {
    try {
      connection?.close()
    } catch {
      // already gone
    }
  }
}

/**
 * Start Gandi with a debug port and attach, REFUSING to disturb a Gandi that is running.
 *
 * The refusal names every way out that exists, including a port a running Gandi really
 * answers on when discovery found one: "attach to it instead" is a decision about
 * configuration, and it belongs to the caller, not to a silent fallback.
 *
 * @param {{appPath: string, port?: number, timeoutMs?: number, readyTimeoutMs?: number, restart?: boolean, restartTimeoutMs?: number, elsewhere?: {port: number, source: string}|null}} options launch options
 * @returns {Promise<any>} the attachment, plus how the running instance was treated
 * @throws {GandiRunningError} when a Gandi is running that cannot be attached to and no restart was asked for
 */
export const launchRespectingRunning = async (options) => {
  const port = options.port ?? DEFAULT_PORT
  const running = (await listGandiProcesses()) ?? []

  if (running.length > 0 && options.restart !== true) {
    const mains = running.filter((entry) => entry.main)
    const elsewhere = options.elsewhere ?? null
    throw new GandiRunningError(
      `Gandi is already running (${mains.length > 0 ? `pid ${mains.map((entry) => entry.pid).join(', ')}` : `${running.length} process(es)`}) ` +
      `but nothing is listening on the configured debug port ${port}, so it cannot be attached to` +
      (elsewhere === null
        ? ' — a running Gandi can only be attached to if it was started with --remote-debugging-port, and nothing turns that on afterwards'
        : `, although a Gandi on port ${elsewhere.port} (found via ${elsewhere.source}) IS attachable`) +
      '. It was NOT closed. Three ways forward: ' +
      (elsewhere === null
        ? 'open Gandi from the attachable launcher '
        : `set port (or GANDI_PORT) to ${elsewhere.port} to use that window, open Gandi from the attachable launcher `) +
      `(gandi_launch {launcher: true} creates one, once), or pass restart: true to close that window and start an attachable Gandi ` +
      '(unsaved work in it is at the app\'s mercy, so ask the user first).'
    )
  }

  let closedNote = ''
  if (options.restart === true && running.length > 0) {
    const outcome = await closeGandiGracefully({
      pids: running.map((entry) => entry.pid),
      timeoutMs: options.restartTimeoutMs ?? 20000
    })
    closedNote = `; ${outcome.note}`
    if (!outcome.closed) {
      throw new GandiRunningError(
        `asked Gandi to close, but ${outcome.remaining} process(es) are still running. ${outcome.note} ` +
        'Nothing was forced — finish or discard the work in that window, then call gandi_launch again.'
      )
    }
  }

  const appPath = options.appPath
  if (typeof appPath !== 'string' || appPath.length === 0) {
    throw new AppUnavailableError('no Gandi executable is configured and none was found in the usual locations')
  }
  if (!existsSync(appPath)) throw new AppUnavailableError(`no such executable: ${appPath}`)

  const args = [`--remote-debugging-port=${port}`, ...(options.extraArgs ?? [])]
  const child = spawn(appPath, args, {
    detached: true,
    stdio: 'ignore',
    ...(options.cwd === undefined ? {} : { cwd: options.cwd })
  })
  child.unref()

  const deadline = Date.now() + (options.timeoutMs ?? 60000)
  for (;;) {
    const targets = await probeTargets(port)
    if (targets.length > 0) break
    if (Date.now() >= deadline) {
      throw new AppUnavailableError(
        `Gandi started (pid ${child.pid}) but its DevTools port ${port} never answered within ${options.timeoutMs ?? 60000}ms`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const attachment = await attach({
    port,
    openTab: true,
    timeoutMs: options.timeoutMs ?? 60000,
    readyTimeoutMs: options.readyTimeoutMs ?? 90000
  })
  rememberAppPath(appPath)
  return { ...attachment, pid: child.pid, closedNote }
}
