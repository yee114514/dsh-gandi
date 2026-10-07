/**
 * Plugin-level tests that drive the real tool definitions through a fake cordis
 * context.
 *
 * These cover everything except the harness's own plumbing: argument validation,
 * error translation, config resolution, the lease, and the compiler pipeline that
 * `gandi_apply --dryRun` exercises without needing an editor at all. The parts
 * that genuinely need a running Gandi are exercised by `tools/e2e.mjs`.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../src/index.mjs'

/** A closed port: nothing should be listening, so the bridge must degrade cleanly. */
const CLOSED_PORT = 9231

/**
 * Disposers handed out by every harness in this file.
 *
 * The plugin registers a `ctx.effect` that closes its CDP socket. If a test ever
 * causes the plugin to attach (which happens whenever the machine running the
 * suite has Gandi on the debug port), that socket keeps Node's event loop
 * alive and the whole run hangs after the last assertion. Collect and run them.
 */
const pendingDisposers = []
after(() => {
  while (pendingDisposers.length > 0) {
    try {
      pendingDisposers.pop()()
    } catch {
      // Cleanup must not turn a green run red.
    }
  }
})

/**
 * Build a minimal cordis-like context and register the plugin's tools into it.
 * @param {Record<string, unknown>} [config] row config
 * @param {{noDefaultPort?: boolean}} [options] omit the closed-port default so the environment can supply one
 * @returns {{tools: Map<string, any>, call: (name: string, args?: any) => Promise<any>, dispose: () => void, stderr: string[]}}
 */
const harness = (config = {}, options = {}) => {
  /** @type {Map<string, any>} */
  const tools = new Map()
  /** @type {Array<() => void>} */
  const disposers = []
  const stderr = []
  const ctx = {
    tools: {
      register (definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      }
    },
    // Every optional service is absent, which must be tolerated.
    get () {
      return undefined
    },
    effect (callback) {
      const disposer = callback()
      if (typeof disposer === 'function') {
        disposers.push(disposer)
        pendingDisposers.push(disposer)
      }
      return () => {}
    }
  }

  apply(ctx, {
    ...(options.noDefaultPort === true ? {} : { port: CLOSED_PORT }),
    debug: false,
    ...config
  })

  return {
    tools,
    stderr,
    async call (toolName, args = {}) {
      const definition = tools.get(toolName)
      if (definition === undefined) throw new Error(`no such tool: ${toolName}`)
      // Mirror the registry: it validates the returned value against output.schema.
      const value = await definition.execute(args, {
        agent: { id: 'test-agent', session: { header: { id: 'test-session', cwd: process.cwd() } } }
      })
      const render = definition.output.render
      const blocks = render(args, value)
      assert.ok(Array.isArray(blocks) && blocks.length > 0, `${toolName} render must return content blocks`)
      assert.equal(blocks[0].type, 'text')
      assert.equal(typeof blocks[0].text, 'string')
      return { value, blocks }
    }
  }
}

