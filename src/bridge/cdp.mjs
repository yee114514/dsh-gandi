/**
 * A dependency-free Chrome DevTools Protocol client.
 *
 * Node >= 22 ships a global `WebSocket`, so attaching to an Electron/Chromium
 * debug port needs no third-party package. This module is deliberately thin: it
 * speaks the wire protocol and nothing else. Scratch semantics live in
 * `src/bridge/ops.mjs`.
 *
 * Verified upstream facts this relies on:
 *   - Gandi Desktop honours `--remote-debugging-port=<n>` on launch
 *     (observed on v1.0.5: Electron 30.1.0 / Chrome 124). Its shell window AND each
 *     editor tab are separate page targets, which is why attaching has two steps —
 *     see `app.mjs`.
 *   - `Runtime.evaluate` runs in the page's main world, which is where the editor's
 *     React tree (and therefore its VM) can be reached. Gandi does NOT publish
 *     `window.vm`, so the VM is resolved per page — see `gandi-vm.mjs`.
 */

/** Raised when the debug endpoint cannot be reached. */
export class CdpUnreachableError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'CdpUnreachableError'
  }
}

/** Raised when a CDP command returns an error, or the page throws. */
export class CdpError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'CdpError'
  }
}

/**
 * Whether a failure is just the page navigating under us.
 *
 * Right after a launch the editor page can still be loading: the DevTools target
 * appears before the document settles, so an evaluate may land in an execution
 * context that is about to be torn down. That is a race to retry, not a broken
 * bridge — treating it as fatal made `scratch_launch` report failure for a launch
 * that had in fact succeeded.
 *
 * @param {unknown} error the failure to classify
 * @returns {boolean} true when retrying on the same live connection is right
 */
export const isContextDestroyed = (error) =>
  /execution context was destroyed|cannot find context|inspected target navigated or closed|execution context is not available/i
    .test(String(error?.message ?? error))

const DEFAULT_TIMEOUT_MS = 30000

/**
 * @typedef {object} CdpTarget
 * @property {string} id
 * @property {string} type
 * @property {string} title
 * @property {string} url
 * @property {string} [webSocketDebuggerUrl]
 */

/**
 * List the debug targets exposed by a Chromium debug port.
 * @param {number} port TCP port of the debug endpoint
 * @param {{timeoutMs?: number, host?: string}} [options] request options
 * @returns {Promise<CdpTarget[]>} the target list
 * @throws {CdpUnreachableError} when the endpoint does not answer
 */
export async function listTargets (port, options = {}) {
  const host = options.host ?? '127.0.0.1'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = `http://${host}:${port}/json/list`
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new CdpUnreachableError(`no DevTools endpoint on ${host}:${port}`, { cause: error })
  }
  if (!response.ok) {
    throw new CdpUnreachableError(`DevTools endpoint ${url} answered HTTP ${response.status}`)
  }
  const parsed = await response.json()
  if (!Array.isArray(parsed)) throw new CdpUnreachableError(`DevTools endpoint ${url} did not return a target list`)
  return parsed
}

/**
 * One connected CDP session.
 *
 * Commands are matched to replies by id; unmatched messages are dispatched to
 * event listeners registered with {@link CdpConnection#on}.
 */
export class CdpConnection {
  /** @type {WebSocket} */
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Map()
  #closed = false
  #closeReason = null

