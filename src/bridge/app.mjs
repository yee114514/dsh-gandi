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

import { CdpConnection, CdpUnreachableError, evaluate, listTargets } from './cdp.mjs'
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
 * Wait for an editor tab to appear.
 *
 * `tabId` pins the wait to one specific tab: its target id is the tab id we asked the
 * shell for, and that is known before the new page has a URL. Without it any editor
 * tab will do, which is what "attach to whatever is open" needs.
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
    const byId = options.tabId === undefined
      ? undefined
      : targets.find((target) => target.type === 'page' && target.id === options.tabId)
    const editor = byId ?? targets.find((target) => target.type === 'page' && isEditorUrl(target.url))
    if (editor !== undefined) return editor
    if (Date.now() >= deadline) {
      const seen = targets.map((target) => `${target.type}:${target.url}`)
      throw new AppUnavailableError(
        `the debug port ${port} answered but no Gandi editor tab appeared within ${timeoutMs}ms` +
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
    const tabId = `dsh${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
    const lang = options.lang ?? process.env.DSH_GANDI_LANG ?? 'zh-cn'
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
    tabId = await openEditorTab(shell, { timeoutMs: options.timeoutMs ?? 15000 })
    opened = true
    // Wait for the tab we just asked for, by id. Its `/json/list` entry has no URL
    // until the navigation commits, so URL matching alone would time out here.
    target = await waitForEditorTarget(port, { timeoutMs: options.timeoutMs ?? 45000, tabId })
  } else if (target === null) {
    target = await waitForEditorTarget(port, { timeoutMs: options.timeoutMs ?? 10000 })
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
