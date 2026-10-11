/**
 * dsh-gandi — the tool surface.
 *
 * A HOST-plane cordis plugin. It registers into the tools registry's global layer
 * from a plain (non-agent) context, which is what makes one package serve both DSH
 * surfaces: dsh-tui composes its agent plane process-wide, while the web surface
 * disables agent-plane host rows and mounts them per session from presets — and a
 * preset agent's scope chain still merges the global layer
 * (`@deepseek-ai/dsh-tools` `ToolRuntime.register`: "Register globally or in the
 * calling agent scope"; `restrict` speaks of "known global tools"). Verified on the
 * web surface: the installed host-plane tool appeared in this session's catalog.
 *
 * Deliberately dependency-free. `ctx.tools.register()` takes a ready-made
 * ToolDefinition, so nothing from `@deepseek-ai/*` is imported and no package
 * resolution assumption is baked in. `register()` validates only `output.schema`,
 * `timeoutMs` and the name — NOT `parameters` — so every tool validates its own
 * arguments and fails with one readable sentence instead of a stack trace.
 *
 * Optional services (`attachments`, `skills`, `systemPrompt`) are soft-probed and
 * degrade silently: a missing service must never stop the host from booting.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_BACKDROP_SVG, DEFAULT_SPRITE_SVG, blankProject, readSb3, starterProject, writeSb3 } from './scratch/sb3.mjs'
import { applyFragmentToProject, findProjectTarget, summarizeProject, targetXmlFromProject } from './scratch/project.mjs'
import { formatMerge, mergeProjects } from './scratch/merge.mjs'
import { formatReport, verifyProject } from './scratch/verify.mjs'
import { SAMPLE_RATE, encodeWav, synthesizeTone } from './scratch/wav.mjs'
import { compileScripts, extensionsOfFragment, proceduresFromBlocks, randomBlockId } from './scratch/xml.mjs'
import { CORE_OPCODES } from './scratch/menus.mjs'
import { fragmentToEngine } from './scratch/engine.mjs'
import { assertLooksLikeSvg, defaultRotationCenter } from './scratch/svg.mjs'
import { isPostableKey, knownKeyNames, toDomKey } from './scratch/keys.mjs'
import { extensionFacts, formatExtensionCatalogue, formatExtensionDialect, loadExtension } from './bridge/extensions.mjs'
import {
  addCostume,
  addSound,
  applyFragment,
  duplicateSprite,
  editCostume,
  editSprite,
  editSound,
  editVariable,
  exportSb3,
  getProcedureDeclarations,
  getTargetXml,
  keepOnlyCostume,
  loadProjectBytes,
  loadProjectJson,
  observe,
  postKey,
  postMouse,
  resetVariables,
  runSteps,
  screenshot,
  selectTarget,
  setTargetState,
  stopAll,
  stripSprite
} from './bridge/ops.mjs'
import { DEFAULT_PORT, resolveAppPath } from './bridge/app.mjs'
import { createLauncher, launcherExists, launcherPath, patchGandiShortcuts } from './bridge/launcher.mjs'
import { SurfaceState } from './bridge/surface.mjs'
import { BridgeService } from './plugin/service.mjs'

/** Cordis plugin name, used by loader diagnostics. */
export const name = 'gandi'

/** Only the tools registry is required; everything else is optional. */
export const inject = ['tools']

const VERSION = '0.1.0'

// ── configuration ───────────────────────────────────────────────────────────

/**
 * Resolve configuration, giving every key a default, and apply environment
 * overrides.
 *
 * The environment variables exist because "where is Gandi installed" is a
 * machine-level fact, and the plugin is installed into more than one profile;
 * repeating it in each `cordis.patch.yml` would be a needless foot-gun.
 *
 * @param {Record<string, unknown>} config the loader row's config
 * @returns {any} effective configuration
 */
const resolveConfig = (config = {}) => {
  const envPath = process.env.GANDI_APP_PATH
  const envPort = Number(process.env.GANDI_PORT)
  const envAuto = process.env.GANDI_AUTO_LAUNCH
  return {
    appPath: typeof config.appPath === 'string' && config.appPath.length > 0
      ? config.appPath
      : (typeof envPath === 'string' && envPath.length > 0 ? envPath : undefined),
    port: Number.isInteger(config.port) && config.port > 0
      ? config.port
      : (Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT),
    autoLaunch: typeof config.autoLaunch === 'boolean'
      ? config.autoLaunch
      : (envAuto === undefined ? false : envAuto === '1' || envAuto === 'true'),
    leaseIdleMs: Number.isInteger(config.leaseIdleMs) && config.leaseIdleMs > 0 ? config.leaseIdleMs : 60000,
    launchTimeoutMs: Number.isInteger(config.launchTimeoutMs) && config.launchTimeoutMs > 0 ? config.launchTimeoutMs : 45000,
    // Only the EXPENSIVE "re-create the editor view" path is rate-limited by this: switching
    // a view costs nothing, so it is never suppressed. 0 disables the limit.
    recreateCooldownMs: Number.isInteger(config.recreateCooldownMs) && config.recreateCooldownMs >= 0 ? config.recreateCooldownMs : 30000,
    maxTextChars: Number.isInteger(config.maxTextChars) && config.maxTextChars > 0 ? config.maxTextChars : 20000,
    screenshotOnRun: config.screenshotOnRun !== false,
    allowOutsideWorkspace: config.allowOutsideWorkspace === true,
    enableSystemPrompt: config.enableSystemPrompt === true,
    registerSkill: config.registerSkill !== false,
    debug: config.debug === true || process.env.DSH_TUI_DEBUG !== undefined
  }
}

// ── schemas ─────────────────────────────────────────────────────────────────

/**
 * Output schema for text-only tools.
 *
 * `additionalProperties` is deliberately omitted. The registry validates returned
 * values against this schema, and leaving the object open is what lets an
 * attachment reference — whose fields belong to the attachment service — ride
 * along without being enumerated (and re-broken) here.
 */
const TEXT_OUTPUT = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text']
}

/** Output schema for tools that may also attach a stage image. */
const IMAGE_OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    image: { type: 'object', additionalProperties: true }
  },
  required: ['text']
}

/** Output schema for gandi_launch, which reports what it started. */
const LAUNCH_OUTPUT = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    appPath: { type: 'string' },
    ready: { type: 'boolean' }
  },
  required: ['text']
}

/**
 * The one parameter every mutating tool gains, added centrally in `registerTool`.
 *
 * It exists because the lease conflict message told callers to "pass force: true to take
 * over" while no tool's schema accepted it — and a registry that validates arguments
 * with `additionalProperties: false` drops what it does not know, so the parameter never
 * arrived. A delivery tried it twice and got a byte-identical error. Injecting it in one
 * place is also what keeps the promise from rotting the next time a tool is added.
 */
const FORCE_PARAMETER = {
  type: 'boolean',
  description: 'Take the edit lease even while another session holds it, instead of waiting for it to go idle. Use when the holder has gone away, or when the editor is stuck mid-edit and reading a file from disk is the way out.'
}

// ── plugin ──────────────────────────────────────────────────────────────────

/**
 * Register the Scratch tool surface.
 * @param {any} ctx cordis plugin context
 * @param {Record<string, unknown>} [rowConfig] the loader row's config
 */
