/**
 * The offline path: read and edit a `.sb3` on disk with no editor at all.
 *
 * The harness deliberately points at a CLOSED debug port, so anything that
 * accidentally reached for the bridge would fail loudly rather than pass by
 * accident on a machine that happens to have TurboWarp open.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.mjs'
import { assetMd5ext, readSb3, writeSb3 } from '../src/scratch/sb3.mjs'

/** Nothing listens here. */
const CLOSED_PORT = 9241

const pendingDisposers = []
after(async () => {
  while (pendingDisposers.length > 0) {
    try {
      pendingDisposers.pop()()
    } catch {
      // Cleanup must not turn a green run red.
    }
  }
})

/**
 * Register the plugin into a fake cordis context whose session working directory
 * is `cwd`, so the plugin's workspace confinement resolves inside the fixture.
 */
const harness = (cwd) => {
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: () => undefined,
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') pendingDisposers.push(disposer)
      return () => {}
    }
  }
  apply(ctx, { port: CLOSED_PORT, debug: false })
  return async (name, args = {}) => {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`no such tool: ${name}`)
    const value = await definition.execute(args, {
      agent: { id: 'offline-agent', session: { header: { id: 'offline-session', cwd } } }
    })
    const blocks = definition.output.render(args, value)
    return { value, text: blocks[0].text }
  }
}

/** A project with a stage and one scriptable sprite, plus a real SVG costume. */
const fixtureProject = () => {
  const costume = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="9" fill="#3355ff"/></svg>', 'utf8')
  const md5ext = assetMd5ext(costume, 'svg')
  const project = {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [{ name: 'backdrop1', dataFormat: 'svg', assetId: md5ext.split('.')[0], md5ext, rotationCenterX: 0, rotationCenterY: 0 }],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'off',
        textToSpeechLanguage: null
      },
      {
        isStage: false,
        name: 'Player',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [{ name: 'dot', dataFormat: 'svg', assetId: md5ext.split('.')[0], md5ext, rotationCenterX: 10, rotationCenterY: 10 }],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around'
      }
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'test' }
  }
  return { project, assets: new Map([[md5ext, costume]]) }
}

const SCRIPT = `<xml>
  <variables><variable id="livesId" type="">lives</variable></variables>
  <block type="event_whenflagclicked" id="offlineHat" x="24" y="24">
    <next>
      <block type="data_setvariableto" id="offlineSet">
        <field name="VARIABLE" id="livesId">lives</field>
        <value name="VALUE"><shadow type="text"><field name="TEXT">3</field></shadow></value>
      </block>
    </next>
  </block>
</xml>`

const withTempWorkspace = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), 'scratch-offline-'))
  try {
    return await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a project file can be inspected and edited with no editor running', async () => {
  await withTempWorkspace(async (workspace) => {
    const call = harness(workspace)
    const projectPath = join(workspace, 'game.sb3')
    const { project, assets } = fixtureProject()
    await writeFile(projectPath, writeSb3(project, assets))

    // ── read it ────────────────────────────────────────────────────────────
    const before = await call('gandi_inspect', { path: 'game.sb3' })
    assert.match(before.text, /project: /)
    assert.match(before.text, /Player — 0 script\(s\), 0 block\(s\)/)
    assert.match(before.text, /costumes: dot/)
    assert.match(before.text, /scripts of Player/)
    assert.doesNotMatch(before.text, /event_whenflagclicked/)

    // ── edit it ────────────────────────────────────────────────────────────
    const applied = await call('gandi_apply', { path: 'game.sb3', target: 'Player', xml: SCRIPT })
    assert.match(applied.text, /edited .*game\.sb3 in place/)
    assert.match(applied.text, /applied 2 block\(s\) to Player/)
    assert.match(applied.text, /declared variables: lives/)

    // ── and read the result back ───────────────────────────────────────────
    const after = await call('gandi_inspect', { path: 'game.sb3', target: 'Player' })
    assert.match(after.text, /Player — 1 script\(s\), 2 block\(s\)/)
    assert.match(after.text, /event_whenflagclicked/)
    assert.match(after.text, /data_setvariableto/)

    // The written file is a real archive, and the edit really is in it.
    const reopened = readSb3(await readFile(projectPath))
    assert.deepEqual(reopened.warnings, [])
    const player = reopened.project.targets.find((target) => target.name === 'Player')
    assert.deepEqual(Object.keys(player.blocks).sort(), ['offlineHat', 'offlineSet'])
    assert.equal(player.blocks.offlineHat.next, 'offlineSet')
    assert.equal(player.blocks.offlineSet.parent, 'offlineHat')
    assert.deepEqual(player.blocks.offlineSet.fields.VARIABLE, ['lives', 'livesId'])
    // A global variable goes on the stage; the costume assets survive the rewrite.
    const stage = reopened.project.targets.find((target) => target.isStage)
    assert.deepEqual(stage.variables.livesId, ['lives', ''])
    assert.equal(reopened.assets.size, 1)
  })
})

