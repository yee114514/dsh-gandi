/**
 * Whether the user can SEE the editor the bridge is driving, and how to put it back.
 *
 * Why this module exists: Gandi Desktop's window is not the editor. The window loads a
 * shell page (`index.html`, the tab strip) plus a home page view, and every project is
 * its own `WebContentsView` — a separate CDP target. The bridge opens its editor with
 * `ViewPreload.addView`, which puts the new view IN FRONT, so a session that opens its
 * own tab is visible to the user by construction. What is not visible is a tab the
 * bridge merely *attached* to: a view left over from an earlier session, or one the user
 * has switched away from. The model then works in a window nobody is looking at — which
 * is exactly the complaint this module answers.
 *
 * The facts it is built on, all measured (see `docs/gandi-spike.md`):
 *
 *   - `document.visibilityState` is per VIEW and faithful: with the Gandi window on
 *     screen, the front view and the shell page read `visible` and every other view
 *     reads `hidden`. When the whole window is behind another window, everything reads
 *     `hidden` — which is why the shell page is read too: it distinguishes "another view
 *     is in front of ours" from "the user is looking at something else entirely".
 *   - There is NO command that switches views. `ViewPreload.switchView` and friends
 *     resolve to `undefined` and do nothing when a renderer calls them, and
 *     `Page.bringToFront` raises the desktop WINDOW (stealing the user's focus) without
 *     switching the view inside it. `addView` is the only call that puts a view in
 *     front, so "show it again" means "create a fresh view in front" — carrying the
 *     project over so nothing is lost.
 *   - A view is closed with `Target.closeTarget`, which is safe (the app and its other
 *     views are unaffected). NEVER re-add an existing tab id: measured, that leaves an
 *     `error.html` view behind and eventually takes the whole app down.
 */

import { CdpConnection, isContextDestroyed } from './cdp.mjs'
import {
  editorTabIdOf,
  isEditorUrl,
  openEditorTab,
  probeTargets,
  removeEditorView,
  requestViewSwitch,
  waitForEditorReady,
  waitForEditorTarget
} from './app.mjs'
import { exportSb3, loadProjectBytes } from './ops.mjs'

/** What the desk in front of the user currently shows. */
export const SurfaceState = {
  /** The editor the bridge drives is the view on screen. */
  ON_SCREEN: 'on-screen',
  /** The Gandi window is on screen, but another of its views is in front of ours. */
  BEHIND_GANDI_VIEWS: 'behind-gandi-views',
  /** The Gandi window itself is behind another window: nothing to fix without stealing focus. */
  WINDOW_BEHIND: 'window-behind',
  /** No editor view exists at all. */
  NO_EDITOR: 'no-editor',
  /** The shell or the editor page could not be reached (Gandi may be closing). */
  UNKNOWN: 'unknown'
}

/**
 * Decide what to do about a surface reading, as a pure function.
 *
 * Kept separate from the probes so the policy can be tested without an editor, which
 * matters: the interesting branch (re-show) needs a real desktop to observe, and a
 * policy that can only be tested on real hardware is a policy that rots.
 *
 * @param {{shellFound: boolean, shellVisible: boolean|null, editorFound: boolean, editorVisible: boolean|null}} reading the probe result
 * @returns {{state: string, action: 'none'|'reshow', why: string}} the state and what to do
 */
export const classifySurface = (reading) => {
  if (reading.editorFound !== true) {
    return { state: SurfaceState.NO_EDITOR, action: 'none', why: 'no editor view is open' }
  }
  if (reading.editorVisible === true) {
    return { state: SurfaceState.ON_SCREEN, action: 'none', why: 'the editor view is the one on screen' }
  }
  if (reading.editorVisible === null || reading.shellFound !== true || reading.shellVisible === null) {
    return { state: SurfaceState.UNKNOWN, action: 'none', why: 'the surface could not be read' }
  }
  if (reading.shellVisible === false) {
    // The user is looking at another application. Raising Gandi would take their focus,
    // which they explicitly do not want; when they come back, the next check fixes it.
    return { state: SurfaceState.WINDOW_BEHIND, action: 'none', why: 'the Gandi window is behind another window' }
  }
  return {
    state: SurfaceState.BEHIND_GANDI_VIEWS,
    action: 'reshow',
    why: 'the Gandi window is on screen but showing something else (the home page, or another project)'
  }
}

/**
 * Read whether the user can see a given editor view.
 *
 * @param {CdpConnection} connection the bridge's connection to the editor
 * @param {{port: number, tabId?: string|null, shellConnection?: CdpConnection|null, keepShellConnection?: boolean}} options which editor, and where the shell is
 * @returns {Promise<{state: string, action: string, why: string, shellFound: boolean, shellVisible: boolean|null, editorFound: boolean, editorVisible: boolean|null, editorTabId: string|null, editorTargetId: string|null, shellConnection: CdpConnection|null}>} the reading
 */