test('exports the cordis plugin contract', () => {
  // The exported name doubles as the row id in cordis.patch.yml; keep them equal.
  assert.equal(name, 'gandi')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('registers the full tool surface with valid definitions', () => {
  const h = harness()
  assert.deepEqual([...h.tools.keys()].sort(), [
    'gandi_apply',
    'gandi_costume',
    'gandi_input',
    'gandi_inspect',
    'gandi_launch',
    'gandi_lease',
    'gandi_merge',
    'gandi_new',
    'gandi_observe',
    'gandi_open',
    'gandi_place',
    'gandi_run',
    'gandi_save',
    'gandi_screenshot',
    'gandi_sound',
    'gandi_sprite',
    'gandi_status',
    'gandi_stop',
    'gandi_variable',
    'gandi_verify'
  ])
  for (const [toolName, definition] of h.tools) {
    assert.equal(typeof definition.description, 'string', `${toolName} needs a description`)
    assert.ok(definition.description.length > 20, `${toolName} description is too terse to guide a model`)
    assert.equal(typeof definition.execute, 'function', `${toolName} needs execute`)
    assert.equal(typeof definition.output.render, 'function', `${toolName} needs output.render`)
    assert.equal(typeof definition.output.schema, 'object', `${toolName} needs output.schema`)
    assert.equal(typeof definition.parameters, 'object', `${toolName} needs parameters`)
  }
})

test('gandi_apply --dryRun compiles without an editor', async () => {
  const h = harness()
  const { value } = await h.call('gandi_apply', {
    dryRun: true,
    xml: `<xml>
      <block type="event_whenflagclicked" id="hat" x="40" y="40">
        <next>
          <block type="motion_movesteps" id="move">
            <value name="STEPS"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
          </block>
        </next>
      </block>
    </xml>`
  })
  assert.match(value.text, /dry run/)
  assert.match(value.text, /2 block\(s\) compiled into 3 engine block\(s\)/)
  assert.match(value.text, /warnings:\n {2}\(none\)/)
})

test('gandi_apply --dryRun reports compiler warnings instead of applying', async () => {
  const h = harness()
  const { value } = await h.call('gandi_apply', { dryRun: true, xml: '<xml><block id="typeless"/></xml>' })
  assert.match(value.text, /without a type attribute/)
})

test('gandi_apply refuses to apply XML that has warnings', async () => {
  const h = harness()
  await assert.rejects(
    () => h.call('gandi_apply', { xml: '<xml><block type="looks_say" id="s"><value name="MESSAGE"><shadow type="text"><field name="WRONG">x</field></shadow></value></block></xml>' }),
    (error) => {
      assert.match(error.message, /refusing to apply XML with problems/)
      assert.match(error.message, /missing its <field name="TEXT">/)
      return true
    }
  )
})

test('missing and malformed arguments produce one readable sentence', async () => {
  const h = harness()
  await assert.rejects(() => h.call('gandi_apply', {}), /xml must be a non-empty string/)
  await assert.rejects(() => h.call('gandi_apply', { xml: '   ' }), /xml must be a non-empty string/)
  await assert.rejects(() => h.call('gandi_open', {}), /path must be a non-empty string/)
  await assert.rejects(() => h.call('gandi_save', { path: 42 }), /path must be a non-empty string/)
})

test('paths outside the session workspace are refused', async () => {
  const h = harness()
  await assert.rejects(
    () => h.call('gandi_save', { path: 'C:/Windows/Temp/escape.sb3' }),
    /outside the session workspace/
  )
})

test('an unreachable editor yields guidance, not a stack trace', async () => {
  const h = harness()
  const { value } = await h.call('gandi_status')
  assert.match(value.text, /port 9231: closed/)
  assert.match(value.text, /connection: not attached/)
  // Whether a Gandi process happens to exist on the test machine changes the
  // wording; either branch must point at the next action.
  assert.match(value.text, /NOTE: .*gandi_launch/)
  assert.match(value.text, /lease: free/)
})

test('mutating tools surface a clear bridge error when the editor is absent', async () => {
  const h = harness()
  await assert.rejects(
    () => h.call('gandi_run', { seconds: 0.1, screenshot: false }),
    (error) => {
      // The wording depends on whether a Gandi process happens to be running on
      // the test machine, so this asserts only what must be true either way: the port
      // is named, and so is a way out. (An earlier version pinned the running-case
      // phrasing and passed for weeks purely because an editor was open.)
      assert.match(error.message, /9231/, 'the failing port must be named')
      assert.match(error.message, /gandi_launch/, 'the error must point at the tool that fixes it')
      assert.match(error.message, /remote-debugging-port=9231/, 'or at the flag to start it by hand')
      return true
    }
  )
})

test('gandi_launch names the misconfigured path instead of substituting another', async () => {
  const h = harness({ appPath: 'C:/definitely/not/here/Gandi.exe' })
  await assert.rejects(
    () => h.call('gandi_launch'),
    (error) => {
      // An explicit path is honoured as given. Falling back to a remembered or
      // discovered path here would silently ignore configuration — and would make
      // this test launch a real editor.
      assert.match(error.message, /no such executable: C:\/definitely\/not\/here\/Gandi\.exe/)
      assert.match(error.message, /Fix appPath/)
      return true
    }
  )
})

test('the status report always names the app path, so a misconfiguration is visible', async () => {
  // Uses the closed port on purpose: this must not depend on whether the machine
  // running the suite happens to have an editor open.
  const h = harness()
  const { value } = await h.call('gandi_status')
  assert.match(value.text, /app path:/)
  assert.match(value.text, /lease: free/)
})

test('configuration falls back to the environment and to defaults', async () => {
  process.env.GANDI_PORT = '9555'
  try {
    const h = harness({}, { noDefaultPort: true })
    const { value } = await h.call('gandi_status')
    assert.match(value.text, /port 9555/)
  } finally {
    delete process.env.GANDI_PORT
  }
})

test('an explicit config value wins over the environment', async () => {
  process.env.GANDI_PORT = '9555'
  try {
    const h = harness({ port: 9666 })
    const { value } = await h.call('gandi_status')
    assert.match(value.text, /port 9666/)
  } finally {
    delete process.env.GANDI_PORT
  }
})

test('every tool is marked either concurrency-safe or exclusive', () => {
  const h = harness()
  // gandi_lease only touches the in-process lease, and gandi_verify's default path only
  // reads a file; its live: true path takes the lease and the mutex itself.
  const readOnly = ['gandi_status', 'gandi_inspect', 'gandi_observe', 'gandi_screenshot', 'gandi_save', 'gandi_lease', 'gandi_verify']
  for (const [toolName, definition] of h.tools) {
    const safe = definition.isConcurrencySafe({})
    if (readOnly.includes(toolName)) {
      assert.equal(safe, true, `${toolName} should be concurrency-safe`)
    } else {
      assert.equal(safe, false, `${toolName} mutates the editor and must not run in parallel`)
    }
  }
})

test('every mutating tool can actually be told to take the lease', () => {
  // The lease conflict message tells the caller to "pass force: true to take over".
  // That has to be reachable: a schema with additionalProperties: false strips anything
  // it does not declare, so a promise like that is only as good as the parameter list.
  const h = harness()
  let mutating = 0
  for (const [toolName, definition] of h.tools) {
    if (definition.isConcurrencySafe({}) === true) continue
    mutating++
    const properties = definition.parameters?.properties ?? {}
    assert.ok(properties.force, `${toolName} is mutating but does not accept force`)
    assert.equal(properties.force.type, 'boolean', `${toolName}: force must be a boolean`)
    assert.ok(properties.force.description.length > 30, `${toolName}: force needs a description a model can act on`)
  }
  assert.ok(mutating > 5, 'the surface should still have its mutating tools')
  // A read-only tool has no business taking a lease, and offering the parameter there
  // would invite a caller to think it can.
  assert.equal(h.tools.get('gandi_status').parameters.properties.force, undefined)
})

test('gandi_apply refuses XML the editor could not open, and names the fix', async () => {
  const h = harness()
  // The clone dropdown written as a costume menu: this compiled clean once, reported no
  // warnings, and produced a game where nothing was ever cloned. It now never reaches
  // the editor.
  await assert.rejects(
    () => h.call('gandi_apply', {
      xml: `<xml>
        <block type="control_create_clone_of" id="clone" x="0" y="0">
          <value name="CLONE_OPTION"><shadow type="looks_costume"><field name="COSTUME">_myself_</field></shadow></value>
        </block>
      </xml>`
    }),
    (error) => {
      assert.match(error.message, /would make the project unusable/)
      assert.match(error.message, /takes the dropdown <shadow type="control_create_clone_of_menu">/)
      return true
    }
  )
  // ...and the broadcast one, which used to produce a project that would not open at all.
  await assert.rejects(
    () => h.call('gandi_apply', {
      xml: `<xml>
        <block type="event_broadcast" id="send" x="0" y="0">
          <value name="BROADCAST_INPUT"><shadow type="broadcast_msg"><field name="BROADCAST_OPTION">go</field></shadow></value>
        </block>
      </xml>`
    }),
    /`broadcast_msg` is the type of a broadcast VARIABLE/
  )
})

test('gandi_verify checks a file without an editor, and refuses to guess at one it cannot read', async () => {
  const h = harness()
  await assert.rejects(() => h.call('gandi_verify', {}), /path must be a non-empty string/)
  // A path that is not there is reported as such rather than as a load failure.
  await assert.rejects(() => h.call('gandi_verify', { path: 'no-such-project.sb3' }), /ENOENT|no such file/i)
})

test('gandi_lease reports and hands over the edit lease', async () => {
  const h = harness()
  const { value } = await h.call('gandi_lease')
  assert.match(value.text, /status: the lease is free/)
  await assert.rejects(() => h.call('gandi_lease', { action: 'nap' }), /unknown action "nap"/)
})

test('gandi_costume validates its input before touching the editor', async () => {
  const h = harness()
  await assert.rejects(() => h.call('gandi_costume', {}), /pass exactly one of `svg` or `base64`/)
  await assert.rejects(
    () => h.call('gandi_costume', { svg: '<svg/>', base64: 'AAAA' }),
    /pass exactly one of `svg` or `base64`/
  )
  // Structural problems must be caught here, not installed as an invisible costume.
  await assert.rejects(() => h.call('gandi_costume', { svg: '<div>nope</div>' }), /does not contain an <svg> element/)
})

test('gandi_sprite rejects an unknown action', async () => {
  const h = harness()
  await assert.rejects(() => h.call('gandi_sprite', { action: 'explode' }), /unknown action "explode"/)
})

test('gandi_place needs at least one thing to change', async () => {
  const h = harness()
  await assert.rejects(() => h.call('gandi_place', {}), /pass at least one of x, y, direction, size or visible/)
})