test('outPath writes a copy and leaves the original alone', async () => {
  await withTempWorkspace(async (workspace) => {
    const call = harness(workspace)
    const original = join(workspace, 'original.sb3')
    const { project, assets } = fixtureProject()
    const before = writeSb3(project, assets)
    await writeFile(original, before)

    const applied = await call('gandi_apply', {
      path: 'original.sb3',
      outPath: 'edited.sb3',
      target: 'Player',
      xml: SCRIPT
    })
    assert.match(applied.text, /edited .*original\.sb3 -> .*edited\.sb3/)

    assert.deepEqual(await readFile(original), before, 'the source file must be untouched')
    const copy = readSb3(await readFile(join(workspace, 'edited.sb3')))
    assert.equal(Object.keys(copy.project.targets.find((t) => t.name === 'Player').blocks).length, 2)
  })
})

test('a second edit replaces the first script rather than piling up', async () => {
  await withTempWorkspace(async (workspace) => {
    const call = harness(workspace)
    const { project, assets } = fixtureProject()
    await writeFile(join(workspace, 'game.sb3'), writeSb3(project, assets))

    await call('gandi_apply', { path: 'game.sb3', target: 'Player', xml: SCRIPT })
    const second = await call('gandi_apply', {
      path: 'game.sb3',
      target: 'Player',
      xml: '<xml><block type="event_whenkeypressed" id="onlyHat" x="0" y="0"><field name="KEY_OPTION">space</field></block></xml>'
    })
    // The first script was two blocks deep; both entries must be gone.
    assert.match(second.text, /2 block\(s\) removed/)

    const reopened = readSb3(await readFile(join(workspace, 'game.sb3')))
    const player = reopened.project.targets.find((target) => target.name === 'Player')
    assert.deepEqual(Object.keys(player.blocks), ['onlyHat'])
  })
})

test('offline reading refuses a path outside the workspace', async () => {
  await withTempWorkspace(async (workspace) => {
    const call = harness(workspace)
    await assert.rejects(
      () => call('gandi_inspect', { path: join(tmpdir(), 'elsewhere.sb3') }),
      /outside the session workspace/
    )
  })
})

test('offline reading reports a missing file plainly', async () => {
  await withTempWorkspace(async (workspace) => {
    const call = harness(workspace)
    await assert.rejects(() => call('gandi_inspect', { path: 'nope.sb3' }), /ENOENT|no such file/)
  })
})

test('a bare project.json is accepted as well as an .sb3', async () => {
  await withTempWorkspace(async (workspace) => {
    const call = harness(workspace)
    const { project } = fixtureProject()
    await writeFile(join(workspace, 'project.json'), JSON.stringify(project, null, 2))

    const inspected = await call('gandi_inspect', { path: 'project.json' })
    assert.match(inspected.text, /Player — 0 script\(s\)/)

    const applied = await call('gandi_apply', { path: 'project.json', target: 'Player', xml: SCRIPT })
    assert.match(applied.text, /applied 2 block\(s\) to Player/)

    const edited = JSON.parse(await readFile(join(workspace, 'project.json'), 'utf8'))
    assert.equal(Object.keys(edited.targets.find((t) => t.name === 'Player').blocks).length, 2)
  })
})