export function apply (ctx, rowConfig = {}) {
  const config = resolveConfig(rowConfig)
  const service = new BridgeService(config)

  /** Soft-probe an optional service. */
  const optional = (serviceName) => {
    try {
      return ctx.get(serviceName, false) ?? null
    } catch {
      return null
    }
  }
  const attachments = optional('attachments')
  const skills = optional('skills')

  if (config.debug) {
    process.stderr.write(`[${name}] v${VERSION} active (port ${config.port}, appPath ${config.appPath ?? 'auto'})\n`)
  }

  /**
   * Format a Scratch error as one readable sentence. Anything unrecognised is
   * rethrown so real bugs stay visible instead of being flattened into prose.
   * @param {unknown} error the failure
   */
  const rethrowReadable = (error) => {
    const message = error?.message ?? String(error)
    if (error?.name === 'BridgeUnavailableError' ||
        error?.name === 'LeaseConflictError' ||
        error?.name === 'AppUnavailableError' ||
        error?.name === 'Sb3Error' ||
        error?.name === 'ScriptCompileError' ||
        error?.name === 'EngineConversionError' ||
        error?.name === 'ScratchOpError') {
      throw new Error(message)
    }
    if (error?.name === 'CdpError' || error?.name === 'CdpUnreachableError') {
      throw new Error(`the Gandi bridge failed: ${message}. Call gandi_status to check whether the editor is still reachable.`)
    }
    throw error
  }

  const clamp = (text) => text.length <= config.maxTextChars
    ? text
    : `${text.slice(0, config.maxTextChars)}\n… truncated ${text.length - config.maxTextChars} characters (raise maxTextChars in the plugin config for more)`

  /**
   * One line about whether the user can see the editor the bridge drives.
   *
   * This is the answer to "the model says it is working, but I only see the home page":
   * Gandi's window, its home page and every editor are separate views, and only one of
   * them is on screen at a time.
   *
   * @param {any} surface the reading from the service
   * @returns {string} a sentence for the tool output
   */
  const describeSurface = (surface) => {
    if (surface === null || surface === undefined) return 'not read yet'
    switch (surface.state) {
      case SurfaceState.ON_SCREEN:
        return 'the editor view the bridge drives is the one on screen'
      case SurfaceState.BEHIND_GANDI_VIEWS:
        return 'another Gandi view (the home page, or one of the user\'s own projects) is in front of the editor — the next edit will put the editor back in front'
      case SurfaceState.WINDOW_BEHIND:
        return 'the Gandi window itself is behind another window, so the user cannot see it right now (the bridge never steals focus to change that)'
      case SurfaceState.NO_EDITOR:
        return 'no editor view is open yet'
      default:
        return 'unknown (the Gandi window could not be read)'
    }
  }

  /**
   * Render a Scratch value the way Scratch shows it.
   *
   * A number is a number; a string keeps its quotes so `n="7"` and `n=7` stay
   * distinguishable — a script that assigns text and one that assigns a number look
   * identical otherwise, and the difference decides how the value compares later.
   *
   * @param {unknown} value the value to render
   * @returns {string} one readable token
   */
  const formatValue = (value) => {
    if (value === null || value === undefined) return '(empty)'
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value) ?? String(value)
      } catch {
        return String(value)
      }
    }
    return JSON.stringify(String(value))
  }

  /**
   * Whether two Scratch values read the same, for the run report's "changed" list.
   *
   * Deliberately loose: Scratch has one number type, so 1 and "1" are the same value to
   * every block that will ever read them, and reporting that as a change would be noise.
   *
   * @param {unknown} a the value before
   * @param {unknown} b the value after
   * @returns {boolean} true when they read the same
   */
  const sameValue = (a, b) => {
    if (Array.isArray(a) || Array.isArray(b)) {
      return JSON.stringify(a ?? []) === JSON.stringify(b ?? [])
    }
    if (a === null || a === undefined || b === null || b === undefined) return a === b
    if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b) || String(a) === String(b)
    return String(a) === String(b)
  }

  /**
   * Hash of the last stage image handed out by `gandi_run`.
   *
   * Kept so a capture that repeats byte-for-byte can be called out. A delivery judged
   * three runs by an image that never changed and concluded the stage was not rendering;
   * the same bytes arriving twice is information, and hiding it is what made that
   * expensive.
   * @type {string|null}
   */
  let lastStageHash = null

  const requireString = (value, label) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${label} must be a non-empty string`)
    }
    return value
  }

  /** Session label used for the write lease. */
  const sessionOf = (exec) => String(
    exec?.agent?.session?.header?.id ??
    exec?.agent?.session?.header?.sessionId ??
    exec?.agent?.id ??
    'unknown-session'
  )

  /** Session working directory, used as the default project root. */
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd ?? process.cwd()

  /** Resolve a path and keep it inside the session workspace unless allowed. */
  const resolveProjectPath = (requested, exec) => {
    const base = cwdOf(exec)
    const absolute = isAbsolute(requested) ? requested : resolve(base, requested)
    if (config.allowOutsideWorkspace) return absolute
    const rel = relative(base, absolute)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`refusing to touch "${absolute}": it is outside the session workspace (${base}). ` +
        'Write inside the workspace, or set allowOutsideWorkspace: true in the plugin config.')
    }
    return absolute
  }

  /**
   * Persist a PNG through the attachment service so it can ride a tool result as
   * an image block. The service owns the normalized reference.
   * @param {Buffer} bytes PNG bytes
   * @returns {Promise<any>} the attachment reference
   */
  const saveImage = async (bytes) => {
    try {
      return await attachments.saveImage({
        data: new Uint8Array(bytes),
        mediaType: 'image/png',
        name: 'scratch-stage.png'
      })
    } catch (error) {
      throw new Error(`could not attach the stage image: ${error?.message ?? error}. The text state above is still valid.`)
    }
  }

  /**
   * Turn an image result into either an attached image or a saved-file fallback,
   * depending on whether this deployment has the attachments service.
   * @param {{dataUri: string, width: number, height: number}} shot the capture
   * @param {string} prefix text to keep beside the image
   * @param {any} exec tool execution context
   * @returns {Promise<{text: string, image?: any}>} the tool value
   */
  const withStageImage = async (shot, prefix, exec) => {
    const bytes = Buffer.from(shot.dataUri.replace(/^data:image\/png;base64,/, ''), 'base64')
    const summary = `${prefix}\nstage image ${shot.width}x${shot.height} (${bytes.length} bytes)`
    if (attachments === null) {
      const fallback = resolveProjectPath(`scratch-stage-${Date.now()}.png`, exec)
      await writeFile(fallback, bytes)
      return { text: `${summary}\n(no attachments service in this deployment; the PNG was written to ${fallback} — read that file to see the stage)` }
    }
    return { text: summary, image: await saveImage(bytes) }
  }

  /**
   * Read a project from disk, with or without a container.
   *
   * A bare `project.json` is accepted as well as a `.sb3`, because that is what a
   * model tends to have after editing JSON directly — and because the offline path
   * only needs the document, not the assets.
   *
   * @param {string} absolute path to read
   * @returns {Promise<{project: any, assets: Map<string, Buffer>, warnings: string[]}>} the project and its assets
   */
  const readProjectFile = async (absolute) => {
    const bytes = await readFile(absolute)
    if (absolute.toLowerCase().endsWith('.json')) {
      let project
      try {
        project = JSON.parse(bytes.toString('utf8'))
      } catch (error) {
        throw new Error(`${absolute} is not valid JSON: ${error.message}`)
      }
      if (!Array.isArray(project?.targets)) throw new Error(`${absolute} has no targets array, so it is not a project document`)
      return { project, assets: new Map(), warnings: [] }
    }
    return readSb3(bytes)
  }

  /**
   * The access a mutating tool asks for.
   *
   * `force` is a REAL parameter on every mutating tool (injected in `registerTool`),
   * because the lease error used to offer it while no tool schema accepted it — and the
   * registries validate arguments with `additionalProperties: false`, so the parameter
   * was stripped before it ever reached the service. The advice was unfollowable by
   * construction, which is worse than having no advice at all.
   *
   * @param {any} args the tool arguments
   * @param {string} sessionId the calling session
   * @returns {{sessionId: string, mutating: boolean, force: boolean}} the access
   */
  const writeAccess = (args, sessionId) => ({ sessionId, mutating: true, force: args?.force === true })

  /**
   * Extension facts, cached for a few seconds. ONE cache slot, keyed by nothing: there
   * is one editor per process, and the answer goes stale only when someone loads an
   * extension — which is exactly what the caller of this helper is often about to do.
   * A wrong-but-recent answer would mean "unknown extension" for an extension that was
   * just loaded, so the TTL is short and every caller that LOADS clears it by writing
   * the new facts back.
   * @type {{at: number, facts: any}|null}
   */
  let extensionCache = null
  const EXTENSION_CACHE_MS = 15000

  /**
   * The editor's extension facts, or null when there is no editor to ask.
   *
   * Soft-probed on purpose: `gandi_apply` and `gandi_verify` must keep working with the
   * editor closed (that is the whole offline half of this plugin), and a project with no
   * extension blocks must not pay for a CDP round trip at all. Callers use this only
   * after they already know extension blocks are involved.
   *
   * @param {string} sessionId the calling session
   * @param {{fresh?: boolean}} [options] bypass the cache
   * @returns {Promise<any|null>} the facts, or null when the editor cannot be reached
   */
  const probeExtensions = async (sessionId, options = {}) => {
    if (options.fresh !== true && extensionCache !== null && Date.now() - extensionCache.at < EXTENSION_CACHE_MS) {
      return extensionCache.facts
    }
    try {
      const facts = await service.use({ sessionId, mutating: false }, (connection) => extensionFacts(connection))
      extensionCache = { at: Date.now(), facts }
      return facts
    } catch {
      // No editor, no editor tab, or a page that has no extension manager: all three are
      // "cannot ask", and none of them is a reason to fail the call.
      return null
    }
  }

  /**
   * The extension ids this editor is known to offer. `gandi_verify` uses it to tell "an
   * opcode nobody can load" from "an extension block from something Gandi can load" —
   * the editor's catalogue has 93 ids on 1.0.5, most of them community extensions no
   * static list would have.
   * @param {string} sessionId the calling session
   * @returns {Promise<string[]>} known ids (empty when there is no editor)
   */
  const knownExtensionIds = async (sessionId) => {
    const facts = await probeExtensions(sessionId)
    if (facts === null || facts.available !== true) return []
    return [...(facts.catalogueIds ?? []), ...(facts.builtinIds ?? [])]
  }

  /**
   * Whether the XML mentions any block that is not a core one.
   *
   * A cheap pre-check so that an ordinary script never costs a CDP round trip: every
   * core block type is in the generated table, so one unknown `type=` attribute is the
   * signal that extensions may be involved. The answer being wrong in the "yes"
   * direction only costs one query.
   *
   * @param {string} xml the script XML
   * @returns {boolean} true when some block type is not a core opcode
   */
  const mentionsNonCoreBlock = (xml) => {
    for (const match of xml.matchAll(/type="([^"]+)"/g)) {
      if (!CORE_OPCODES.has(match[1])) return true
    }
    return false
  }

  /**
   * What to tell an author whose script needs an extension the editor does not have.
   * @param {string[]} missing the extension ids the XML needs
   * @param {any|null} facts what the editor said, when it answered
   * @returns {string} a sentence naming the fix
   */
  const extensionHint = (missing, facts) => {
    const loadable = facts === null ? [] : (facts.catalogueIds ?? [])
    const builtin = facts === null ? [] : (facts.builtinIds ?? [])
    const lines = [`this script uses the extension(s) ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not loaded in this editor`]
    const canLoad = missing.filter((id) => loadable.includes(id) || builtin.includes(id))
    if (canLoad.length > 0) {
      lines.push(`load ${canLoad.length === 1 ? 'it' : 'them'} first: gandi_extension {action: "load", id: "${canLoad[0]}"}`)
    }
    if (facts === null) {
      lines.push('no editor answered, so this cannot be checked: pass `path` to edit a file offline (extension blocks are then written as named), or open an editor with gandi_launch')
    } else {
      const unknown = missing.filter((id) => !canLoad.includes(id))
      if (unknown.length > 0) {
        lines.push(`this editor does not offer ${unknown.join(', ')} — gandi_extension {action: "list"} prints every id it does (${loadable.length} of them)`)
      }
    }
    return lines.join('. ')
  }

  /**
   * Register one tool. `mutating` tools take the project lease and are serialised
   * against every other tool in this process.
   * @param {{name: string, description: string, parameters: any, schema?: any, mutating?: boolean, concurrencySafe?: boolean, run: (args: any, exec: any, sessionId: string) => Promise<any>}} definition tool definition
   */
  const registerTool = (definition) => {
    const mutating = definition.mutating === true
    const parameters = mutating && typeof definition.parameters === 'object' && definition.parameters !== null
      ? { ...definition.parameters, properties: { ...(definition.parameters.properties ?? {}), force: FORCE_PARAMETER } }
      : definition.parameters
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters,
      output: {
        schema: definition.schema ?? TEXT_OUTPUT,
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: value.text }]
          if (value.image !== undefined && value.image !== null) {
            blocks.push({ type: 'image', attachment: value.image })
          }
          return blocks
        }
      },
      isConcurrencySafe: () => definition.concurrencySafe === true,
      async execute (args, exec) {
        const sessionId = sessionOf(exec)
        try {
          const value = await definition.run(args ?? {}, exec, sessionId)
          // A note about the user's screen rides the NEXT result: when the editor had to
          // be re-created in front, the person reading this is the one who needs to know
          // (their undo history went with the old view).
          const note = service.takeSurfaceNote()
          if (note !== null && value !== null && typeof value === 'object' && typeof value.text === 'string') {
            return { ...value, text: `${value.text}\n${note}` }
          }
          return value
        } catch (error) {
          rethrowReadable(error)
        }
      }
    })
  }

  // ── status ────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_status',
    concurrencySafe: true,
    description: [
      'Report whether the Gandi bridge is reachable, what project is open, and who holds the edit lease.',
      'When an editor is attached it also reports per sprite: scripts, blocks, clones, costumes and how many variables/lists it owns.',
      'Cheap; call it first when another gandi_* tool fails, and after a run that "did nothing" — a sprite with 0 clones is the shortest path to a cloning bug.'
    ].join(' '),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run (_args, exec, sessionId) {
      const status = await service.status()
      const lines = [
        `port ${status.port}: ${status.portOpen ? 'open' : 'closed'}`,
        `editor tab: ${status.editorOpen ? `open${status.editorTabId === null ? '' : ` (${status.editorTabId})`}` : 'none'}`,
        `connection: ${status.connected ? 'attached' : 'not attached'}`,
        `editor on screen: ${describeSurface(status.surface)}`,
        `Gandi process: ${status.processRunning ? `running${status.processCount === null ? '' : ` (${status.processCount} process(es))`}` : 'not running'}`,
        `attachable endpoint: ${status.attachable === null ? 'none' : `port ${status.attachable.port} (${status.attachable.source})`}`,
        `app path: ${status.appPath ?? '(not found — set appPath or GANDI_APP_PATH)'}`,
        `auto-launch: ${status.autoLaunch ? 'on' : 'off'}`,
        `attachable launcher: ${status.launcher.exists ? status.launcher.path : `not created yet (${status.launcher.path}; gandi_launch {launcher: true} makes it)`}`,
        `workspace: ${cwdOf(exec)}`,
        `lease: ${status.lease === null ? 'free' : `held by session ${status.lease.sessionId} (idle ${Math.round(status.lease.idleMs / 1000)}s of ${Math.round(status.leaseIdleMs / 1000)}s)`}`,
        `this session: ${sessionId}`,
        `last run: ${status.lastRun === null ? '(none since this process started)' : status.lastRun}`
      ]
      if (status.lastError !== null) lines.push(`last error: ${status.lastError}`)
      if (!status.connected) {
        if (status.portOpen && status.editorOpen) {
          lines.push('NOTE: the debug port is open but attaching failed — see last error above.')
        } else if (status.portOpen) {
          // The common Gandi state: the app is up on its project browser and simply has
          // no editor tab. Nothing is broken; one call opens one.
          lines.push('NOTE: Gandi is on the debug port but has no editor tab open. Call gandi_launch (or any other gandi_* tool) and one will be opened.')
        } else if (status.processRunning) {
          lines.push(
            'NOTE: Gandi is running but was NOT started with --remote-debugging-port, and a running Gandi cannot be made attachable. ' +
            'It is still open: nothing was closed. Open Gandi from the attachable launcher instead, or ask the user and then call ' +
            'gandi_launch {restart: true} to close that window and start an attachable one.'
          )
        } else {
          lines.push('NOTE: call gandi_launch to start Gandi and open an editor tab, or gandi_open to work with a .sb3 file without the editor.')
        }
        return { text: lines.join('\n') }
      }
      const state = await service.use({ sessionId, mutating: false }, (connection) => observe(connection, { includeClones: false }))
      lines.push(`editing target: ${state.editingTarget?.name ?? '(none)'}`, `threads: ${state.threads}`)
      for (const target of state.targets) {
        const scalars = target.variables.filter((variable) => variable.type !== 'list' && variable.type !== 'broadcast_msg')
        const lists = target.variables.filter((variable) => variable.type === 'list')
        const own = target.isStage
          ? `globals: ${scalars.length} variable(s), ${lists.length} list(s)`
          : `own: ${scalars.length} variable(s), ${lists.length} list(s)`
        lines.push(`  ${target.name}${target.isStage ? ' (stage)' : ''}: ${target.scripts} script(s), ${target.blocks} block(s), ` +
          `${target.clones} clone(s), ${own}, costumes: ${target.costumes.join(', ') || 'none'}` +
          (target.sounds.length > 0 ? `, sounds: ${target.sounds.join(', ')}` : ''))
      }
      return { text: lines.join('\n') }
    }
  })

  // ── lease ─────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_lease',
    concurrencySafe: true,
    description: [
      'Read or change who may edit the open project.',
      'Mutating tools take a lease so two sessions cannot drive one editor; it expires after an idle window.',
      'action "status" (default) reports the holder; "release" gives it up if you hold it; "take" claims it outright —',
      'which is the way out when the holder has gone away and waiting would be pointless.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'release', 'take'], description: 'What to do (default status).' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const action = args.action === undefined ? 'status' : requireString(args.action, 'action')
      if (!['status', 'release', 'take'].includes(action)) {
        throw new Error(`unknown action "${action}"; use status, release or take`)
      }
      const result = service.lease({ action, sessionId })
      return {
        text: [
          `${action}: ${result.note}`,
          `lease: ${result.lease === null ? 'free' : `session ${result.lease.sessionId} (idle ${Math.round(result.lease.idleMs / 1000)}s)`}`,
          `this session: ${sessionId}`,
          `idle window: ${Math.round(result.idleMs / 1000)}s (set leaseIdleMs in the plugin config to change it)`
        ].join('\n')
      }
    }
  })

  // ── load check ────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_verify',
    concurrencySafe: true,
    description: [
      'Check whether the editor will actually OPEN a project file, before anything tries.',
      'Offline by default: it reads the .sb3 and reports the failures that only show up at load time —',
      'a block whose opcode is read as an extension id ("Extension not found"), a custom-block mutation missing',
      'fields the editor dereferences, a dropdown shadow that is not the one the block expects, a field naming a',
      'variable nothing declares, an asset the archive does not contain.',
      'Pass live: true to go further and hand the file to the editor\'s own deserializer, restoring whatever was',
      'open afterwards — the definitive answer, and the only check that can be wrong in neither direction.',
      'Extension blocks are judged against what the editor actually offers: a block from a loadable extension is',
      'reported as a note, not as an unknown opcode, and a project that declares an extension nothing can load is a warning.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A .sb3 (or project.json) on disk to check.' },
        live: { type: 'boolean', description: 'Also load it in the editor and restore what was open (default false).' },
        maxIssues: { type: 'number', description: 'How many findings to print per section (default 12).' }
      },
      required: ['path'],
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const absolute = resolveProjectPath(requireString(args.path, 'path'), exec)
      const { project, assets, warnings: containerWarnings } = await readProjectFile(absolute)
      // What this editor can load, when there is one. Without it the check falls back to
      // the short built-in list, which is enough to say "this is an extension block"
      // for the standard ones and nothing at all for the 90-odd Gandi-only ids.
      const knownExtensions = await knownExtensionIds(sessionId)
      const report = verifyProject(project, { assets, knownExtensions })
      for (const warning of containerWarnings) report.warnings.push(`archive: ${warning}`)

      const lines = [`checked ${absolute}`, formatReport(report, { heading: 'offline load check' })]
      if (knownExtensions.length > 0) {
        lines.push(`(extension blocks were judged against the ${knownExtensions.length} extension id(s) this editor offers)`)
      } else {
        lines.push('(no editor answered, so extension blocks were judged against the standard Scratch extension names only)')
      }
      if (args.live !== true) {
        if (report.errors.length > 0) {
          lines.push('This file would fail to load. Fix the errors above, or pass live: true to confirm against the editor itself.')
        }
        return { text: clamp(lines.join('\n')) }
      }

      // The definitive check: the editor's own deserializer, with a snapshot taken
      // first. A project that cannot be deserialized is exactly the case that leaves
      // the editor mid-load, which is why the restore is attempted unconditionally.
      const bytes = absolute.toLowerCase().endsWith('.json')
        ? writeSb3(project, assets)
        : await readFile(absolute)
      const outcome = await service.use({ sessionId, mutating: true, force: args.force === true }, async (connection) => {
        const snapshot = await exportSb3(connection)
        let loaded = null
        let failure = null
        try {
          loaded = await loadProjectBytes(connection, bytes)
        } catch (error) {
          failure = error?.message ?? String(error)
        }
        let restored = null
        try {
          const back = await loadProjectBytes(connection, snapshot)
          restored = `${back.targets.length} target(s)`
        } catch (error) {
          restored = `FAILED: ${error?.message ?? String(error)}`
        }
        return { loaded, failure, restored }
      })

      lines.push('', 'live load check (editor deserializer):')
      if (outcome.failure === null) {
        lines.push(`  the editor OPENED it: ${outcome.loaded.targets.map((t) => `${t.name} (${t.blocks} blocks)`).join(', ')}`)
      } else {
        lines.push(`  the editor REJECTED it: ${outcome.failure}`)
      }
      lines.push(`  restored what was open: ${outcome.restored}`)
      return { text: clamp(lines.join('\n')) }
    }
  })

  // ── extensions ────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_extension',
    mutating: true,
    description: [
      'Extensions: the block categories a project adds from Gandi\'s 添加扩展 library — music, pen, video sensing,',
      'text-to-speech, and Gandi\'s own (CCW3D, GandiAIHub, box2d, …). An extension\'s blocks only exist once it is',
      'LOADED into the running editor, so this tool is both the catalogue and the loader.',
      'action "list" (default) prints what this editor offers and what is already loaded, including each loaded',
      'extension\'s blocks, their inputs and their dropdown shadow types — the dialect gandi_apply accepts.',
      'action "load" loads one by id (the same call the 添加扩展 button makes) and prints its dialect, which is what',
      'makes those blocks writable. Loading also puts the category in the toolbox, so the user can drag the blocks too.',
      'Loading changes editor state but never the project: a project only records an extension once a block of it is used.',
      'A device-backed extension (camera/microphone — GandiKamera, faceSensing, videoSensing, …) starts that device the',
      'moment it loads; "list" marks those with [uses a device], and the load result says what was opened and that it was',
      'stopped again. There is nothing to confirm: loading is the user\'s own action, and the device is released afterwards.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'load'], description: 'list (default) reports; load brings one in.' },
        id: { type: 'string', description: 'With action "load": the extension id, e.g. "music", "pen", "text2speech". gandi_extension {action:"list"} prints every id this editor offers.' },
        filter: { type: 'string', description: 'With action "list": only ids containing this text.' },
        limit: { type: 'number', description: 'With action "list": how many rows to print (default 200).' },
        dialect: { type: 'boolean', description: 'With action "list": also print the full block dialect of every loaded extension (default true).' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const action = args.action === 'load' ? 'load' : 'list'

      if (action === 'load') {
        const id = requireString(args.id, 'id')
        const outcome = await service.use(writeAccess(args, sessionId), async (connection) => {
          const loaded = await loadExtension(connection, id)
          // Read the editor's state back in the SAME visit: every caller of this tool is
          // about to write blocks for the extension it just loaded, and a cached "not
          // loaded" would refuse them. One extra query is cheaper than that failure.
          let facts = null
          try {
            facts = await extensionFacts(connection)
          } catch {
            facts = null
          }
          return { loaded, facts }
        })
        extensionCache = outcome.facts === null ? null : { at: Date.now(), facts: outcome.facts }
        const result = outcome.loaded
        const stopped = result.mediaStopped ?? []
        const lines = [
          result.alreadyLoaded
            ? `${id} was already loaded in this editor`
            : `loaded ${id} into the editor in ${result.ms}ms`,
          `loaded extensions now: ${result.loadedIds.join(', ') || 'none'}`,
          'the category is now in the toolbox, so the user can drag these blocks too',
          // Loading a device-backed extension opens the device — the editor does it by
          // itself, and nothing closes it again. Say so, and say that it was closed here:
          // a camera light appearing because a tool ran is exactly the kind of thing the
          // user has to be told about, not discover.
          ...(stopped.length > 0
            ? [`NOTE: this extension is DEVICE-backed. Loading it opened ${stopped.map((track) => track.kind).join(' + ')} ` +
               `(${stopped.map((track) => track.label || track.where).join(', ')}) — the editor starts it just by being loaded, ` +
               'and would have left it on. It has been STOPPED again, so your camera/microphone is not left running.']
            : []),
          '',
          formatExtensionDialect(result.extension)
        ]
        return { text: clamp(lines.join('\n')) }
      }

      const facts = await probeExtensions(sessionId, { fresh: true })
      if (facts === null) {
        throw new Error(`no editor answered on port ${config.port}, so its extension catalogue cannot be read. ` +
          'Extensions are the editor\'s own list (they are fetched from Gandi when loaded), so there is nothing to ' +
          'report without one: call gandi_launch, or gandi_status to see why the editor is not reachable.')
      }
      const lines = [
        formatExtensionCatalogue(facts, { filter: args.filter, limit: args.limit }),
        '',
        'loading one: gandi_extension {action: "load", id: "music"} — then write its blocks with gandi_apply, using the',
        'block types and dropdown shadows printed below. The project records the extension itself once a block is used.'
      ]
      if (args.dialect !== false && (facts.loaded ?? []).length > 0) {
        for (const extension of facts.loaded) {
          lines.push('', formatExtensionDialect(extension))
        }
        if ((facts.loaded ?? []).some((extension) => (extension.skippedBlocks ?? 0) > 0)) {
          lines.push('', '(a block with no opcode — Gandi\'s pen extension registers one — is left out: it cannot be written)')
        }
      }
      return { text: clamp(lines.join('\n')) }
    }
  })

  // ── launch ────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_launch',
    mutating: true,
    schema: LAUNCH_OUTPUT,
    description: [
      'Get Gandi Desktop ready to be driven: adopt the one that is already open, or start one, and open an editor tab the user can watch.',
      'A Gandi that is already running on a debug port is ALWAYS reused, whatever port it answers on — this never starts a second window.',
      'A Gandi running WITHOUT a debug port can never be attached to (the debug server only exists if the switch was there at start-up),',
      'and this NEVER closes it: it fails with the two ways forward instead. Pass restart: true to close that window (politely — the app',
      'may ask about unsaved work) and start an attachable Gandi. Pass launcher: true to create a shortcut that starts Gandi WITH the',
      'switch, so the Gandi the user opens themselves can be adopted from then on; patchShortcuts: true additionally rewrites the',
      'arguments of the Gandi shortcuts that already exist (each one is reported, with its previous arguments).'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        appPath: { type: 'string', description: 'Absolute path to Gandi.exe; defaults to the configured path or a discovered install.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the editor to load (default 45000).' },
        restart: { type: 'boolean', description: 'Close a running Gandi that cannot be attached to, then start an attachable one. Ask the user first: unsaved work lives only in that window.' },
        launcher: { type: 'boolean', description: 'Create/refresh a Start Menu shortcut that starts Gandi with the debug port, so a Gandi the user opens themselves can be reused.' },
        patchShortcuts: { type: 'boolean', description: 'Also add the debug port to the arguments of the Gandi shortcuts that already exist (reported in full, reversible by hand).' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const requested = typeof args.appPath === 'string' && args.appPath.length > 0 ? args.appPath : config.appPath
      const appPath = resolveAppPath(requested)
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : config.launchTimeoutMs
      const lines = []

      // An explicit path is honoured as given: quietly substituting a remembered or
      // discovered executable would make "I set appPath and it still used something
      // else" impossible to diagnose — and would start the wrong Gandi.
      if (typeof requested === 'string' && requested.length > 0 && appPath === null) {
        throw new Error(`no such executable: ${requested}. Fix appPath, or start Gandi yourself with --remote-debugging-port=${config.port}.`)
      }

      if (args.launcher === true || args.patchShortcuts === true) {
        if (appPath === null) {
          throw new Error('no Gandi executable is known, so no launcher can be pointed at one. Pass appPath once, or set appPath / GANDI_APP_PATH.')
        }
        if (args.launcher === true) {
          const made = await createLauncher({ appPath, port: config.port })
          lines.push(`${made.note}`)
        }
        if (args.patchShortcuts === true) {
          const patched = await patchGandiShortcuts({ port: config.port })
          if (patched.changed.length === 0 && patched.failed.length === 0) {
            lines.push(patched.unchanged.length === 0
              ? 'no Gandi shortcut was found to patch (desktop, Start Menu, taskbar pin)'
              : `every Gandi shortcut already carries the debug port (${patched.unchanged.length} checked)`)
          }
          for (const entry of patched.changed) {
            lines.push(`patched ${entry.path}\n    was: ${entry.previousArgs.trim().length > 0 ? entry.previousArgs : '(no arguments)'}\n    now: ${entry.args}`)
          }
          for (const entry of patched.failed) {
            lines.push(`could NOT patch ${entry.path}: ${entry.error}`)
          }
        }
        // Creating a launcher is a change to the user's machine, not a launch: say what
        // was done and stop, so the model reports it instead of quietly starting Gandi.
        return {
          text: lines.join('\n'),
          appPath: appPath ?? '(unknown)',
          ready: false
        }
      }

      const result = await service.launch({ appPath, timeoutMs, restart: args.restart === true })
      const summary = result.adopted
        ? `adopted the running Gandi on port ${result.port} (found via ${result.source}) — no new window was started` +
          `${result.attached.opened ? ', opened an editor tab' : ''}`
        : `started Gandi from ${appPath} on port ${result.port}${result.closedNote}`
      const surface = service.lastSurface
      lines.push(`${summary}; editor ${result.attached.ready ? 'ready' : 'did not finish loading a project'}.`)
      if (surface !== null) lines.push(`editor view: ${describeSurface(surface)}`)
      return {
        text: lines.join('\n'),
        appPath: appPath ?? '(already running)',
        ready: result.attached.ready === true
      }
    }
  })

  // ── project files ─────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_open',
    mutating: true,
    description: 'Open a .sb3 (or a bare project.json) from disk in the running editor, replacing the open project. Reading metadata works without Gandi; opening always drives the live editor.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the .sb3 file, relative to the session workspace or absolute.' } },
      required: ['path'],
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const absolute = resolveProjectPath(requireString(args.path, 'path'), exec)
      const bytes = await readFile(absolute)
      return service.use(writeAccess(args, sessionId), async (connection) => {
        const summary = absolute.toLowerCase().endsWith('.json')
          ? await loadProjectJson(connection, JSON.parse(bytes.toString('utf8')))
          : await loadProjectBytes(connection, bytes)
        return {
          text: `opened ${absolute}\n${summary.targets.map((t) => `  ${t.name}${t.isStage ? ' (stage)' : ''}: ${t.blocks} block(s)`).join('\n')}`
        }
      })
    }
  })

  registerTool({
    name: 'gandi_new',
    mutating: true,
    description: [
      'Replace the open project with a brand-new one: a stage and one plain sprite.',
      'A project needs at least one sprite before any script can be attached to anything, so the starter sprite is included; pass `empty` for a bare stage instead.',
      'The starter costume is a plain circle you are expected to replace with gandi_costume.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        sprite: { type: 'string', description: 'Name for the starter sprite (default "Sprite1").' },
        svg: { type: 'string', description: 'SVG markup for the starter costume instead of the built-in circle.' },
        empty: { type: 'boolean', description: 'Create a stage with no sprites at all.' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const starter = args.empty === true
        ? (() => {
            const project = blankProject()
            const backdrop = project.targets[0].costumes[0]
            return { project, assets: new Map([[backdrop.md5ext, Buffer.from(DEFAULT_BACKDROP_SVG, 'utf8')]]) }
          })()
        : starterProject({
          spriteName: typeof args.sprite === 'string' && args.sprite.length > 0 ? args.sprite : undefined,
          spriteSvg: typeof args.svg === 'string' && args.svg.length > 0 ? args.svg : undefined
        })
      return service.use(writeAccess(args, sessionId), async (connection) => {
        // Load as an ARCHIVE, not as a JSON document. `loadProjectJson` hands the VM
        // a project whose costumes reference assets nothing has registered, and the
        // costume loader then waits forever for a load that can never happen — a
        // 120s timeout instead of an error. Archive bytes carry the assets with them.
        const bytes = writeSb3(starter.project, starter.assets)
        const summary = await loadProjectBytes(connection, bytes)
        return {
          text: [
            `new project loaded: ${summary.targets.length} target(s), ${bytes.length} bytes`,
            ...summary.targets.map((t) => `  ${t.name}${t.isStage ? ' (stage)' : ''}: ${t.blocks} block(s)`)
          ].join('\n')
        }
      })
    }
  })

  registerTool({
    name: 'gandi_sprite',
    mutating: true,
    description: [
      'Create, duplicate, rename, delete or select a sprite.',
      'action "create" builds a genuinely empty actor: it copies a sprite, throws away its scripts, its own variables and its costumes, and gives it the costume you supply (or a plain circle).',
      'action "duplicate" keeps everything — use it when the new actor should look like an existing one.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'duplicate', 'rename', 'delete', 'select'], description: 'What to do.' },
        target: { type: 'string', description: 'Sprite name or id. For create and duplicate this is the source; defaults to the editing target.' },
        name: { type: 'string', description: 'Name for the new sprite, or the new name for rename.' },
        svg: { type: 'string', description: 'For create: SVG markup for its only costume. Defaults to a plain circle.' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const action = requireString(args.action, 'action')
      if (!['create', 'duplicate', 'rename', 'delete', 'select'].includes(action)) {
        throw new Error(`unknown action "${action}"; use create, duplicate, rename, delete or select`)
      }
      const target = typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined
      const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : undefined
      // Validate before reaching for the editor: a typo should report the typo, not
      // whatever state the bridge happens to be in.
      if ((action === 'rename' || action === 'delete') && target === undefined) {
        throw new Error(`${action} needs a target`)
      }
      if (action === 'rename' && name === undefined) throw new Error('rename needs a name')

      const svg = typeof args.svg === 'string' && args.svg.trim().length > 0 ? args.svg : null
      if (svg !== null) assertLooksLikeSvg(svg)

      return service.use(writeAccess(args, sessionId), async (connection) => {
        if (action === 'duplicate') {
          const created = await duplicateSprite(connection, { target, name })
          return { text: `duplicated ${created.source} as ${created.name} (costumes: ${created.costumes.join(', ') || 'none'})\nsprites: ${created.sprites.join(', ')}` }
        }
        if (action === 'create') {
          // Copy, strip, re-costume: every step is an operation already proven
          // against a live editor, and none of them needs artwork from outside.
          const copied = await duplicateSprite(connection, { target, name })
          const stripped = await stripSprite(connection, { target: copied.name })
          const costumeSvg = svg ?? DEFAULT_SPRITE_SVG
          const centre = defaultRotationCenter(costumeSvg)
          const installed = await addCostume(connection, {
            target: copied.name,
            name: 'costume1',
            dataFormat: 'svg',
            base64: Buffer.from(costumeSvg, 'utf8').toString('base64'),
            rotationCenterX: centre.x,
            rotationCenterY: centre.y
          })
          const kept = await keepOnlyCostume(connection, { target: copied.name, keep: installed.costume })
          return {
            text: [
              `created ${copied.name} — empty sprite with one costume`,
              `cleared ${stripped.removedScripts} script(s) and ${stripped.removedVariables} local variable(s) inherited from ${copied.source}`,
              `costumes: ${kept.costumes.join(', ')} (removed ${kept.removed} inherited one(s))`,
              'add scripts with gandi_apply'
            ].join('\n')
          }
        }
        if (action === 'select') {
          const selected = await selectTarget(connection, { target: target ?? '' })
          return { text: `selected ${selected.selected}${selected.isStage ? ' (stage)' : ''}` }
        }
        const result = await editSprite(connection, { target, name, delete: action === 'delete' })
        return { text: `${action === 'delete' ? 'deleted' : 'renamed'} ${result.renamedFrom}\nsprites: ${result.sprites.join(', ')}` }
      })
    }
  })

  registerTool({
    name: 'gandi_costume',
    mutating: true,
    description: [
      'Add, rename or delete a costume — or a backdrop, with target "stage".',
      'To add: pass either `svg` text or `base64` plus `dataFormat`; the asset id is derived from the content.',
      'Add several at once with `costumes: [{name, svg}, …]`, which is one call instead of one per costume.',
      'To rename or delete: pass action and name (or index).',
      'When no rotation centre is given, the middle of the artwork is used, so the sprite rotates about its centre.',
      'For a 480x360 backdrop pass rotationCenterX 240, rotationCenterY 180 — a backdrop is positioned by its centre too,',
      'so 0,0 puts it off in a corner and only a quarter of it shows.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'rename', 'delete'], description: 'What to do (default add).' },
        target: { type: 'string', description: 'Sprite name or id, or "stage" for a backdrop. Defaults to the editing target.' },
        name: { type: 'string', description: 'Costume or backdrop name (default "costume"). For rename/delete: which one.' },
        newName: { type: 'string', description: 'For rename: the new name.' },
        index: { type: 'number', description: 'For rename/delete: 0-based index, instead of name.' },
        svg: { type: 'string', description: 'SVG markup. Mutually exclusive with base64.' },
        base64: { type: 'string', description: 'Base64 bytes of the image. Requires dataFormat.' },
        dataFormat: { type: 'string', description: 'svg, png, jpg, bmp or gif (default svg).' },
        rotationCenterX: { type: 'number', description: 'Rotation centre x, in costume pixels.' },
        rotationCenterY: { type: 'number', description: 'Rotation centre y, in costume pixels.' },
        costumes: {
          type: 'array',
          description: 'For add: several costumes in one call. Each entry takes the same fields as the top level (name, svg or base64+dataFormat, rotationCenterX/Y).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              svg: { type: 'string' },
              base64: { type: 'string' },
              dataFormat: { type: 'string' },
              rotationCenterX: { type: 'number' },
              rotationCenterY: { type: 'number' }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const action = args.action === undefined ? 'add' : requireString(args.action, 'action')
      if (!['add', 'rename', 'delete'].includes(action)) {
        throw new Error(`unknown action "${action}"; use add, rename or delete`)
      }
      const target = typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined

      if (action !== 'add') {
        const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : undefined
        if (name === undefined && !Number.isInteger(args.index)) throw new Error(`${action} needs a name or an index`)
        if (action === 'rename') requireString(args.newName, 'newName')
        return service.use(writeAccess(args, sessionId), async (connection) => {
          const result = await editCostume(connection, {
            target,
            action,
            name,
            index: Number.isInteger(args.index) ? args.index : undefined,
            newName: typeof args.newName === 'string' ? args.newName : undefined
          })
          const where = result.isStage ? 'the stage' : result.target
          return {
            text: action === 'rename'
              ? `renamed ${result.isStage ? 'backdrop' : 'costume'} "${result.requested}" to "${result.name}" on ${where}` +
                (result.renamed ? '' : ' (the name was already taken, so the editor kept a unique variant)') +
                `\n${result.isStage ? 'backdrops' : 'costumes'} now: ${result.costumes.join(', ')}`
              : `deleted ${result.isStage ? 'backdrop' : 'costume'} "${result.name}" from ${where}` +
                `\n${result.isStage ? 'backdrops' : 'costumes'} now: ${result.costumes.join(', ')}`
          }
        })
      }

      // Everything from here on adds costumes. A batch is a batch: the tool does the
      // loop, so a 55-costume art pass is one call and one lease acquisition.
      const entries = Array.isArray(args.costumes) && args.costumes.length > 0
        ? args.costumes.map((entry) => ({ ...args, ...entry, costumes: undefined, action: undefined }))
        : [args]
      if (entries.length > 1 && (typeof args.svg === 'string' || typeof args.base64 === 'string')) {
        throw new Error('pass either a single costume (svg/base64) or `costumes: [...]`, not both')
      }

      const prepared = entries.map((entry, index) => {
        const label = entries.length > 1 ? `costumes[${index}]` : 'costume'
        const hasSvg = typeof entry.svg === 'string' && entry.svg.trim().length > 0
        const hasBase64 = typeof entry.base64 === 'string' && entry.base64.trim().length > 0
        if (hasSvg === hasBase64) throw new Error(`${label}: pass exactly one of "svg" or "base64"`)
        const dataFormat = (typeof entry.dataFormat === 'string' && entry.dataFormat.length > 0
          ? entry.dataFormat
          : (hasSvg ? 'svg' : 'png')).toLowerCase()
        const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : 'costume'
        let base64 = entry.base64
        let centre = null
        if (hasSvg) {
          assertLooksLikeSvg(entry.svg)
          centre = defaultRotationCenter(entry.svg)
          base64 = Buffer.from(entry.svg, 'utf8').toString('base64')
        }
        return {
          name,
          dataFormat,
          base64,
          rotationCenterX: Number.isFinite(entry.rotationCenterX) ? Number(entry.rotationCenterX) : (centre?.x ?? 0),
          rotationCenterY: Number.isFinite(entry.rotationCenterY) ? Number(entry.rotationCenterY) : (centre?.y ?? 0)
        }
      })

      return service.use(writeAccess(args, sessionId), async (connection) => {
        const installed = []
        for (const request of prepared) {
          installed.push(await addCostume(connection, { target, ...request }))
        }
        const last = installed[installed.length - 1]
        const where = last.isStage ? 'the stage' : last.target
        const lines = installed.length === 1
          ? [`added ${last.kind} "${last.costume}" to ${where} (${last.bytes} bytes, ` +
             (last.isStage ? 'no rotation centre needed for a backdrop' : `rotation centre ${prepared[0].rotationCenterX}, ${prepared[0].rotationCenterY}`) + ')']
          : [`added ${installed.length} ${last.kind}s to ${where}: ${installed.map((entry) => `${entry.costume} (${entry.bytes} bytes)`).join(', ')}`]
        lines.push(`${last.kind}s now: ${last.costumes.join(', ')}`)
        return { text: lines.join('\n') }
      })
    }
  })

  registerTool({
    name: 'gandi_variable',
    mutating: true,
    description: [
      'Create, set, rename or delete a variable or a list.',
      'Scope matters in Scratch: globals live on the stage and every sprite sees them; locals belong to one sprite. The default is global.',
      'Setting a value changes it immediately, so gandi_run can observe the starting state.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'set', 'rename', 'delete'], description: 'What to do.' },
        name: { type: 'string', description: 'Variable name.' },
        newName: { type: 'string', description: 'New name, for rename.' },
        value: { type: 'string', description: 'Value to set. A list takes a comma-separated string, which Scratch splits into items.' },
        type: { type: 'string', enum: ['scalar', 'list'], description: 'scalar (default) or list.' },
        scope: { type: 'string', enum: ['global', 'local'], description: 'global (default, lives on the stage) or local to one sprite.' },
        target: { type: 'string', description: 'Sprite for a local variable. Defaults to the editing target.' }
      },
      required: ['action', 'name'],
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const action = requireString(args.action, 'action')
      if (!['create', 'set', 'rename', 'delete'].includes(action)) {
        throw new Error(`unknown action "${action}"; use create, set, rename or delete`)
      }
      const name = requireString(args.name, 'name')
      if (action === 'rename') requireString(args.newName, 'newName')
      if (action === 'create' && args.type !== undefined && args.type !== 'scalar' && args.type !== 'list') {
        throw new Error('type must be "scalar" or "list"')
      }
      if (action === 'set' && args.type === 'list' && typeof args.value !== 'string') {
        throw new Error('setting a list needs `value` as a comma-separated string')
      }

      return service.use(writeAccess(args, sessionId), async (connection) => {
        const result = await editVariable(connection, {
          action,
          name,
          // A real, unique id is mandatory: with null, scratch-vm keys the variable
          // under the string "null" and the next creation collides on that key.
          id: randomBlockId(),
          newName: typeof args.newName === 'string' ? args.newName : undefined,
          value: args.value,
          type: args.type,
          scope: args.scope,
          target: typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined
        })
        const globals = result.stage.map((v) => `${v.name}${v.type === 'list' ? ' (list)' : ''}=${JSON.stringify(v.value)}`)
        const locals = result.sprites
          .filter((s) => s.variables.length > 0)
          .map((s) => `${s.name}: ${s.variables.map((v) => `${v.name}=${JSON.stringify(v.value)}`).join(', ')}`)
        return {
          text: [
            `${action} ${args.type === 'list' ? 'list' : 'variable'} "${name}" ok`,
            `globals: ${globals.join(', ') || '(none)'}`,
            ...(locals.length > 0 ? [`sprite variables: ${locals.join('; ')}`] : [])
          ].join('\n')
        }
      })
    }
  })

  registerTool({
    name: 'gandi_sound',
    mutating: true,
    description: [
      'Add, rename or delete a sound on a sprite.',
      'To add: by default it SYNTHESIZES one from a pitch, a duration and a waveform — give `sweepTo` for a rise or a fall, which is what most game sounds are.',
      'Pass base64 instead to upload audio bytes you already have.',
      'action "rename" also rewrites every sound_play block that named it; action "delete" does not, so a script that',
      'played the removed sound keeps a name that resolves to nothing.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'rename', 'delete'], description: 'What to do (default add).' },
        target: { type: 'string', description: 'Sprite name or id. Defaults to the editing target.' },
        name: { type: 'string', description: 'Sound name (default "sound"). For rename/delete: which one.' },
        newName: { type: 'string', description: 'For rename: the new name.' },
        index: { type: 'number', description: 'For rename/delete: 0-based index, instead of name.' },
        frequency: { type: 'number', description: 'Starting pitch in Hz (default 440).' },
        sweepTo: { type: 'number', description: 'Glide to this frequency by the end.' },
        seconds: { type: 'number', description: 'Length in seconds (default 0.25).' },
        waveform: { type: 'string', enum: ['sine', 'square', 'triangle', 'sawtooth'], description: 'Timbre (default sine).' },
        volume: { type: 'number', description: 'Between 0 and 1 (default 0.6).' },
        base64: { type: 'string', description: 'Base64 audio bytes instead of synthesizing.' },
        dataFormat: { type: 'string', description: 'With base64: wav or mp3 (default wav).' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const action = args.action === undefined ? 'add' : requireString(args.action, 'action')
      if (!['add', 'rename', 'delete'].includes(action)) {
        throw new Error(`unknown action "${action}"; use add, rename or delete`)
      }
      const target = typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined

      if (action !== 'add') {
        const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : undefined
        if (name === undefined && !Number.isInteger(args.index)) throw new Error(`${action} needs a name or an index`)
        if (action === 'rename') requireString(args.newName, 'newName')
        return service.use(writeAccess(args, sessionId), async (connection) => {
          const result = await editSound(connection, {
            target,
            action,
            name,
            index: Number.isInteger(args.index) ? args.index : undefined,
            newName: typeof args.newName === 'string' ? args.newName : undefined
          })
          const keptName = result.name === result.requested
            ? ''
            : ` (asked for "${result.requested}"; the name was taken, so the editor kept "${result.name}")`
          return {
            text: action === 'rename'
              ? `renamed sound on ${result.target}: "${result.name}"${keptName}\nsounds now: ${result.sounds.join(', ') || '(none)'}`
              : `deleted sound "${result.name}" from ${result.target}\nsounds now: ${result.sounds.join(', ') || '(none)'}`
          }
        })
      }

      const hasBase64 = typeof args.base64 === 'string' && args.base64.trim().length > 0
      const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : 'sound'

      let base64 = args.base64
      let dataFormat = 'wav'
      let rate = SAMPLE_RATE
      let sampleCount = 0
      let described = ''
      if (hasBase64) {
        if (typeof args.frequency === 'number' || typeof args.seconds === 'number') {
          throw new Error('pass either `base64` or the synthesis parameters, not both')
        }
        dataFormat = typeof args.dataFormat === 'string' && args.dataFormat.length > 0 ? args.dataFormat.toLowerCase() : 'wav'
        described = `uploaded ${dataFormat}`
      } else {
        // synthesizeTone validates its arguments, so a nonsense pitch or duration
        // fails here rather than becoming a silent empty sound.
        const samples = synthesizeTone({
          frequency: args.frequency,
          sweepTo: args.sweepTo,
          seconds: args.seconds,
          waveform: args.waveform,
          volume: args.volume
        })
        base64 = encodeWav(samples).toString('base64')
        rate = SAMPLE_RATE
        sampleCount = samples.length
        described = `synthesized ${samples.length} frames at ${rate} Hz`
      }

      return service.use(writeAccess(args, sessionId), async (connection) => {
        const installed = await addSound(connection, {
          target: typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined,
          name,
          dataFormat,
          base64,
          rate,
          sampleCount
        })
        return {
          text: [
            `added sound "${installed.sound}" to ${installed.target} (${installed.bytes} bytes, ${described})`,
            `sounds now: ${installed.sounds.join(', ') || '(none)'}`
          ].join('\n')
        }
      })
    }
  })

  registerTool({
    name: 'gandi_place',
    mutating: true,
    description: 'Move or restyle a sprite directly, without writing a script: position, direction, size and visibility. Handy for setting a scene up before a screenshot.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Sprite name or id. Defaults to the editing target.' },
        x: { type: 'number', description: 'Stage x, −240 to 240 (right is positive).' },
        y: { type: 'number', description: 'Stage y, −180 to 180 (up is positive).' },
        direction: { type: 'number', description: 'Direction in degrees; 90 is right.' },
        size: { type: 'number', description: 'Size as a percentage.' },
        visible: { type: 'boolean', description: 'Show or hide the sprite.' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const numeric = (value) => (Number.isFinite(value) ? Number(value) : undefined)
      const request = {
        target: typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined,
        x: numeric(args.x),
        y: numeric(args.y),
        direction: numeric(args.direction),
        size: numeric(args.size),
        visible: typeof args.visible === 'boolean' ? args.visible : undefined
      }
      if (Object.values(request).every((value) => value === undefined)) {
        throw new Error('pass at least one of x, y, direction, size or visible')
      }
      return service.use(writeAccess(args, sessionId), async (connection) => {
        const state = await setTargetState(connection, request)
        return {
          text: `${state.target}: x=${state.x} y=${state.y} direction=${state.direction} size=${state.size}% visible=${state.visible}`
        }
      })
    }
  })

  registerTool({
    name: 'gandi_input',
    mutating: true,
    description: [
      'Set keyboard or mouse state for the running project, for testing interactive games.',
      'Use this for state that should already hold when a run starts — where the mouse is, or releasing a key left over from an earlier run.',
      'Do NOT use it to test holding a key down: pressing the green flag stops every thread and clears the held-key cache, so a key set here is discarded. Pass `input` to gandi_run instead, which presses it while the project is actually stepping. Mouse coordinates are Scratch stage coordinates.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name: "space", "ArrowRight", "enter", or a single character such as "a".' },
        isDown: { type: 'boolean', description: 'Whether the key is now held (default true).' },
        x: { type: 'number', description: 'Stage x for the mouse, −240 to 240.' },
        y: { type: 'number', description: 'Stage y for the mouse, −180 to 180.' },
        click: { type: 'boolean', description: 'Click at the given position instead of just moving there.' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const hasKey = typeof args.key === 'string' && args.key.length > 0
      const hasPosition = Number.isFinite(args.x) || Number.isFinite(args.y)
      if (!hasKey && !hasPosition) throw new Error('pass a key, or mouse x/y (with optional click)')
      // Validate the spelling before touching the editor: an unknowable key name
      // would otherwise be dropped silently by the runtime.
      if (hasKey && !isPostableKey(args.key)) {
        throw new Error(`"${args.key}" is not a key this can press; try ${knownKeyNames().slice(0, 12).join(', ')}, or a single character`)
      }

      return service.use(writeAccess(args, sessionId), async (connection) => {
        const notes = []
        if (hasKey) {
          const isDown = args.isDown !== false
          const posted = await postKey(connection, { key: args.key, isDown })
          notes.push(`key "${args.key}" (posted as ${JSON.stringify(posted.posted)}) ${isDown ? 'down' : 'up'}`)
        }
        if (hasPosition || args.click === true) {
          await postMouse(connection, {
            x: Number.isFinite(args.x) ? Number(args.x) : 0,
            y: Number.isFinite(args.y) ? Number(args.y) : 0,
            isDown: args.click === true,
            click: args.click === true
          })
          notes.push(args.click === true
            ? `clicked stage (${args.x ?? 0}, ${args.y ?? 0})`
            : `moved mouse to stage (${args.x ?? 0}, ${args.y ?? 0})`)
        }
        return { text: `posted: ${notes.join('; ')}` }
      })
    }
  })

  registerTool({
    name: 'gandi_stop',
    mutating: true,
    description: 'Stop every running script (the red stop sign), without changing the project.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run (args, exec, sessionId) {
      return service.use(writeAccess(args, sessionId), async (connection) => {
        await stopAll(connection)
        const state = await observe(connection, { includeClones: false })
        return { text: `stopped all scripts; ${state.threads} thread(s) left` }
      })
    }
  })

  registerTool({
    name: 'gandi_save',
    concurrencySafe: true,
    description: 'Export the open project to a .sb3 file on disk.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Destination .sb3 path, relative to the session workspace or absolute.' } },
      required: ['path'],
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const absolute = resolveProjectPath(requireString(args.path, 'path'), exec)
      return service.use({ sessionId, mutating: false }, async (connection) => {
        const bytes = await exportSb3(connection)
        await writeFile(absolute, bytes)
        return { text: `saved ${bytes.length} bytes to ${absolute}` }
      })
    }
  })

  // ── read ──────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_inspect',
    concurrencySafe: true,
    description: [
      'Read a project: every sprite with its scripts, costumes and variables, plus one sprite\'s scripts as scratch-blocks XML.',
      'Reads the open project in Gandi, or — when `path` is given — a .sb3 on disk, which needs no editor at all.',
      'Read before writing: gandi_apply accepts exactly this XML dialect.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A .sb3 (or project.json) on disk to read instead of the open project.' },
        target: { type: 'string', description: 'Sprite name or id, or "stage". Defaults to the first sprite / the editing target.' },
        includeXml: { type: 'boolean', description: 'Include the scripts as XML (default true).' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const includeXml = args.includeXml !== false
      const wanted = typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined

      // Offline: a file on disk, with no editor involved.
      if (typeof args.path === 'string' && args.path.length > 0) {
        const absolute = resolveProjectPath(args.path, exec)
        const { project, assets, warnings } = await readProjectFile(absolute)
        const lines = [`project: ${absolute}`, summarizeProject(project, { assetCount: assets.size })]
        if (warnings.length > 0) {
          lines.push(`warnings:\n${warnings.map((warning) => `  ${warning}`).join('\n')}`)
        }
        if (includeXml) {
          const rendered = targetXmlFromProject(project, wanted)
          lines.push('', `scripts of ${rendered.target} (scratch-blocks XML):`, rendered.xml)
        }
        return { text: clamp(lines.join('\n')) }
      }

      return service.use({ sessionId, mutating: false }, async (connection) => {
        const state = await observe(connection, { includeClones: false })
        const lines = ['targets:']
        for (const target of state.targets) {
          lines.push(`  ${target.name}${target.isStage ? ' (stage)' : ''} — ${target.scripts} script(s), ${target.blocks} block(s), costumes: ${target.costumes.join(', ') || 'none'}`)
          if (target.variables.length > 0) {
            lines.push(`    variables: ${target.variables.map((v) => `${v.name}=${JSON.stringify(v.value)}`).join(', ')}`)
          }
        }
        lines.push(`editing target: ${state.editingTarget?.name ?? '(none)'}`)
        // Which extensions this editor has loaded decides which block types can be
        // written at all, so it belongs in the read view rather than only in an error.
        try {
          const facts = await extensionFacts(connection)
          lines.push(`extensions loaded: ${(facts.loadedIds ?? []).join(', ') || 'none'} (of ${(facts.catalogueIds ?? []).length} this editor offers — see gandi_extension)`)
        } catch {
          // No extension manager in this page: not worth failing a read over.
        }
        if (includeXml) {
          const wantedLive = wanted ?? state.editingTarget?.name
          if (wantedLive !== undefined) {
            try {
              const xml = await getTargetXml(connection, { target: wantedLive })
              lines.push('', `scripts of ${xml.target} (scratch-blocks XML):`, xml.xml)
            } catch (error) {
              lines.push('', `could not read the scripts of ${wantedLive}: ${error.message}`)
            }
          }
        }
        return { text: clamp(lines.join('\n')) }
      })
    }
  })

  registerTool({
    name: 'gandi_observe',
    concurrencySafe: true,
    description: 'Read runtime state: sprite positions, directions and costumes, variable values, the project timer, and how many threads are running.',
    parameters: {
      type: 'object',
      properties: { includeClones: { type: 'boolean', description: 'Include clone sprites (default false).' } },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      return service.use({ sessionId, mutating: false }, async (connection) => {
        const state = await observe(connection, { includeClones: args.includeClones === true })
        const lines = [`threads: ${state.threads}`]
        if (typeof state.projectTimer === 'number') lines.push(`project timer: ${state.projectTimer.toFixed(2)}s`)
        for (const target of state.targets) {
          // Values are rendered the way Scratch shows them: a number reads as a number,
          // a string is quoted. Quoting everything (JSON.stringify) made `n=7` print as
          // `n="7"` and turned a check on a variable's value into a check on its type.
          const vars = target.variables.length > 0
            ? ` vars: ${target.variables.map((v) => `${v.name}=${formatValue(v.value)}`).join(', ')}`
            : ''
          lines.push(`  ${target.name}${target.isStage ? ' (stage)' : ''}${target.isClone ? ' (clone)' : ''}: x=${target.x} y=${target.y} dir=${target.direction} size=${target.size}% visible=${target.visible} costume=${target.costume ?? 'none'}${vars}`)
        }
        // Only shown when the project actually displays a monitor. The fields named here
        // are the ones both editors' records agree on; anything else is left out rather
        // than dumped as raw JSON, which is unreadable in a tool result.
        if (state.monitors.length > 0) {
          lines.push(`visible monitors (${state.monitors.length}):`)
          for (const monitor of state.monitors) {
            const name = monitor.id ?? monitor.opcode ?? '(unnamed)'
            const value = monitor.value === undefined || monitor.value === null ? '(no value)' : formatValue(monitor.value)
            const hidden = monitor.visible === false ? ' (hidden)' : ''
            lines.push(`  ${name} = ${value}${hidden}`)
          }
        }
        return { text: clamp(lines.join('\n')) }
      })
    }
  })

  registerTool({
    name: 'gandi_screenshot',
    concurrencySafe: true,
    schema: IMAGE_OUTPUT,
    description: 'Capture the stage as an image, so you can see what the project looks like right now.',
    parameters: {
      type: 'object',
      properties: { savePath: { type: 'string', description: 'Optional path to also write the PNG to.' } },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const shot = await service.use({ sessionId, mutating: false }, (connection) => screenshot(connection))
      if (typeof args.savePath === 'string' && args.savePath.length > 0) {
        const absolute = resolveProjectPath(args.savePath, exec)
        const bytes = Buffer.from(shot.dataUri.replace(/^data:image\/png;base64,/, ''), 'base64')
        await writeFile(absolute, bytes)
        const prefix = `stage image ${shot.width}x${shot.height} written to ${absolute}`
        if (attachments === null) return { text: prefix }
        return { text: prefix, image: await saveImage(bytes) }
      }
      return withStageImage(shot, 'current stage:', exec)
    }
  })

  // ── write ─────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_apply',
    mutating: true,
    description: [
      'Add or replace one sprite\'s scripts from scratch-blocks XML.',
      'The dialect is exactly what gandi_inspect prints, so read-modify-write round-trips.',
      'The project is edited in place: everything else, including editor state, is preserved.',
      'mode "replace" (default) swaps every script of the sprite; "replaceScript" swaps exactly one of them (1-based',
      'position in the script list, or its block id); "append" adds alongside what is there.',
      'XML that would produce a project the editor cannot open is REFUSED, not written: a dropdown shadow that is not',
      'the one the block expects, an unknown shadow type, a custom-block call whose arguments cannot be resolved.',
      'Extension blocks (music_*, pen_*, …) work too, but only once that extension is LOADED in the editor — the block',
      'type, its inputs and its dropdown shadow exist only there. Load one with gandi_extension {action:"load"} first;',
      'if it is missing, this says so instead of writing a block that would not resolve. With `path` (no editor)',
      'extension blocks are written as named and the extension is recorded in the document.',
      'Pass dryRun to compile and check without touching anything — with `path` it also checks the result after applying.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        xml: { type: 'string', description: 'scratch-blocks XML: an <xml> wrapper, or a bare <block>.' },
        target: { type: 'string', description: 'Sprite name or id. Defaults to the editing target (or the first sprite, offline).' },
        mode: { type: 'string', enum: ['replace', 'append', 'replaceScript'], description: 'replace (default) removes that sprite\'s existing scripts first; replaceScript removes just one.' },
        script: { type: 'string', description: 'With mode replaceScript: which script to swap — its 1-based position, or its top-level block id.' },
        path: { type: 'string', description: 'Edit this .sb3 on disk instead of the open editor. No Gandi needed.' },
        outPath: { type: 'string', description: 'With path: write the result here instead of editing the file in place.' },
        scope: { type: 'string', enum: ['global', 'local'], description: 'With path: where new variables go (default global, on the stage).' },
        dryRun: { type: 'boolean', description: 'Compile and validate only; do not touch anything.' }
      },
      required: ['xml'],
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const xml = requireString(args.xml, 'xml')
      const mode = args.mode === 'append' || args.mode === 'replaceScript' ? args.mode : 'replace'
      const target = typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined
      if (mode === 'replaceScript' && args.script === undefined) {
        throw new Error('mode "replaceScript" needs `script`: the 1-based position of the script in that sprite, or its top-level block id. ' +
          'gandi_inspect prints the scripts of a sprite in that order.')
      }

      // A call to a custom block that already exists in the target can only be compiled
      // if the target's own definitions are known: the argument ids live there and
      // nowhere else. Reading them costs one cheap call, and only when the XML contains
      // a call at all — otherwise the compiler is handed nothing and behaves as before.
      const needsProcedures = mode !== 'replace' && xml.includes('procedures_call')
      const offline = typeof args.path === 'string' && args.path.length > 0
        ? await (async () => {
            const absolute = resolveProjectPath(args.path, exec)
            const read = await readProjectFile(absolute)
            return { absolute, ...read }
          })()
        : null

      let procedures
      if (needsProcedures) {
        if (offline !== null) {
          try {
            procedures = proceduresFromBlocks(findProjectTarget(offline.project, target).blocks)
          } catch {
            // A target that does not exist yet is the offline layer's error to raise,
            // with a message that lists what the project does have.
            procedures = undefined
          }
        } else {
          const declarations = await service.use({ sessionId, mutating: false }, (connection) =>
            getProcedureDeclarations(connection, { target }))
          procedures = proceduresFromBlocks(declarations.blocks)
        }
      }

      // Extension blocks need the extension LOADED before they can be compiled honestly:
      // the opcode, the input names and the dropdown shadow of a `music_*` block exist
      // only in the running editor's `_blockInfo`. So when the XML mentions a block that
      // is not a core opcode, ask the editor what it has — and refuse with a way forward
      // when the extension it needs is not available. With no editor at all (the offline
      // half of this tool) the blocks are written as named, which is exactly right for a
      // file: the editor loads them from the opcode prefix when it opens the project.
      const mentionsExtensions = mentionsNonCoreBlock(xml)
      let extensionDialect = []
      let extensionProbe = null
      if (mentionsExtensions && offline === null) {
        extensionProbe = await probeExtensions(sessionId)
        if (extensionProbe !== null && extensionProbe.available === true) {
          extensionDialect = extensionProbe.loaded ?? []
        }
      }

      let fragment
      try {
        fragment = compileScripts(xml, {
          ...(procedures === undefined ? {} : { procedures }),
          ...(extensionDialect.length === 0 ? {} : { dialect: extensionDialect })
        })
      } catch (error) {
        // A refused compile is where "you wrote an extension block" and "you misspelled
        // an opcode" look identical. If the editor answered, the difference can be named.
        if (extensionProbe !== null) {
          const needed = (xml.match(/type="([^"]+)"/g) ?? [])
            .map((match) => match.slice(6, -1).split('_')[0])
            .filter((prefix) => !CORE_OPCODES.has(prefix))
          const loadedIds = new Set((extensionProbe.loadedIds ?? []))
          const missing = [...new Set(needed.filter((id) => !loadedIds.has(id)))]
          if (missing.length > 0) {
            throw new Error(`${error.message}\n\n${extensionHint(missing, extensionProbe)}`)
          }
        }
        throw error
      }
      const neededExtensions = extensionsOfFragment(fragment)
      const warnings = fragment.warnings.length === 0 ? '  (none)' : fragment.warnings.map((w) => `  ${w}`).join('\n')
      // The offline path never needs the engine-form conversion, because a project
      // document already stores blocks in the wire form the compiler emits.
      if (args.dryRun === true) {
        const engine = fragmentToEngine(fragment)
        const notes = [
          `dry run: ${Object.keys(fragment.blocks).length} block(s) compiled into ${engine.blocks.length} engine block(s), ` +
          `${fragment.variables.length} variable declaration(s).`,
          `checks passed: every shadow is a primitive or the dropdown its input takes; every mutation carries the fields the editor reads` +
          (procedures === undefined ? '' : `; ${procedures.length} custom block(s) of the target were available to resolve calls`) +
          (neededExtensions.length === 0
            ? ''
            : (extensionDialect.length > 0
                ? `; ${neededExtensions.join(', ')} is loaded here, so its blocks were checked against the editor's own definitions`
                : `; NOT checked for ${neededExtensions.join(', ')}: ${offline === null ? 'not loaded in this editor' : 'no editor, so a file is written as named'}`)),
          `warnings:\n${warnings}`
        ]
        if (neededExtensions.length > 0) {
          notes.push(`extensions this script needs: ${neededExtensions.join(', ')}` +
            (offline === null ? '' : ' (the document will declare them when applied)'))
        }
        // With a file in hand the result can be checked the way the editor will read it:
        // apply the fragment to a COPY and run the load check over the copy.
        if (offline !== null) {
          const copy = structuredClone(offline.project)
          const applied = applyFragmentToProject(copy, {
            target,
            fragment,
            mode,
            script: args.script === undefined ? undefined : (typeof args.script === 'number' ? args.script : String(args.script)),
            scope: args.scope === 'local' ? 'local' : 'global',
            extensions: neededExtensions
          })
          const report = verifyProject(copy, { assets: offline.assets, knownExtensions: extensionDialect.map((extension) => extension.id) })
          notes.push('', formatReport(report, { heading: `load check of ${applied.target} after applying (nothing was written)` }))
        } else {
          notes.push('')
          notes.push('(pass `path` as well to have dryRun check the whole project the way the editor will read it)')
        }
        return { text: clamp(notes.join('\n')) }
      }
      if (fragment.warnings.length > 0) {
        throw new Error(`refusing to apply XML with problems:\n${warnings}\nFix them, or call again with dryRun: true to inspect first.`)
      }

      // Offline: splice into the project document and write the archive back.
      if (offline !== null) {
        const { absolute, project, assets, warnings: containerWarnings } = offline
        const destination = typeof args.outPath === 'string' && args.outPath.length > 0
          ? resolveProjectPath(args.outPath, exec)
          : absolute
        const result = applyFragmentToProject(project, {
          target,
          fragment,
          mode,
          script: args.script === undefined ? undefined : (typeof args.script === 'number' ? args.script : String(args.script)),
          scope: args.scope === 'local' ? 'local' : 'global',
          // A file cannot load an extension, so the only honest thing to do with an
          // extension block is write it as named AND declare the extension in the
          // document, which is what every other Scratch tool reads.
          extensions: neededExtensions
        })
        // The destination extension decides the format: writing an archive into a
        // file called project.json would produce a ZIP a reader cannot parse.
        const asJson = destination.toLowerCase().endsWith('.json')
        const bytes = asJson
          ? Buffer.from(`${JSON.stringify(project, null, 2)}\n`, 'utf8')
          : writeSb3(project, assets)
        await writeFile(destination, bytes)
        // The written file is checked before it is announced as done. A splice can only
        // break things the fragment itself brought (dangling references, missing
        // assets), and saying so now is cheaper than finding out at load time.
        const report = verifyProject(project, { assets, knownExtensions: neededExtensions })
        return {
          text: [
            `edited ${absolute}${destination === absolute ? ' in place' : ` -> ${destination}`} (${asJson ? 'project.json' : 'sb3 archive'})`,
            `applied ${result.createdBlocks} block(s) to ${result.target} (${result.removedBlocks} block(s) removed, mode ${mode})`,
            `now ${result.blocksAfter} block(s) in that target`,
            result.declaredVariables.length > 0 ? `declared variables: ${result.declaredVariables.join(', ')}` : 'no new variables',
            `comments: +${result.createdComments} / -${result.removedComments}`,
            ...(result.extensionsAdded.length > 0
              ? [`declared extension(s): ${result.extensionsAdded.join(', ')} — the editor loads them from the block opcodes when it opens this project`]
              : []),
            `wrote ${bytes.length} bytes`,
            ...(containerWarnings.length > 0 ? [`container notes:\n${containerWarnings.map((w) => `  ${w}`).join('\n')}`] : []),
            ...(report.errors.length > 0 || report.warnings.length > 0
              ? ['', formatReport(report, { heading: 'load check after applying' })]
              : [`load check: clean (${report.stats.blocks} block(s), no dangling references)`])
          ].join('\n')
        }
      }

      const engine = fragmentToEngine(fragment)
      return service.use(writeAccess(args, sessionId), async (connection) => {
        const applied = await applyFragment(connection, {
          target,
          blocks: engine.blocks,
          variables: fragment.variables,
          comments: engine.comments,
          mode,
          script: args.script === undefined ? undefined : (typeof args.script === 'number' ? args.script : String(args.script))
        })
        return {
          text: [
            `applied ${applied.createdBlocks} block(s) to ${applied.target.name} (${applied.removedScripts} old script(s) removed, mode ${applied.mode})`,
            `now ${applied.blocksAfter} block(s) in ${applied.topLevelScripts} script(s)`,
            applied.createdVariables.length > 0 ? `created variables: ${applied.createdVariables.join(', ')}` : 'no new variables',
            applied.createdComments > 0 || applied.removedComments > 0
              ? `comments: +${applied.createdComments} / -${applied.removedComments}`
              : 'no comments changed',
            ...(neededExtensions.length > 0
              ? [`extension blocks written: ${neededExtensions.join(', ')} (that extension is loaded in this editor)`]
              : [])
          ].join('\n')
        }
      })
    }
  })

  // ── merge ─────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_merge',
    mutating: true,
    description: [
      'Merge another project\'s sprites into this one — the multi-agent finishing move.',
      'Take `from` (a .sb3 another writer produced), and merge the named sprites into the open editor or into a file',
      'given by `path`. Each merge moves the whole sprite: its scripts, its own variables and lists, and its costumes',
      'and sounds WITH the asset bytes. That is the point — replacing scripts without the variables leaves every local',
      'reference dangling (a delivery did exactly that with a hand-written script and got 374 of them), and it still',
      'opened, so nothing looked wrong.',
      'New globals from the source are UNIONED into the stage by id; a same-id-different-name collision is reported',
      'rather than silently resolved. Sprites the destination does not have are added whole.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'The .sb3 to take sprites from.' },
        path: { type: 'string', description: 'Merge into this .sb3 on disk instead of the open editor.' },
        outPath: { type: 'string', description: 'With path: write the result here instead of editing the file in place.' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Sprite names to take (default: every sprite in the source).' },
        mode: { type: 'string', enum: ['replace', 'scripts'], description: 'replace (default) takes scripts, variables, lists, costumes and sounds; scripts takes only the scripts and comments.' },
        dryRun: { type: 'boolean', description: 'Report what would be merged without writing anything.' }
      },
      required: ['from'],
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const fromPath = resolveProjectPath(requireString(args.from, 'from'), exec)
      const source = await readProjectFile(fromPath)
      const mode = args.mode === 'scripts' ? 'scripts' : 'replace'
      const targets = Array.isArray(args.targets) ? args.targets.filter((name) => typeof name === 'string' && name.length > 0) : undefined

      /**
       * Merge into one destination document.
       * @param {any} project destination project (mutated)
       * @param {Map<string, any>} assets destination archive contents (mutated)
       * @returns {string} the report
       */
      const runMerge = (project, assets) => {
        const result = mergeProjects(project, source.project, {
          targets,
          mode,
          assets,
          sourceAssets: source.assets
        })
        const report = verifyProject(project, { assets })
        const text = [formatMerge(result, fromPath)]
        if (report.errors.length > 0 || report.warnings.length > 0) {
          text.push('', formatReport(report, { heading: 'load check after merging' }))
        } else {
          text.push(`load check: clean (${report.stats.sprites} sprite(s), ${report.stats.blocks} block(s), ${report.stats.assets} asset(s))`)
        }
        return text.join('\n')
      }

      // Offline: read the destination file, merge, write it back.
      if (typeof args.path === 'string' && args.path.length > 0) {
        const absolute = resolveProjectPath(args.path, exec)
        const destination = typeof args.outPath === 'string' && args.outPath.length > 0
          ? resolveProjectPath(args.outPath, exec)
          : absolute
        const to = await readProjectFile(absolute)
        if (args.dryRun === true) {
          const copy = structuredClone(to.project)
          const text = runMerge(copy, to.assets)
          return { text: `dry run — nothing was written.\n${text}` }
        }
        const text = runMerge(to.project, to.assets)
        const asJson = destination.toLowerCase().endsWith('.json')
        const bytes = asJson
          ? Buffer.from(`${JSON.stringify(to.project, null, 2)}\n`, 'utf8')
          : writeSb3(to.project, to.assets)
        await writeFile(destination, bytes)
        return { text: `${text}\nwrote ${bytes.length} bytes to ${destination}${asJson ? ' (project.json)' : ''}` }
      }

      // Live: export the open project (assets included), merge, and load it back. Going
      // through archive bytes is the only way assets survive — see gandi_new.
      return service.use(writeAccess(args, sessionId), async (connection) => {
        const current = readSb3(await exportSb3(connection))
        if (args.dryRun === true) {
          const copy = structuredClone(current.project)
          return { text: `dry run — the open project was not touched.\n${runMerge(copy, current.assets)}` }
        }
        const text = runMerge(current.project, current.assets)
        const bytes = writeSb3(current.project, current.assets)
        const summary = await loadProjectBytes(connection, bytes)
        return {
          text: `${text}\nreloaded the editor: ${summary.targets.length} target(s), ${bytes.length} bytes`
        }
      })
    }
  })

  // ── run ───────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_run',
    mutating: true,
    schema: IMAGE_OUTPUT,
    description: [
      'Press the green flag, advance the project by N seconds, then report what happened.',
      'The run is paced by the bridge with the editor\'s own stepping loop paused, so the project advances at exactly',
      '1000/currentStepTime frames per second (30 for a stock Scratch runtime) no matter what the window is doing —',
      'the same run twice gives the same result. The green flag stops every thread and resets the project timer, but it',
      'does NOT reset variables: report entries that changed during the run are printed so a value leaking across runs is visible.',
      'Returns the resulting runtime state and, by default, a stage image so you can see the outcome.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to run, in seconds (default 1, capped at 60).' },
        stopAfter: { type: 'boolean', description: 'Stop all scripts afterwards (default true).' },
        screenshot: { type: 'boolean', description: 'Include a stage image (defaults to the plugin config, normally true).' },
        includeClones: { type: 'boolean', description: 'Include clones in the reported state (default false).' },
        resetVariables: {
          type: 'boolean',
          description: [
            'Before the flag, set every variable to 0 and empty every list (default false).',
            'This is what a Scratch author does by hand in an init script, not a restore of the values the project was saved with —',
            'those are overwritten by the first script that writes to them. Broadcast messages are left alone.'
          ].join(' ')
        },
        input: {
          type: 'array',
          description: [
            'Input to feed WHILE the project runs, which is how to test anything interactive.',
            'Each entry: {atSeconds, key, isDown} to press or release a key, or {atSeconds, x, y, click} for the mouse.',
            'This must happen during the run, not before it: pressing the green flag stops every thread and clears the key cache, so a key posted beforehand is discarded.'
          ].join(' '),
          items: {
            type: 'object',
            properties: {
              atSeconds: { type: 'number', description: 'When to apply this, in seconds from the start (default 0).' },
              key: { type: 'string', description: 'Key name, e.g. "space" or "ArrowRight".' },
              isDown: { type: 'boolean', description: 'Whether the key is held after this entry (default true).' },
              x: { type: 'number', description: 'Stage x for the mouse, −240 to 240.' },
              y: { type: 'number', description: 'Stage y for the mouse, −180 to 180.' },
              click: { type: 'boolean', description: 'Click at x/y instead of just moving there.' }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const seconds = Number.isFinite(args.seconds) ? Math.max(0, Math.min(60, Number(args.seconds))) : 1
      const stopAfter = args.stopAfter !== false
      const wantShot = args.screenshot === undefined ? config.screenshotOnRun : args.screenshot === true

      // Turn the declared input into page-side statements, validated up front: an
      // unknowable key name is dropped silently by the runtime, so a typo would look
      // like "the game ignores the key" rather than like a bad argument.
      const requested = Array.isArray(args.input) ? args.input : []
      const keyEvents = []
      const mouseEvents = []
      for (const entry of requested) {
        if (entry === null || typeof entry !== 'object') throw new Error('each input entry must be an object')
        const atSeconds = Number.isFinite(entry.atSeconds) ? Math.max(0, Number(entry.atSeconds)) : 0
        const atFrame = Math.round((atSeconds * 1000) / (1000 / 30))
        const hasKey = typeof entry.key === 'string' && entry.key.length > 0
        const hasPosition = Number.isFinite(entry.x) || Number.isFinite(entry.y)
        if (!hasKey && !hasPosition) throw new Error('each input entry needs a key, or mouse x/y')
        if (hasKey) {
          const domKey = toDomKey(entry.key)
          if (domKey.length === 0) {
            throw new Error(`"${entry.key}" is not a key this can press; try ${knownKeyNames().slice(0, 12).join(', ')}, or a single character`)
          }
          keyEvents.push({
            atFrame,
            source: `vm.postIOData('keyboard', { key: ${JSON.stringify(domKey)}, isDown: ${JSON.stringify(entry.isDown !== false)} })`
          })
        }
        if (hasPosition || entry.click === true) {
          const x = Number.isFinite(entry.x) ? Number(entry.x) : 0
          const y = Number.isFinite(entry.y) ? Number(entry.y) : 0
          const click = entry.click === true
          mouseEvents.push({ atFrame, x, y, click, atSeconds })
        }
      }

      return service.use(writeAccess(args, sessionId), async (connection) => {
        // Position the mouse before the flag: it has no edge semantics, so unlike the
        // keyboard it survives greenFlag (postMouse does not touch the key cache).
        for (const event of mouseEvents) await postMouse(connection, { x: event.x, y: event.y, isDown: event.click, click: event.click })
        if (args.resetVariables === true) await resetVariables(connection)

        // State before the run, so the report can name what the run CHANGED. This is
        // the difference between "the counter says 178" and "the counter went 0 -> 178",
        // and a value that starts non-zero is the signature of state leaking across runs.
        const before = await observe(connection, { includeClones: false })
        const beforeValues = new Map()
        for (const target of before.targets) {
          for (const variable of target.variables) beforeValues.set(`${target.name}.${variable.name}`, variable.value)
        }

        const run = await runSteps(connection, { seconds, stopAfter, events: keyEvents })
        const state = await observe(connection, { includeClones: args.includeClones === true })
        const lines = [
          `ran ${run.steps} frames (~${seconds}s at ${Math.round(1000 / run.stepMs)} fps): ${run.startedThreads} thread(s) started, ` +
          `${run.threadsLeft} still running${run.stopped === true ? ', stopped afterwards' : ''}`
        ]
        if (args.resetVariables === true) lines.push('variables were reset to 0 / empty before the flag')
        if (run.eventsFired > 0) lines.push(`input applied during the run: ${run.eventsFired} key event(s)`)

        // Page errors during the run. This runtime reports its worst failures as a
        // rejected promise carrying a bare string (a stale glow id, most famously), so
        // without this the symptom is "nothing happened" and the cause is invisible.
        if (Array.isArray(run.errors) && run.errors.length > 0) {
          lines.push(`page errors during the run (${run.errors.length}):`)
          for (const error of run.errors.slice(0, 5)) lines.push(`  - ${error}`)
        }

        for (const target of state.targets) {
          const changed = target.variables
            .map((v) => ({ ...v, was: beforeValues.get(`${target.name}.${v.name}`) }))
            .filter((v) => beforeValues.has(`${target.name}.${v.name}`) && !sameValue(v.was, v.value))
          const vars = target.variables.length > 0
            ? ` vars: ${target.variables.map((v) => `${v.name}=${formatValue(v.value)}`).join(', ')}`
            : ''
          lines.push(`  ${target.name}${target.isStage ? ' (stage)' : ''}: x=${target.x} y=${target.y} dir=${target.direction} costume=${target.costume ?? 'none'}${vars}`)
          if (changed.length > 0) {
            lines.push(`    changed during the run: ${changed.map((v) => `${v.name} ${formatValue(v.was)} -> ${formatValue(v.value)}`).join(', ')}`)
          }
        }

        const text = clamp(lines.join('\n'))
        const summary = lines[0]
        if (!wantShot) {
          service.noteRun(summary)
          return { text }
        }
        const shot = await screenshot(connection)
        const bytes = Buffer.from(shot.dataUri.replace(/^data:image\/png;base64,/, ''), 'base64')
        const hash = createHash('sha256').update(bytes).digest('hex')
        // The image is compared with the previous one from THIS process. A stage image
        // that is byte-identical across two runs with different states is the symptom a
        // delivery spent hours on — it looks like "the stage never rendered", and the
        // honest thing to do is to say so in the output rather than let the reader
        // discover it. The comparison is per hash, so it costs nothing to carry.
        const repeated = hash === lastStageHash
        lastStageHash = hash
        service.noteRun(`${summary}${repeated ? ' [image identical to the previous capture]' : ''}`)
        const notice = repeated
          ? '\nNOTE: this stage image is byte-identical to the previous one. If the state above changed, do not trust the picture — ' +
            'call gandi_screenshot {savePath} and read the PNG instead.'
          : ''
        return withStageImage(shot, `${text}${notice}`, exec)
      })
    }
  })

  // ── optional integrations ─────────────────────────────────────────────────

  if (config.registerSkill && skills !== null && typeof skills.register === 'function') {
    // `apply` stays synchronous: reading the bundled skill is best-effort, and a
    // missing file must not delay or fail plugin activation.
    void (async () => {
      try {
        const skillPath = fileURLToPath(new URL('../skills/gandi-scratch-authoring/SKILL.md', import.meta.url))
        const content = await readFileSyncSafe(skillPath)
        if (content === null) return
        skills.register({
          name: 'gandi-scratch-authoring',
          description: 'How to write Scratch 3 scripts as scratch-blocks XML and drive a live Gandi editor.',
          content,
          path: skillPath,
          provider: name,
          source: 'bundled'
        })
      } catch (error) {
        if (config.debug) process.stderr.write(`[${name}] could not register the skill: ${error?.message ?? error}\n`)
      }
    })()
  }

  if (config.enableSystemPrompt) {
    const systemPrompt = optional('systemPrompt')
    if (systemPrompt !== null && typeof systemPrompt.section === 'function') {
      try {
        systemPrompt.section({
          name: 'tool:gandi',
          order: typeof systemPrompt.getSectionOrder === 'function'
            ? systemPrompt.getSectionOrder('TOOL_WEB_SEARCH')
            : 2000,
          text: () => 'Gandi Scratch tools are available (gandi_*). Read the gandi-scratch-authoring skill before writing scripts.'
        })
      } catch (error) {
        if (config.debug) process.stderr.write(`[${name}] could not add a prompt section: ${error?.message ?? error}\n`)
      }
    }
  }

  ctx.effect(() => () => {
    service.dispose()
  })
}

/**
 * Read a file, tolerating absence: a missing bundled skill must not break
 * activation.
 * @param {string} path file to read
 * @returns {Promise<string|null>} the contents, or null
 */
const readFileSyncSafe = async (path) => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}
