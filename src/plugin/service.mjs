/**
 * The process-wide bridge singleton.
 *
 * One DSH host process serves every session on a surface, and on the web surface
 * several sessions run at once. Gandi, by contrast, is a single application with a
 * single editor tab in front of the user. So this service owns exactly one connection
 * and one open project, and serialises access to them:
 *
 *   - a **mutex** keeps compound operations from interleaving (a half-applied script
 *     would otherwise be visible to another session's screenshot);
 *   - a **lease** keeps two sessions from fighting over the project. Mutating
 *     operations take it; read-only ones still work but report the holder. It expires
 *     after `leaseIdleMs` of inactivity so an abandoned session cannot lock the editor
 *     forever.
 *
 * Nothing here decides policy about the app's lifetime: the plugin only ever detaches.
 * Killing an editor the user is looking at would be worse than leaving a stale
 * connection behind.
 */

import {
  attach,
  DEFAULT_PORT,
  discoverAttachableGandi,
  isGandiEndpoint,
  isGandiRunning,
  launchAndAttach,
  launchRespectingRunning,
  listGandiProcesses,
  probeTargets,
  rememberAppPath,
  resolveAppPath
} from '../bridge/app.mjs'
import { CdpError, CdpUnreachableError, isContextDestroyed } from '../bridge/cdp.mjs'
import { waitForVm } from '../bridge/ops.mjs'
import { classifySurface, readSurface, SurfaceState, showEditor } from '../bridge/surface.mjs'
import { launcherExists, launcherPath } from '../bridge/launcher.mjs'

/** Raised when a session tries to mutate a project another session holds. */
export class LeaseConflictError extends Error {
  constructor (message) {
    super(message)
    this.name = 'LeaseConflictError'
  }
}

/** Raised when the editor cannot be reached and the caller must act. */
export class BridgeUnavailableError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'BridgeUnavailableError'
  }
}

export class BridgeService {
  #config
  /** @type {import('../bridge/cdp.mjs').CdpConnection|null} */
  #connection = null
  #port
  #lastError = null
  /** @type {{sessionId: string, at: number}|null} */
  #lease = null
  /** @type {string|null} */
  #lastRun = null
  /** Tail of the serialisation chain. */
  #queue = Promise.resolve()
  /** The editor VIEW the bridge is driving, so "is it on screen" can be asked about it. */
  #tabId = null
  /** A shell-page connection, kept only to read whether the Gandi window is on screen. */
  #shellConnection = null
  /** Last surface reading, for `gandi_status`. */
  #lastSurface = null
  /** When the editor was last RE-CREATED, so a user who keeps looking away cannot make every call slow. */
  #lastRecreateAt = 0
  /** One line for the NEXT tool result, when the bridge had to move the user's view. */
  #surfaceNote = null

  /**
   * @param {{appPath?: string, port?: number, autoLaunch?: boolean, leaseIdleMs?: number, launchTimeoutMs?: number, debug?: boolean}} config resolved plugin config
   */
  constructor (config) {
    this.#config = config
    this.#port = config.port ?? DEFAULT_PORT
  }

  /** The configured debug port. */
  get port () {
    return this.#port
  }

  /** The editor view the bridge is driving, when it knows one. */
  get tabId () {
    return this.#tabId
  }

  /** The last surface reading (whether the user can see the editor). */
  get lastSurface () {
    return this.#lastSurface
  }

  /**
   * Take the pending "the bridge moved your editor back to the front" note, if any.
   *
   * A one-shot note rather than a log line: the person who needs to know is the one
   * reading the tool result, and the moment a view gets re-created is exactly the moment
   * an editor's undo history disappears. Clearing it here keeps it from being repeated
   * in every later result.
   *
   * @returns {string|null} the note
   */
  takeSurfaceNote () {
    const note = this.#surfaceNote
    this.#surfaceNote = null
    return note
  }

  /** Diagnostic logging goes to stderr; stdout must stay quiet inside the TUI. */
  #log (message) {
    if (this.#config.debug === true) process.stderr.write(`[gandi-scratch] ${message}\n`)
  }

