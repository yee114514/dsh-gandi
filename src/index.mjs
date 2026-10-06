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
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_BACKDROP_SVG, DEFAULT_SPRITE_SVG, blankProject, readSb3, starterProject, writeSb3 } from './scratch/sb3.mjs'
import { applyFragmentToProject, summarizeProject, targetXmlFromProject } from './scratch/project.mjs'
import { SAMPLE_RATE, encodeWav, synthesizeTone } from './scratch/wav.mjs'
import { compileScripts, randomBlockId } from './scratch/xml.mjs'
import { fragmentToEngine } from './scratch/engine.mjs'
import { assertLooksLikeSvg, defaultRotationCenter } from './scratch/svg.mjs'
import { isPostableKey, knownKeyNames, toDomKey } from './scratch/keys.mjs'
import {
  addCostume,
  addSound,
  applyFragment,
  duplicateSprite,
  editSprite,
  editVariable,
  exportSb3,
  getTargetXml,
  keepOnlyCostume,
  loadProjectBytes,
  loadProjectJson,
  observe,
  postKey,
  postMouse,
  runSteps,
  screenshot,
  selectTarget,
  setTargetState,
  stopAll,
  stripSprite,
  waitForVm
} from './bridge/ops.mjs'
import { DEFAULT_PORT, attach, launchAndAttach, probeTargets, rememberAppPath, resolveAppPath } from './bridge/app.mjs'
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
    leaseIdleMs: Number.isInteger(config.leaseIdleMs) && config.leaseIdleMs > 0 ? config.leaseIdleMs : 300000,
    launchTimeoutMs: Number.isInteger(config.launchTimeoutMs) && config.launchTimeoutMs > 0 ? config.launchTimeoutMs : 45000,
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
   * Register one tool. `mutating` tools take the project lease and are serialised
   * against every other tool in this process.
   * @param {{name: string, description: string, parameters: any, schema?: any, mutating?: boolean, concurrencySafe?: boolean, run: (args: any, exec: any, sessionId: string) => Promise<any>}} definition tool definition
   */
  const registerTool = (definition) => {
    const mutating = definition.mutating === true
    const access = (sessionId) => ({ sessionId, mutating })
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
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
          return await definition.run(args ?? {}, exec, sessionId)
        } catch (error) {
          rethrowReadable(error)
        }
      }
    })
    void access
  }

  // ── status ────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_status',
    concurrencySafe: true,
    description: 'Report whether the Gandi bridge is reachable, what project is open, and who holds the edit lease. Cheap; call it first when another scratch_* tool fails.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async run (_args, exec, sessionId) {
      const status = await service.status()
      const lines = [
        `port ${status.port}: ${status.portOpen ? 'open' : 'closed'}`,
        `editor tab: ${status.editorOpen ? 'open' : 'none'}`,
        `connection: ${status.connected ? 'attached' : 'not attached'}`,
        `Gandi process: ${status.processRunning ? 'running' : 'not running'}`,
        `app path: ${status.appPath ?? '(not found — set appPath or GANDI_APP_PATH)'}`,
        `auto-launch: ${status.autoLaunch ? 'on' : 'off'}`,
        `workspace: ${cwdOf(exec)}`,
        `lease: ${status.lease === null ? 'free' : `held by session ${status.lease.sessionId} (idle ${Math.round(status.lease.idleMs / 1000)}s)`}`,
        `this session: ${sessionId}`
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
          lines.push('NOTE: Gandi is running without a debug port. Close it, then call gandi_launch so the plugin can attach to the editor it opens.')
        } else {
          lines.push('NOTE: call gandi_launch to start Gandi and open an editor tab, or gandi_open to work with a .sb3 file without the editor.')
        }
        return { text: lines.join('\n') }
      }
      const state = await service.use({ sessionId, mutating: false }, (connection) => observe(connection, { includeClones: false }))
      lines.push(`editing target: ${state.editingTarget?.name ?? '(none)'}`)
      for (const target of state.targets) {
        lines.push(`  ${target.name}${target.isStage ? ' (stage)' : ''}: ${target.scripts} script(s), ${target.blocks} block(s), costumes: ${target.costumes.join(', ') || 'none'}`)
      }
      return { text: lines.join('\n') }
    }
  })

  // ── launch ────────────────────────────────────────────────────────────────

  registerTool({
    name: 'gandi_launch',
    mutating: true,
    schema: LAUNCH_OUTPUT,
    description: 'Start Gandi Desktop with a debug port, open an editor tab and attach to it. If Gandi is already running without a debug port it must be restarted through this tool.',
    parameters: {
      type: 'object',
      properties: {
        appPath: { type: 'string', description: 'Absolute path to Gandi.exe; defaults to the configured path or a discovered install.' },
        timeoutMs: { type: 'number', description: 'How long to wait for the editor to load (default 45000).' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const requested = typeof args.appPath === 'string' && args.appPath.length > 0 ? args.appPath : config.appPath
      const appPath = resolveAppPath(requested)
      const timeoutMs = Number.isFinite(args.timeoutMs) ? Number(args.timeoutMs) : config.launchTimeoutMs

      // Already listening? Attach instead of starting a second copy. Unlike TurboWarp
      // there is no single-instance lock to fight, but spawning a second Gandi would
      // still leave the user with two windows, and the one already open is the one
      // they can see. If it has no editor tab, `attach` asks its shell for one.
      const listening = await probeTargets(config.port, { timeoutMs: 1500 })
      if (listening.length > 0) {
        service.dispose()
        const attached = await attach({ port: config.port, timeoutMs, openTab: true, readyTimeoutMs: timeoutMs })
        const ready = await waitForVm(attached.connection, { timeoutMs })
        if (appPath !== null) rememberAppPath(appPath)
        return {
          text: `Gandi was already listening on port ${config.port}; attached to the running editor` +
            `${attached.opened ? ' (opened a new editor tab)' : ''} (${ready ? 'ready' : 'did not finish loading a project'}).`,
          appPath: appPath ?? '(already running)',
          ready
        }
      }

      if (appPath === null) {
        throw new Error(typeof requested === 'string' && requested.length > 0
          ? `no such executable: ${requested}. Fix appPath, or start Gandi yourself with --remote-debugging-port=${config.port}.`
          : 'no Gandi executable found. Pass appPath once (it is remembered for later sessions), or set appPath / GANDI_APP_PATH.')
      }
      service.dispose()
      const launched = await launchAndAttach({ appPath, port: config.port, timeoutMs })
      const ready = await waitForVm(launched.connection, { timeoutMs })
      return {
        text: `Gandi started from ${appPath} on port ${config.port}; editor ${ready ? 'ready' : 'did not finish loading a project'}.`,
        appPath,
        ready
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
      return service.use({ sessionId, mutating: true }, async (connection) => {
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
      return service.use({ sessionId, mutating: true }, async (connection) => {
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

      return service.use({ sessionId, mutating: true }, async (connection) => {
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
      'Add a costume to a sprite — or a backdrop to the stage (target "stage") — from SVG markup you write yourself, or from base64 bytes for a bitmap.',
      'Pass either `svg` text or `base64` plus `dataFormat`; the asset id is derived from the content.',
      'When no rotation centre is given, the middle of the artwork is used, so the sprite rotates about its centre.',
      'A backdrop usually wants no rotation centre at all; pass 0,0 for that.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Sprite name or id, or "stage" for a backdrop. Defaults to the editing target.' },
        name: { type: 'string', description: 'Costume or backdrop name (default "costume").' },
        svg: { type: 'string', description: 'SVG markup. Mutually exclusive with base64.' },
        base64: { type: 'string', description: 'Base64 bytes of the image. Requires dataFormat.' },
        dataFormat: { type: 'string', description: 'svg, png, jpg, bmp or gif (default svg).' },
        rotationCenterX: { type: 'number', description: 'Rotation centre x, in costume pixels.' },
        rotationCenterY: { type: 'number', description: 'Rotation centre y, in costume pixels.' }
      },
      additionalProperties: false
    },
    async run (args, exec, sessionId) {
      const hasSvg = typeof args.svg === 'string' && args.svg.trim().length > 0
      const hasBase64 = typeof args.base64 === 'string' && args.base64.trim().length > 0
      if (hasSvg === hasBase64) throw new Error('pass exactly one of `svg` or `base64`')

      const dataFormat = (typeof args.dataFormat === 'string' && args.dataFormat.length > 0
        ? args.dataFormat
        : (hasSvg ? 'svg' : 'png')).toLowerCase()
      const name = typeof args.name === 'string' && args.name.length > 0 ? args.name : `costume`

      let base64 = args.base64
      let centre = null
      if (hasSvg) {
        assertLooksLikeSvg(args.svg)
        centre = defaultRotationCenter(args.svg)
        base64 = Buffer.from(args.svg, 'utf8').toString('base64')
      }
      const rotationCenterX = Number.isFinite(args.rotationCenterX) ? Number(args.rotationCenterX) : (centre?.x ?? 0)
      const rotationCenterY = Number.isFinite(args.rotationCenterY) ? Number(args.rotationCenterY) : (centre?.y ?? 0)

      return service.use({ sessionId, mutating: true }, async (connection) => {
        const installed = await addCostume(connection, {
          target: typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined,
          name,
          dataFormat,
          base64,
          rotationCenterX,
          rotationCenterY
        })
        const where = installed.isStage ? 'the stage' : installed.target
        const centreNote = installed.isStage
          ? 'no rotation centre needed for a backdrop'
          : `rotation centre ${rotationCenterX}, ${rotationCenterY}`
        return {
          text: [
            `added ${installed.kind} "${installed.costume}" to ${where} (${installed.bytes} bytes, ${centreNote})`,
            `${installed.kind}s now: ${installed.costumes.join(', ')}`
          ].join('\n')
        }
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

      return service.use({ sessionId, mutating: true }, async (connection) => {
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
      'Add a sound to a sprite.',
      'By default it SYNTHESIZES one from a pitch, a duration and a waveform — give `sweepTo` for a rise or a fall, which is what most game sounds are.',
      'Pass base64 instead to upload audio bytes you already have.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Sprite name or id. Defaults to the editing target.' },
        name: { type: 'string', description: 'Sound name (default "sound").' },
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

      return service.use({ sessionId, mutating: true }, async (connection) => {
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
      return service.use({ sessionId, mutating: true }, async (connection) => {
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
      'Feed keyboard or mouse input to the running project, for testing interactive games.',
      'Keys are held until released, so press, run, then release. Mouse coordinates are Scratch stage coordinates.',
      'Events affect the NEXT run, so call this before or between gandi_run calls.'
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

      return service.use({ sessionId, mutating: true }, async (connection) => {
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
    async run (_args, exec, sessionId) {
      return service.use({ sessionId, mutating: true }, async (connection) => {
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
      'Pass dryRun to compile and see warnings without touching the editor.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        xml: { type: 'string', description: 'scratch-blocks XML: an <xml> wrapper, or a bare <block>.' },
        target: { type: 'string', description: 'Sprite name or id. Defaults to the editing target (or the first sprite, offline).' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace (default) removes that sprite\'s existing scripts first.' },
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
      const mode = args.mode === 'append' ? 'append' : 'replace'
      const target = typeof args.target === 'string' && args.target.length > 0 ? args.target : undefined
      const fragment = compileScripts(xml)
      const warnings = fragment.warnings.length === 0 ? '  (none)' : fragment.warnings.map((w) => `  ${w}`).join('\n')

      // The offline path never needs the engine-form conversion, because a project
      // document already stores blocks in the wire form the compiler emits.
      if (args.dryRun === true) {
        const engine = fragmentToEngine(fragment)
        return {
          text: `dry run: ${Object.keys(fragment.blocks).length} block(s) compiled into ${engine.blocks.length} engine block(s), ${fragment.variables.length} variable declaration(s).\nwarnings:\n${warnings}`
        }
      }
      if (fragment.warnings.length > 0) {
        throw new Error(`refusing to apply XML with problems:\n${warnings}\nFix them, or call again with dryRun: true to inspect first.`)
      }

      // Offline: splice into the project document and write the archive back.
      if (typeof args.path === 'string' && args.path.length > 0) {
        const absolute = resolveProjectPath(args.path, exec)
        const destination = typeof args.outPath === 'string' && args.outPath.length > 0
          ? resolveProjectPath(args.outPath, exec)
          : absolute
        const { project, assets, warnings: containerWarnings } = await readProjectFile(absolute)
        const result = applyFragmentToProject(project, {
          target,
          fragment,
          mode,
          scope: args.scope === 'local' ? 'local' : 'global'
        })
        // The destination extension decides the format: writing an archive into a
        // file called project.json would produce a ZIP a reader cannot parse.
        const asJson = destination.toLowerCase().endsWith('.json')
        const bytes = asJson
          ? Buffer.from(`${JSON.stringify(project, null, 2)}\n`, 'utf8')
          : writeSb3(project, assets)
        await writeFile(destination, bytes)
        return {
          text: [
            `edited ${absolute}${destination === absolute ? ' in place' : ` -> ${destination}`} (${asJson ? 'project.json' : 'sb3 archive'})`,
            `applied ${result.createdBlocks} block(s) to ${result.target} (${result.removedBlocks} block(s) removed, mode ${mode})`,
            `now ${result.blocksAfter} block(s) in that target`,
            result.declaredVariables.length > 0 ? `declared variables: ${result.declaredVariables.join(', ')}` : 'no new variables',
            `comments: +${result.createdComments} / -${result.removedComments}`,
            `wrote ${bytes.length} bytes`,
            ...(containerWarnings.length > 0 ? [`container notes:\n${containerWarnings.map((w) => `  ${w}`).join('\n')}`] : [])
          ].join('\n')
        }
      }

      const engine = fragmentToEngine(fragment)
      return service.use({ sessionId, mutating: true }, async (connection) => {
        const applied = await applyFragment(connection, {
          target,
          blocks: engine.blocks,
          variables: fragment.variables,
          comments: engine.comments,
          mode
        })
        return {
          text: [
            `applied ${applied.createdBlocks} block(s) to ${applied.target.name} (${applied.removedScripts} old script(s) removed, mode ${applied.mode})`,
            `now ${applied.blocksAfter} block(s) in ${applied.topLevelScripts} script(s)`,
            applied.createdVariables.length > 0 ? `created variables: ${applied.createdVariables.join(', ')}` : 'no new variables',
            applied.createdComments > 0 || applied.removedComments > 0
              ? `comments: +${applied.createdComments} / -${applied.removedComments}`
              : 'no comments changed'
          ].join('\n')
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
      'Timers are paced against the real clock, so "wait 1 seconds" blocks behave as they do for a user.',
      'Returns the resulting runtime state and, by default, a stage image so you can see the outcome.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'How long to run, in seconds (default 1, capped at 60).' },
        stopAfter: { type: 'boolean', description: 'Stop all scripts afterwards (default true).' },
        screenshot: { type: 'boolean', description: 'Include a stage image (defaults to the plugin config, normally true).' },
        includeClones: { type: 'boolean', description: 'Include clones in the reported state (default false).' },
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

      return service.use({ sessionId, mutating: true }, async (connection) => {
        // Position the mouse before the flag: it has no edge semantics, so unlike the
        // keyboard it survives greenFlag (postMouse does not touch the key cache).
        for (const event of mouseEvents) await postMouse(connection, { x: event.x, y: event.y, isDown: event.click, click: event.click })
        const run = await runSteps(connection, { seconds, stopAfter, events: keyEvents })
        const state = await observe(connection, { includeClones: args.includeClones === true })
        const lines = [
          `ran ${run.steps} frames (~${seconds}s): ${run.startedThreads} thread(s) started, ${run.threadsLeft} still running${run.stopped === true ? ', stopped afterwards' : ''}`
        ]
        if (run.eventsFired > 0) lines.push(`input applied during the run: ${run.eventsFired} key event(s)`)
        for (const target of state.targets) {
          const vars = target.variables.length > 0
            ? ` vars: ${target.variables.map((v) => `${v.name}=${formatValue(v.value)}`).join(', ')}`
            : ''
          lines.push(`  ${target.name}${target.isStage ? ' (stage)' : ''}: x=${target.x} y=${target.y} dir=${target.direction} costume=${target.costume ?? 'none'}${vars}`)
        }
        const text = clamp(lines.join('\n'))
        if (!wantShot) return { text }
        const shot = await screenshot(connection)
        return withStageImage(shot, text, exec)
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