export const readSurface = async (connection, options) => {
  const targets = await probeTargets(options.port, { timeoutMs: 2000 }).catch(() => [])
  const editors = targets.filter((target) => target.type === 'page' && isEditorUrl(target.url))
  // Matched by the id in the URL, never by target id: they are different namespaces, and
  // comparing them silently picks whichever editor tab happens to be first.
  const wanted = options.tabId === undefined || options.tabId === null
    ? null
    : editors.find((target) => editorTabIdOf(target.url) === options.tabId) ?? null
  const editor = wanted ?? (options.tabId === undefined || options.tabId === null ? editors[0] ?? null : null)
  const shell = targets.find((target) => target.type === 'page' &&
    typeof target.url === 'string' && target.url.startsWith('file://')) ?? null

  const editorVisible = await isViewVisible(connection, 4000)

  let shellVisible = null
  let shellConnection = options.shellConnection ?? null
  let openedShell = false
  if (shell !== null && typeof shell.webSocketDebuggerUrl === 'string') {
    try {
      if (shellConnection === null || shellConnection.closed === true) {
        shellConnection = await CdpConnection.connect(shell.webSocketDebuggerUrl, { timeoutMs: 4000 })
        openedShell = true
      }
      shellVisible = await shellConnection.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, { timeoutMs: 4000 })
        .then((result) => result?.result?.value === 'visible')
        .catch(() => null)
    } catch {
      shellVisible = null
    }
  }
  // A caller that asks for the connection back keeps it: this runs before every edit,
  // and a WebSocket handshake per edit is worth avoiding. Otherwise it is ours to close.
  const keep = options.keepShellConnection === true
  if (openedShell && !keep) {
    try {
      shellConnection?.close()
    } catch {
      // already gone
    }
    shellConnection = null
  }

  const reading = {
    shellFound: shell !== null,
    shellVisible,
    editorFound: editor !== null,
    editorVisible
  }
  return {
    ...classifySurface(reading),
    ...reading,
    editorTabId: editor === null ? null : editorTabIdOf(editor.url),
    editorTargetId: editor === null ? null : editor.id,
    shellConnection
  }
}

/**
 * Put the bridge's editor back in front of the user.
 *
 * Two mechanisms, cheapest first:
 *
 *   1. Ask the shell to switch to the view (`beforeSwitchView` + `switchView`, both with an
 *      object argument). This is the app's own way of making a view active, it works for a
 *      view that has no tab in the strip, and it disturbs nothing: same view, same project,
 *      same undo history. Verified by asking the editor whether it is on screen now —
 *      a switch that silently does nothing must not be reported as success.
 *   2. Otherwise create a NEW view, which lands on top of whatever the window was showing
 *      (the one call measured to put a view in front). The open project rides along as
 *      archive bytes, so sprites, scripts, costumes and sounds survive; what does not
 *      survive is editor-local state — undo history, which block is selected.
 *
 * The old view is closed with the app's OWN `removeView({tabId})` — never with CDP, which
 * kills Gandi. It is closed only after the new view holds the project, so a failure
 * anywhere leaves the caller with a working editor.
 *
 * @param {{port: number, connection: CdpConnection, tabId?: string|null, lang?: string, timeoutMs?: number, readyTimeoutMs?: number, allowRecreate?: boolean}} options the editor to re-show
 * @returns {Promise<{connection: CdpConnection, tabId: string, target: any, closedOld: boolean, bytes: number, how: 'switched'|'recreated'|'skipped'}>} the new attachment
 */
export const showEditor = async (options) => {
  const port = options.port
  const timeoutMs = options.timeoutMs ?? 45000
  const readyTimeoutMs = options.readyTimeoutMs ?? 60000
  const tabId = typeof options.tabId === 'string' && options.tabId.length > 0 ? options.tabId : null

  const targets = await probeTargets(port, { timeoutMs: 3000 })
  const shell = targets.find((target) => target.type === 'page' &&
    typeof target.url === 'string' && target.url.startsWith('file://'))
  if (shell === undefined) throw new Error('the Gandi window has no shell page, so no editor view can be re-shown')

  // 1. The cheap path: ask the shell to switch, and BELIEVE IT ONLY IF the editor says it
  //    is on screen. A switch that silently does nothing is worse than no switch at all,
  //    because the caller would report success while the user still sees the home page.
  if (tabId !== null) {
    await requestViewSwitch(shell, tabId, { timeoutMs: 8000 })
    const nowVisible = await isViewVisible(options.connection, 4000)
    if (nowVisible === true) {
      return { connection: options.connection, tabId, target: null, closedOld: false, bytes: 0, how: 'switched' }
    }
  }

  // 2. The reliable path: a new view, which lands in front by construction. It costs a
  //    fresh editor (and the caller's undo history), so a caller that just did this is
  //    allowed to say "not again yet".
  if (options.allowRecreate === false) {
    return { connection: options.connection, tabId: tabId ?? '', target: null, closedOld: false, bytes: 0, how: 'skipped' }
  }

  const bytes = await exportSb3(options.connection)
  const newTabId = await openEditorTab(shell, { lang: options.lang, timeoutMs, port })
  const target = await waitForEditorTarget(port, { timeoutMs, tabId: newTabId })
  const connection = await CdpConnection.connect(target.webSocketDebuggerUrl)
  try {
    await waitForEditorReady(connection, { timeoutMs: readyTimeoutMs })
    await loadProjectBytes(connection, bytes)
  } catch (error) {
    connection.close()
    // The old view is untouched, so the caller keeps a usable editor.
    if (isContextDestroyed(error)) throw error
    throw new Error(`the new editor view did not come up: ${error?.message ?? error}`)
  }

  let closedOld = false
  if (tabId !== null && tabId !== newTabId) closedOld = await removeEditorView(shell, tabId).catch(() => false)
  return { connection, tabId: newTabId, target, closedOld, bytes: bytes.length, how: 'recreated' }
}

/**
 * Whether a page says it is on screen.
 * @param {CdpConnection} connection the page to ask
 * @param {number} timeoutMs how long to wait for the answer
 * @returns {Promise<boolean|null>} true/false, or null when it could not be read
 */
export const isViewVisible = async (connection, timeoutMs = 4000) => {
  if (connection === null || connection === undefined || connection.closed === true) return null
  return connection.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, { timeoutMs })
    .then((result) => result?.result?.value === 'visible')
    .catch(() => null)
}