  /**
   * Serialise one operation against every other operation on this process.
   * @template T
   * @param {() => Promise<T>} operation the work to run
   * @returns {Promise<T>} the operation's result
   */
  #serialize (operation) {
    const run = this.#queue.then(operation, operation)
    // Keep the chain alive regardless of individual failures.
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Drop a dead connection so the next call re-attaches.
   *
   * A navigation race is deliberately NOT fatal: the socket is healthy and the page
   * comes back on its own, so tearing the connection down would turn a retryable blip
   * into an outage.
   *
   * @param {unknown} error the failure that ended the connection
   */
  #invalidate (error) {
    if (isContextDestroyed(error)) {
      this.#log(`ignoring a navigation race: ${error.message}`)
      return
    }
    if (error instanceof CdpError || error instanceof CdpUnreachableError) {
      this.#log(`dropping connection: ${error.message}`)
      try {
        this.#connection?.close()
      } catch {
        // already gone
      }
      this.#connection = null
      this.#lastError = error
    }
  }

  /**
   * The one message a caller needs when there is no editor to drive.
   *
   * Gandi's shape makes this worth spelling out: the debug port can be wide open while
   * the app shows nothing but its project browser, because the editor only exists once
   * a tab is open. "Nothing is listening on 9222" would send the reader hunting for a
   * port problem that does not exist.
   *
   * The running-but-unattachable case gets its own wording, and it never says "close
   * it": that sentence is what made a delivery kill the user's window and start a second
   * Gandi. What is true instead is that the debug server only exists when Gandi is
   * started with the switch, so the fix is either a launcher that has it or an explicit
   * restart.
   *
   * @param {string|null} appPath a known executable, when there is one
   * @param {unknown} cause the underlying failure
   * @param {{port: number, source: string}|null} [elsewhere] another attachable Gandi, when discovery found one
   * @returns {BridgeUnavailableError} the error to throw
   */
  async #unavailable (appPath, cause, elsewhere = null) {
    const running = await listGandiProcesses().catch(() => null)
    const processCount = running === null ? (await isGandiRunning().catch(() => false) ? 1 : 0) : running.length
    const discovered = elsewhere ?? await discoverAttachableGandi({ preferredPort: this.#port, processes: running }).catch(() => null)
    const reachable = discovered !== null && discovered.port === this.#port
    const advice = []
    if (!reachable) {
      advice.push(`nothing is listening on the DevTools port ${this.#port}`)
      const byHand = `start Gandi yourself with --remote-debugging-port=${this.#port}`
      if (discovered !== null) {
        // A Gandi IS attachable, just not where this session is configured to look. Saying
        // so is worth more than a generic failure — and the port stays the caller's
        // decision rather than being quietly overridden.
        advice.push(
          `a Gandi IS running and attachable on port ${discovered.port} (found via ${discovered.source}), but this session is configured for ` +
          `${this.#port}; either set port (or GANDI_PORT) to ${discovered.port} to use that window, or call gandi_launch {restart: true} ` +
          `to start one on ${this.#port} (that closes the running window politely), or ${byHand}`
        )
      } else if (processCount > 0) {
        advice.push(
          'Gandi IS running, but it was started without --remote-debugging-port, and a running Gandi cannot be made attachable afterwards' +
          ' (the debug server only exists if the switch is there at start-up). It was not closed. ' +
          `Either open Gandi from the attachable launcher ${launcherExists() ? `(${launcherPath()})` : '(gandi_launch {launcher: true} creates one)'}, ` +
          `or ${byHand}, or ask the user and then call gandi_launch {restart: true}, which closes that window politely and starts an attachable one`
        )
      } else if (appPath !== null && this.#config.autoLaunch !== true) {
        advice.push(`Gandi is not running; call gandi_launch (its executable is known: ${appPath}), or ${byHand}`)
      } else {
        advice.push(`call gandi_launch with appPath (it is remembered afterwards), or set appPath (or the GANDI_APP_PATH environment variable), or ${byHand}`)
      }
    } else {
      advice.push(`Gandi is on the debug port ${this.#port} but no editor tab is open; call gandi_launch (or gandi_open) and the plugin will open one`)
    }
    return new BridgeUnavailableError(advice.join('. '), { cause })
  }

  /**
   * Read whether the user can see the editor, and put it back in front when they can.
   *
   * Runs before mutating work and after (re)attaching. The policy is the user's, chosen
   * explicitly: never take their focus, but make sure that inside the Gandi window the
   * editor is the view on screen. `readSurface` can tell the two apart — the shell page
   * reads `visible` whenever the WINDOW is on screen, so "shell visible + editor hidden"
   * means another view (the home page, or one of the user's projects) is in front of
   * ours, which is fixable by creating a fresh view on top.
   *
   * @param {{force?: boolean, reason: string}} options why the check is happening
   * @returns {Promise<void>} nothing; the effect is the connection and the note
   */
  async #ensureVisible (options) {
    if (this.#connection === null) return
    let reading
    try {
      reading = await readSurface(this.#connection, {
        port: this.#port,
        tabId: this.#tabId,
        shellConnection: this.#shellConnection,
        keepShellConnection: true
      })
    } catch (error) {
      this.#log(`could not read the surface: ${error?.message ?? error}`)
      return
    }
    if (reading.shellConnection !== null) this.#shellConnection = reading.shellConnection
    this.#lastSurface = reading
    if (reading.editorTabId !== null && this.#tabId === null) this.#tabId = reading.editorTabId

    if (reading.action !== 'reshow') {
      if (reading.state === SurfaceState.ON_SCREEN) this.#log(`the editor view is on screen (${options.reason})`)
      return
    }

    // The cooldown is about the EXPENSIVE, destructive path only. Switching a view costs
    // two IPC calls and leaves everything intact, so the user looking away and back is
    // answered every single time; re-creating an editor is the one that must not repeat in
    // a loop. (Measured: with one cooldown for both, a view switched during launch made the
    // very next check refuse to fix a genuine "user clicked home".)
    const cooldownMs = this.#config.recreateCooldownMs ?? 30000
    const idle = Date.now() - this.#lastRecreateAt
    const allowRecreate = options.force === true || idle >= cooldownMs

    this.#log(`re-showing the editor: ${reading.why}${allowRecreate ? '' : ` (re-creating is on cooldown for another ${Math.round((cooldownMs - idle) / 1000)}s)`}`)
    try {
      const shown = await showEditor({
        port: this.#port,
        connection: this.#connection,
        tabId: this.#tabId,
        timeoutMs: this.#config.launchTimeoutMs ?? 45000,
        allowRecreate
      })
      if (shown.connection !== this.#connection) {
        try {
          this.#connection?.close()
        } catch {
          // already gone
        }
      }
      this.#connection = shown.connection
      this.#connection.on('Runtime.exceptionThrown', () => {})
      // Only ever replaced by a REAL view id: the "skipped" path reports an empty one, and
      // storing that would make every later surface read report "no editor" and stop
      // tracking the view the bridge is actually driving.
      if (typeof shown.tabId === 'string' && shown.tabId.length > 0) this.#tabId = shown.tabId
      // The two paths are not the same event for the person reading this: a switch costs
      // them nothing, a re-created view costs their undo history.
      if (shown.how === 'switched') {
        this.#surfaceNote = 'NOTE: the editor was made the active view in the Gandi window again (it had been left behind on the home page or another project). Nothing was reloaded.'
      } else if (shown.how === 'recreated') {
        this.#lastRecreateAt = Date.now()
        this.#surfaceNote = 'NOTE: the editor was put back in front inside Gandi by opening a fresh view (it had been left behind, and switching to it did not work). ' +
          'The open project was carried over in full, but editor-local state (undo history, selection) was not.'
      } else {
        this.#surfaceNote = 'NOTE: the Gandi window is NOT showing the editor the bridge drives, and it was not re-created just now (a fresh view was made recently). ' +
          'Click the editor in Gandi — or ask, and the bridge will re-open it — before judging anything by what is on screen.'
      }
      // Re-read, so the next status call reports what the user can actually see now.
      this.#lastSurface = await readSurface(this.#connection, {
        port: this.#port,
        tabId: this.#tabId,
        shellConnection: this.#shellConnection,
        keepShellConnection: true
      }).then((reading) => {
        if (reading.shellConnection !== null) this.#shellConnection = reading.shellConnection
        return reading
      }).catch(() => this.#lastSurface)
    } catch (error) {
      this.#log(`could not re-show the editor: ${error?.message ?? error}`)
      this.#surfaceNote = `NOTE: the Gandi window is not showing the editor the bridge drives, and re-opening it failed (${error?.message ?? error}). ` +
        'The work below still applies to the open project.'
    }
  }

  /**
   * Ensure a live connection to an editor whose VM is ready.
   *
   * @param {{openTab?: boolean, show?: boolean}} [options] whether a missing editor tab may be opened, and whether to re-show it
   * @returns {Promise<import('../bridge/cdp.mjs').CdpConnection>} the connection
   */
  async #ensureConnection (options = {}) {
    if (this.#connection !== null && this.#connection.closed === false) return this.#connection

    const appPath = resolveAppPath(this.#config.appPath)
    const timeoutMs = this.#config.launchTimeoutMs ?? 45000
    // The configured port is authoritative: it is what the launcher uses and what the user
    // chose. Discovery is used to EXPLAIN a failure (a Gandi attachable elsewhere), never
    // to silently drive a different port — that is the same rule as for appPath, and the
    // reason "I set the port and it still used another" must be impossible.
    try {
      const attached = await attach({ port: this.#port, openTab: options.openTab !== false, timeoutMs, readyTimeoutMs: timeoutMs })
      attached.connection.on('Runtime.exceptionThrown', () => {})
      this.#connection = attached.connection
      if (typeof attached.tabId === 'string' && attached.tabId.length > 0) this.#tabId = attached.tabId
      this.#log(`attached to port ${this.#port}${attached.opened ? ' (opened a new editor tab)' : ''}`)
    } catch (error) {
      // Auto-launch is for "there is no Gandi". A running Gandi is never replaced
      // silently: `launchRespectingRunning` refuses, and its message says why.
      if (this.#config.autoLaunch !== true || appPath === null) throw await this.#unavailable(appPath, error)
      const processes = await listGandiProcesses().catch(() => null)
      if (processes !== null && processes.length > 0) throw await this.#unavailable(appPath, error, null)
      this.#log(`nothing usable on port ${this.#port}; launching ${appPath}`)
      const launched = await launchAndAttach({
        appPath,
        port: this.#port,
        timeoutMs,
        readyTimeoutMs: timeoutMs
      })
      this.#connection = launched.connection
      if (typeof launched.tabId === 'string' && launched.tabId.length > 0) this.#tabId = launched.tabId
    }

    // The editor boots its own default project and replaces it once more a few seconds
    // later; writing before it settles is silently discarded. `attach` already waited
    // for that, and this is the second gate for the launch path where the tab was
    // opened by the app itself.
    const ready = await waitForVm(this.#connection, { timeoutMs })
    if (!ready) {
      this.#connection.close()
      this.#connection = null
      throw new BridgeUnavailableError('the Gandi editor is up but never finished loading a project')
    }
    if (options.show !== false) await this.#ensureVisible({ reason: 'attach', force: true })
    return this.#connection
  }

  /**
   * Get an editor the user can watch, adopting or starting Gandi as the situation allows.
   *
   * The whole "use the Gandi I already have open" policy lives here, so `gandi_launch`
   * and auto-launch cannot drift apart:
   *
   *   1. a Gandi already answering on the CONFIGURED port is adopted — no second window,
   *      no restart, and the tab it already has is reused;
   *   2. a Gandi that cannot be attached to is NEVER closed or duplicated: the caller gets
   *      an error naming the launcher, the explicit `restart` route, and (when discovery
   *      found one) the port a running Gandi actually answers on;
   *   3. otherwise, start one.
   *
   * @param {{appPath?: string|null, timeoutMs?: number, restart?: boolean, restartTimeoutMs?: number, show?: boolean}} options how to get there
   * @returns {Promise<{attached: any, adopted: boolean, port: number, launched: boolean, closedNote: string, source: string}>} what happened
   */
  async launch (options = {}) {
    const timeoutMs = options.timeoutMs ?? this.#config.launchTimeoutMs ?? 45000
    const appPath = resolveAppPath(options.appPath ?? this.#config.appPath)
    const processes = await listGandiProcesses().catch(() => null)
    const onConfiguredPort = await isGandiEndpoint(this.#port, { timeoutMs: 1500 }).catch(() => false)

    if (onConfiguredPort) {
      this.dispose()
      const attached = await attach({ port: this.#port, timeoutMs, openTab: true, readyTimeoutMs: timeoutMs })
      this.#connection = attached.connection
      this.#connection.on('Runtime.exceptionThrown', () => {})
      if (typeof attached.tabId === 'string' && attached.tabId.length > 0) this.#tabId = attached.tabId
      const ready = await waitForVm(this.#connection, { timeoutMs })
      if (options.show !== false) await this.#ensureVisible({ reason: 'launch', force: true })
      if (appPath !== null) this.#remember(appPath)
      return {
        attached: { ...attached, ready },
        adopted: true,
        launched: false,
        port: this.#port,
        source: 'configured port',
        closedNote: ''
      }
    }

    if (appPath === null) {
      throw new BridgeUnavailableError(
        'no Gandi executable is known, so none can be started. Pass appPath once (it is remembered for later sessions), ' +
        'or set appPath / GANDI_APP_PATH.'
      )
    }
    const launched = await launchRespectingRunning({
      appPath,
      port: this.#port,
      timeoutMs,
      restart: options.restart === true,
      restartTimeoutMs: options.restartTimeoutMs,
      elsewhere: await discoverAttachableGandi({ preferredPort: this.#port, processes }).catch(() => null)
    })
    this.dispose()
    this.#connection = launched.connection
    this.#connection.on('Runtime.exceptionThrown', () => {})
    if (typeof launched.tabId === 'string' && launched.tabId.length > 0) this.#tabId = launched.tabId
    const ready = await waitForVm(this.#connection, { timeoutMs })
    if (options.show !== false) await this.#ensureVisible({ reason: 'launch', force: true })
    this.#remember(appPath)
    return { attached: { ...launched, ready }, adopted: false, launched: true, port: this.#port, source: 'new process', closedNote: launched.closedNote ?? '' }
  }

  /** Remember an executable path that produced an editor. */
  #remember (appPath) {
    try {
      rememberAppPath(appPath)
    } catch {
      // Convenience only: not being able to write it must never fail a launch.
    }
  }

  /**
   * Run one operation against a live editor, serialised and with connection recovery.
   * Mutating operations must hold the lease.
   *
   * @template T
   * @param {{sessionId: string, mutating: boolean, force?: boolean}} access who is asking and why
   * @param {(connection: import('../bridge/cdp.mjs').CdpConnection) => Promise<T>} operation the work
   * @returns {Promise<T>} the operation's result
   */
  async use (access, operation) {
    return this.#serialize(async () => {
      if (access.mutating) this.#checkLease(access.sessionId, access.force === true)
      const connection = await this.#ensureConnection()
      if (access.mutating) {
        this.#lease = { sessionId: access.sessionId, at: Date.now() }
        // Only mutating work changes what is on screen, so this is where the user's
        // ability to see it is worth a round trip.
        await this.#ensureVisible({ reason: 'before an edit' })
      }
      try {
        return await operation(connection)
      } catch (error) {
        this.#invalidate(error)
        throw error
      }
    })
  }

  /**
   * Enforce the lease for a mutating operation.
   *
   * The idle window is short on purpose. A lease is only ever refreshed by its holder
   * actually working, so a holder that has gone away — a subagent that crashed, a
   * session the user closed — freezes the editor for exactly this long. Five minutes of
   * that cost a delivery three rounds of pure waiting, and the thing it was waiting for
   * was a corpse. A minute is long enough for a session that is mid-thought and short
   * enough to walk away from, and `gandi_lease` covers the case where even that is too
   * long to wait.
   *
   * @param {string} sessionId the requesting session
   * @param {boolean} force whether the caller asked to take over
   */
  #checkLease (sessionId, force) {
    const idleMs = this.#config.leaseIdleMs ?? 60000
    if (this.#lease !== null && this.#lease.sessionId !== sessionId) {
      const idle = Date.now() - this.#lease.at
      if (idle < idleMs && !force) {
        throw new LeaseConflictError(
          `session ${this.#lease.sessionId} is driving Gandi (idle ${Math.round(idle / 1000)}s of ` +
          `${Math.round(idleMs / 1000)}s). Wait for it, pass force: true to take over, ` +
          'or call gandi_lease {action: "take"} if you mean to keep it.'
        )
      }
      if (force) this.#log(`session ${sessionId} took the lease from ${this.#lease.sessionId} by force`)
    }
  }

  /** Release the lease if the given session holds it. */
  releaseLease (sessionId) {
    if (this.#lease !== null && this.#lease.sessionId === sessionId) this.#lease = null
  }

  /**
   * Remember how the last run went, so `gandi_status` can report it.
   *
   * A run's most important symptom is often the one that happened one call ago — a
   * page error during the run, or a run that started no threads at all. Without this
   * the only way back to it is to run the project again and hope it repeats.
   *
   * @param {string} summary one line
   */
  noteRun (summary) {
    this.#lastRun = summary
  }

  /** One line about the last run, or null. */
  get lastRun () {
    return this.#lastRun
  }

  /**
   * Read or change the lease by hand.
   *
   * Nothing here can notice that a holder has died: an agent session does not tell the
   * plugin when it ends. The idle timeout was therefore the only reclamation, and
   * waiting it out was the only escape. This is the third way out, and the only one that
   * leaves the lease in a state the caller chose: `status` says who holds it, `release`
   * gives it up as its holder, and `take` claims it outright.
   *
   * @param {{action: 'status'|'release'|'take', sessionId: string}} request what to do
   * @returns {{action: string, lease: {sessionId: string, idleMs: number}|null, idleMs: number, note: string}} the resulting state
   */
  lease (request) {
    const idleMs = this.#config.leaseIdleMs ?? 60000
    const before = this.#lease === null ? null : { sessionId: this.#lease.sessionId, idleMs: Date.now() - this.#lease.at }
    let note = ''
    if (request.action === 'take') {
      note = before === null
        ? 'the lease was free; you hold it now'
        : `took the lease from ${before.sessionId} (it had been idle ${Math.round(before.idleMs / 1000)}s)`
      this.#lease = { sessionId: request.sessionId, at: Date.now() }
    } else if (request.action === 'release') {
      if (before === null) note = 'the lease was already free'
      else if (before.sessionId !== request.sessionId) {
        note = `session ${before.sessionId} holds the lease, not you — call gandi_lease {action: "take"} to take it`
      } else {
        this.#lease = null
        note = 'released; the next mutating call from any session can take it'
      }
    } else {
      note = before === null
        ? 'the lease is free'
        : `held by ${before.sessionId}, idle ${Math.round(before.idleMs / 1000)}s of ${Math.round(idleMs / 1000)}s`
    }
    return {
      action: request.action,
      idleMs,
      lease: this.#lease === null ? null : { sessionId: this.#lease.sessionId, idleMs: Date.now() - this.#lease.at },
      note
    }
  }

  /**
   * Report the bridge's state.
   *
   * This deliberately does NOT open an editor tab: status must be safe to call, and
   * "is an editor attached" is exactly the question it exists to answer. When the port
   * is open but no tab exists, that is reported as `editorOpen: false` with the reason,
   * and the next real tool call opens one.
   *
   * @returns {Promise<any>} status for tool output
   */
  async status () {
    const appPath = resolveAppPath(this.#config.appPath)

    let targets = []
    try {
      targets = await probeTargets(this.#port, { timeoutMs: 1500 })
    } catch {
      targets = []
    }
    const portOpen = targets.length > 0

    // The expensive part (a PowerShell round trip for the command lines) only runs when
    // the configured port is closed, which is the only case where the answer changes
    // anything. A port that answers is proof enough that Gandi is running.
    const processes = portOpen ? null : await listGandiProcesses().catch(() => null)
    const running = portOpen || (processes === null ? await isGandiRunning().catch(() => false) : processes.length > 0)
    // Which port a running Gandi actually answers on, which is not necessarily the
    // configured one — that difference used to read as "not attachable".
    const attachable = portOpen
      ? { port: this.#port, source: 'configured port' }
      : await discoverAttachableGandi({ preferredPort: this.#port, processes }).catch(() => null)

    const editorTarget = targets.find((target) => target.type === 'page' &&
      typeof target.url === 'string' && target.url.startsWith('https://www.ccw.site/gandi')) ?? null

    let connected = this.#connection !== null && this.#connection.closed === false
    if (!portOpen && connected) {
      this.#connection?.close()
      this.#connection = null
      connected = false
    }
    let editorOpen = editorTarget !== null
    if (portOpen && editorTarget === null) {
      // A stale connection to a tab the user closed is worse than none.
      if (this.#connection !== null) {
        this.#connection.close()
        this.#connection = null
        connected = false
      }
    } else if (portOpen && !connected) {
      try {
        const attached = await attach({ port: this.#port, openTab: false, timeoutMs: 8000 })
        this.#connection = attached.connection
        if (typeof attached.tabId === 'string' && attached.tabId.length > 0) this.#tabId = attached.tabId
        connected = true
      } catch (error) {
        this.#lastError = error
        connected = false
      }
    }
    if (editorTarget === null) editorOpen = false

    // A fresh reading, so status answers "can the user see the editor right now" rather
    // than replaying the last one. Read-only and cheap; failures leave the old reading.
    if (connected) {
      this.#lastSurface = await readSurface(this.#connection, {
        port: this.#port,
        tabId: this.#tabId,
        shellConnection: this.#shellConnection
      }).catch(() => this.#lastSurface)
    }

    return {
      port: this.#port,
      portOpen,
      shellOpen: portOpen && targets.some((target) => typeof target.url === 'string' && target.url.startsWith('file://')),
      editorOpen,
      connected,
      appPath: appPath ?? null,
      appConfigured: this.#config.appPath ?? null,
      autoLaunch: this.#config.autoLaunch === true,
      processRunning: running,
      processCount: processes === null ? null : processes.length,
      attachable: attachable === null ? null : { port: attachable.port, source: attachable.source },
      editorTabId: this.#tabId,
      surface: this.#lastSurface,
      launcher: { path: launcherPath(), exists: launcherExists() },
      lease: this.#lease === null ? null : { sessionId: this.#lease.sessionId, idleMs: Date.now() - this.#lease.at },
      leaseIdleMs: this.#config.leaseIdleMs ?? 60000,
      lastRun: this.#lastRun,
      lastError: this.#lastError === null ? null : this.#lastError.message
    }
  }

  /** Close the connections. The app is left running. */
  dispose () {
    try {
      this.#connection?.close()
    } catch {
      // already closed
    }
    try {
      this.#shellConnection?.close()
    } catch {
      // already closed
    }
    this.#connection = null
    this.#shellConnection = null
    this.#tabId = null
    this.#lastSurface = null
    this.#lease = null
  }
}
