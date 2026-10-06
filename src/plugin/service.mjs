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
  isGandiRunning,
  launchAndAttach,
  probeTargets,
  resolveAppPath
} from '../bridge/app.mjs'
import { CdpError, CdpUnreachableError, isContextDestroyed } from '../bridge/cdp.mjs'
import { waitForVm } from '../bridge/ops.mjs'

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
  /** Tail of the serialisation chain. */
  #queue = Promise.resolve()

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
   * @param {string|null} appPath a known executable, when there is one
   * @param {unknown} cause the underlying failure
   * @returns {BridgeUnavailableError} the error to throw
   */
  async #unavailable (appPath, cause) {
    const running = await isGandiRunning().catch(() => false)
    const reachable = await probeTargets(this.#port, { timeoutMs: 1500 }).then((targets) => targets.length > 0).catch(() => false)
    const advice = []
    if (!reachable) {
      advice.push(`nothing is listening on the DevTools port ${this.#port}`)
      if (running) {
        advice.push('Gandi is running, but it was not started with a debug port, so it cannot be attached to — close it and call gandi_launch, or start Gandi yourself with --remote-debugging-port=' + this.#port)
      } else if (appPath !== null && this.#config.autoLaunch !== true) {
        advice.push(`Gandi is not running; call gandi_launch (its executable is known: ${appPath}), or start it yourself with --remote-debugging-port=${this.#port}`)
      } else {
        advice.push('call gandi_launch with appPath (it is remembered afterwards), or set appPath (or the GANDI_APP_PATH environment variable), or start Gandi yourself with --remote-debugging-port=' + this.#port)
      }
    } else {
      advice.push(`Gandi is on the debug port ${this.#port} but no editor tab is open; call gandi_launch (or gandi_open) and the plugin will open one`)
    }
    return new BridgeUnavailableError(advice.join('. '), { cause })
  }

  /**
   * Ensure a live connection to an editor whose VM is ready.
   *
   * @param {{openTab?: boolean}} [options] whether a missing editor tab may be opened
   * @returns {Promise<import('../bridge/cdp.mjs').CdpConnection>} the connection
   */
  async #ensureConnection (options = {}) {
    if (this.#connection !== null && this.#connection.closed === false) return this.#connection

    const appPath = resolveAppPath(this.#config.appPath)
    const timeoutMs = this.#config.launchTimeoutMs ?? 45000
    try {
      const attached = await attach({ port: this.#port, openTab: options.openTab !== false, timeoutMs, readyTimeoutMs: timeoutMs })
      attached.connection.on('Runtime.exceptionThrown', () => {})
      this.#connection = attached.connection
      this.#log(`attached to port ${this.#port}${attached.opened ? ' (opened a new editor tab)' : ''}`)
    } catch (error) {
      if (this.#config.autoLaunch !== true || appPath === null) throw await this.#unavailable(appPath, error)
      this.#log(`nothing usable on port ${this.#port}; launching ${appPath}`)
      const launched = await launchAndAttach({
        appPath,
        port: this.#port,
        timeoutMs,
        readyTimeoutMs: timeoutMs
      })
      this.#connection = launched.connection
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
    return this.#connection
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
      if (access.mutating) this.#lease = { sessionId: access.sessionId, at: Date.now() }
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
   * @param {string} sessionId the requesting session
   * @param {boolean} force whether the caller asked to take over
   */
  #checkLease (sessionId, force) {
    const idleMs = this.#config.leaseIdleMs ?? 300000
    if (this.#lease !== null && this.#lease.sessionId !== sessionId) {
      const idle = Date.now() - this.#lease.at
      if (idle < idleMs && !force) {
        throw new LeaseConflictError(
          `session ${this.#lease.sessionId} is driving Gandi (idle ${Math.round(idle / 1000)}s of ` +
          `${Math.round(idleMs / 1000)}s). Wait for it, or pass force: true to take over.`
        )
      }
      if (force) this.#log(`session ${sessionId} took the lease from ${this.#lease.sessionId}`)
    }
  }

  /** Release the lease if the given session holds it. */
  releaseLease (sessionId) {
    if (this.#lease !== null && this.#lease.sessionId === sessionId) this.#lease = null
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
    const running = await isGandiRunning().catch(() => false)

    let targets = []
    try {
      targets = await probeTargets(this.#port, { timeoutMs: 1500 })
    } catch {
      targets = []
    }
    const portOpen = targets.length > 0
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
        connected = true
      } catch (error) {
        this.#lastError = error
        connected = false
      }
    }
    if (editorTarget === null) editorOpen = false

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
      lease: this.#lease === null ? null : { sessionId: this.#lease.sessionId, idleMs: Date.now() - this.#lease.at },
      lastError: this.#lastError === null ? null : this.#lastError.message
    }
  }

  /** Close the connection. The app is left running. */
  dispose () {
    try {
      this.#connection?.close()
    } catch {
      // already closed
    }
    this.#connection = null
    this.#lease = null
  }
}