  /**
   * @param {WebSocket} socket an already-open socket
   */
  constructor (socket) {
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      this.#handleMessage(typeof event.data === 'string' ? event.data : String(event.data))
    })
    socket.addEventListener('close', () => this.#handleClose('the DevTools connection closed'))
    socket.addEventListener('error', () => this.#handleClose('the DevTools connection errored'))
  }

  /**
   * Connect to one target's debugger URL.
   * @param {string} webSocketDebuggerUrl the target's `webSocketDebuggerUrl`
   * @param {{timeoutMs?: number}} [options] connect options
   * @returns {Promise<CdpConnection>} the open connection
   */
  static async connect (webSocketDebuggerUrl, options = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (typeof webSocketDebuggerUrl !== 'string' || webSocketDebuggerUrl.length === 0) {
      throw new CdpUnreachableError('target has no webSocketDebuggerUrl')
    }
    const socket = new WebSocket(webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CdpUnreachableError(`connecting to ${webSocketDebuggerUrl} timed out`))
      }, timeoutMs)
      const settle = (fn, value) => {
        clearTimeout(timer)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        fn(value)
      }
      const onOpen = () => settle(resolve)
      const onError = () => settle(reject, new CdpUnreachableError(`cannot connect to ${webSocketDebuggerUrl}`))
      socket.addEventListener('open', onOpen)
      socket.addEventListener('error', onError)
    }).catch((error) => {
      try {
        socket.close()
      } catch {
        // already closing
      }
      throw error
    })
    return new CdpConnection(socket)
  }

  /** Whether the connection is still usable. */
  get closed () {
    return this.#closed
  }

  /**
   * Subscribe to a CDP event.
   * @param {string} method event name, e.g. `Runtime.consoleAPICalled`
   * @param {(params: any) => void} handler called for each event
   * @returns {() => void} unsubscribe
   */
  on (method, handler) {
    let handlers = this.#listeners.get(method)
    if (handlers === undefined) {
      handlers = new Set()
      this.#listeners.set(method, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  }

  /**
   * Send one CDP command.
   * @param {string} method command name, e.g. `Runtime.evaluate`
   * @param {Record<string, unknown>} [params] command parameters
   * @param {{timeoutMs?: number}} [options] per-call timeout
   * @returns {Promise<any>} the command result
   */
  send (method, params = {}, options = {}) {
    if (this.#closed) {
      return Promise.reject(new CdpError(`cannot send ${method}: ${this.#closeReason ?? 'connection closed'}`))
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      try {
        this.#socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(new CdpError(`cannot send ${method}`, { cause: error }))
      }
    })
  }

  /** Close the connection; pending commands reject. */
  close () {
    this.#handleClose('closed by the caller')
    try {
      this.#socket.close()
    } catch {
      // already closed
    }
  }

  /**
   * @param {string} raw one text frame
   */
  #handleMessage (raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.#pending.get(message.id)
      if (entry === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) {
        entry.reject(new CdpError(`${message.error.message ?? 'CDP error'}${message.error.data === undefined ? '' : `: ${message.error.data}`}`))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    if (typeof message.method === 'string') {
      const handlers = this.#listeners.get(message.method)
      if (handlers === undefined) return
      for (const handler of handlers) {
        try {
          handler(message.params)
        } catch {
          // A listener must never break the protocol loop.
        }
      }
    }
  }

  /**
   * @param {string} reason why the connection ended
   */
  #handleClose (reason) {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = reason
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) entry.reject(new CdpError(`CDP command aborted: ${reason}`))
  }
}

/**
 * Evaluate an expression in the page's main world and return its value.
 *
 * `returnByValue` is on by default so ordinary JSON data crosses the wire
 * directly. A page throw becomes a {@link CdpError} carrying the exception text
 * — the caller sees the same message the DevTools console would show.
 *
 * @param {CdpConnection} connection an open connection
 * @param {string} expression JavaScript expression (or async IIFE with `awaitPromise`)
 * @param {{awaitPromise?: boolean, returnByValue?: boolean, timeoutMs?: number, userGesture?: boolean}} [options] evaluation options
 * @returns {Promise<any>} the evaluated value
 */
export async function evaluate (connection, expression, options = {}) {
  const result = await connection.send('Runtime.evaluate', {
    expression,
    awaitPromise: options.awaitPromise ?? false,
    returnByValue: options.returnByValue ?? true,
    userGesture: options.userGesture ?? false,
    // DevTools would otherwise serialise the value and lose `undefined` vs `null`.
    includeCommandLineAPI: false
  }, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS })

  if (result.exceptionDetails !== undefined) {
    const details = result.exceptionDetails
    const text = details.exception?.description ?? details.exception?.value ?? details.text ?? 'evaluation failed'
    // Carry the PAGE-side stack. Without it, an error thrown deep inside the
    // editor's own code arrives as one anonymous sentence, and the only way to find
    // out where it came from is to reproduce it by hand.
    const frames = (details.stackTrace?.callFrames ?? [])
      .slice(0, 8)
      .map((frame) => `    at ${frame.functionName || '(anonymous)'} (${frame.url || 'page'}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`)
    const stack = details.exception?.description === undefined && frames.length === 0 ? '' : `\n${frames.join('\n')}`
    throw new CdpError(`page threw: ${text}${stack}`)
  }
  return result.result?.value
}

/**
 * Call a function in the page with JSON arguments, avoiding source splicing.
 *
 * @param {CdpConnection} connection an open connection
 * @param {string} body function body, e.g. `(args) => args.x + 1` — a complete arrow/function expression
 * @param {unknown[]} args arguments, serialised as JSON
 * @param {{timeoutMs?: number, awaitPromise?: boolean}} [options] call options
 * @returns {Promise<any>} the call result
 */
export async function callFunction (connection, body, args = [], options = {}) {
  return evaluate(connection, `(${body})(${args.map((value) => JSON.stringify(value ?? null)).join(',')})`, options)
}
