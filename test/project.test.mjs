import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts } from '../src/scratch/xml.mjs'
import {
  applyFragmentToProject,
  collectScript,
  declarationsOf,
  findProjectTarget,
  fragmentFromProject,
  listProjectTargets,
  summarizeProject,
  targetXmlFromProject,
  ProjectError
} from '../src/scratch/project.mjs'

/** A project with a stage holding globals and one sprite with a local list. */
const project = () => ({
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: { globalScore: ['score', 0], broadcastId: ['go', 'go'] },
      lists: { globalList: ['items', []] },
      broadcasts: { message1: 'message1' },
      blocks: {},
      costumes: [{ name: 'backdrop1' }],
      sounds: []
    },
    {
      isStage: false,
      name: 'Sprite1',
      variables: { localVar: ['local', 1] },
      lists: {},
      broadcasts: {},
      blocks: {
        hat: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, x: 20, y: 30 },
        set: {
          opcode: 'data_setvariableto',
          next: null,
          parent: 'hat',
          inputs: { VALUE: [1, [10, '7']] },
          fields: { VARIABLE: ['score', 'globalScore'] },
          shadow: false,
          topLevel: false
        }
      },
      costumes: [{ name: 'costume1' }],
      sounds: [{ name: 'pop' }]
    }
  ],
  extensions: ['pen']
})

test('declarations cover variables, lists and broadcasts', () => {
  assert.deepEqual(declarationsOf(project().targets[0]), [
    { id: 'globalScore', name: 'score', type: '' },
    { id: 'broadcastId', name: 'go', type: '' },
    { id: 'globalList', name: 'items', type: 'list' },
    { id: 'message1', name: 'message1', type: 'broadcast_msg' }
  ])
})

test('finds a target by name, by "stage", and by default', () => {
  const document = project()
  assert.equal(findProjectTarget(document, 'Sprite1').name, 'Sprite1')
  assert.equal(findProjectTarget(document, 'STAGE').isStage, true)
  assert.equal(findProjectTarget(document).name, 'Sprite1')
  assert.throws(() => findProjectTarget(document, 'Nope'), (error) => {
    assert.ok(error instanceof ProjectError)
    assert.match(error.message, /no target named "Nope"/)
    assert.match(error.message, /Stage, Sprite1/)
    return true
  })
  assert.throws(() => findProjectTarget({}, 'x'), ProjectError)
})

test('a sprite fragment carries its own AND the stage declarations', () => {
  const { target, fragment } = fragmentFromProject(project(), 'Sprite1')
  assert.equal(target, 'Sprite1')
  assert.deepEqual(fragment.topLevelIds, ['hat'])
  const ids = fragment.variables.map((declaration) => declaration.id)
  // The sprite references the stage's global, so that declaration has to be there.
  assert.ok(ids.includes('globalScore'), ids.join(','))
  assert.ok(ids.includes('localVar'))
  assert.ok(ids.includes('message1'))
  // ...and the stage's list, which the sprite can also touch.
  assert.ok(ids.includes('globalList'))
})

test('the stage fragment carries only the stage declarations', () => {
  const { fragment } = fragmentFromProject(project(), 'stage')
  assert.deepEqual(fragment.variables.map((d) => d.id).sort(), ['broadcastId', 'globalList', 'globalScore', 'message1'])
})

test('renders a file-only target as the same XML the dialect accepts', () => {
  const { target, xml, scripts } = targetXmlFromProject(project(), 'Sprite1')
  assert.equal(target, 'Sprite1')
  assert.equal(scripts, 1)
  assert.match(xml, /<block type="event_whenflagclicked" id="hat"/)
  assert.match(xml, /<field name="VARIABLE" id="globalScore">score<\/field>/)
  assert.match(xml, /<variable id="globalScore" type="">score<\/variable>/)

  // The whole point: what the offline path prints can be compiled back.
  const recompiled = compileScripts(xml)
  assert.deepEqual(recompiled.warnings, [])
  assert.deepEqual(recompiled.blocks.set.fields, { VARIABLE: ['score', 'globalScore'] })
  assert.deepEqual(recompiled.blocks.hat.next, 'set')
})

test('lists every target in a readable shape', () => {
  const listed = listProjectTargets(project())
  assert.deepEqual(listed.map((t) => t.name), ['Stage', 'Sprite1'])
  assert.equal(listed[0].isStage, true)
  assert.deepEqual(listed[1].scripts, 1)
  assert.deepEqual(listed[1].blocks, 2)
  assert.deepEqual(listed[1].costumes, ['costume1'])
  assert.deepEqual(listed[1].sounds, ['pop'])
  assert.deepEqual(listed[0].variables, ['score', 'go', 'items (list)', 'message1'])
})

test('summarizes a project', () => {
  const text = summarizeProject(project(), { assetCount: 3 })
  assert.match(text, /Stage \(stage\) — 0 script\(s\), 0 block\(s\)/)
  assert.match(text, /Sprite1 — 1 script\(s\), 2 block\(s\)/)
  assert.match(text, /sounds: pop/)
  assert.match(text, /extensions: pen/)
  assert.match(text, /assets: 3/)
})

test('handles an empty project without throwing', () => {
  const empty = { targets: [{ isStage: true, name: 'Stage', blocks: {}, costumes: [] }] }
  assert.deepEqual(listProjectTargets(empty).length, 1)
  assert.match(targetXmlFromProject(empty, 'stage').xml, /^<xml/)
  assert.match(summarizeProject(empty), /Stage \(stage\)/)
})

test('collectScript walks a stack, its inputs and its shadows', () => {
  const blocks = {
    hat: { opcode: 'event_whenflagclicked', next: 'say', inputs: {}, fields: {}, topLevel: true },
    say: { opcode: 'looks_say', next: null, inputs: { MESSAGE: [1, 'textBlock'] }, fields: {} },
    textBlock: { opcode: 'text', next: null, inputs: {}, fields: { TEXT: ['hi'] }, shadow: true },
    unrelated: { opcode: 'motion_movesteps', next: null, inputs: {}, fields: {}, topLevel: true }
  }
  assert.deepEqual([...collectScript(blocks, 'hat')].sort(), ['hat', 'say', 'textBlock'])
})

test('offline apply replaces a script and cascades the delete', () => {
  const document = project()
  const fragment = compileScripts(`<xml>
    <block type="event_whenkeypressed" id="newHat" x="5" y="6">
      <field name="KEY_OPTION">space</field>
    </block>
  </xml>`)
  const result = applyFragmentToProject(document, { target: 'Sprite1', fragment })

  assert.equal(result.target, 'Sprite1')
  // The old script was two blocks deep; both entries must be gone, not just the hat.
  assert.equal(result.removedBlocks, 2)
  assert.equal(result.createdBlocks, 1)
  const sprite = document.targets[1]
  assert.deepEqual(Object.keys(sprite.blocks), ['newHat'])
  assert.equal(result.blocksAfter, 1)
})

test('offline apply with replace clears that target\'s scripts but leaves other targets alone', () => {
  const document = project()
  // A script on the STAGE, which the edit does not name.
  document.targets[0].blocks.stageScript = {
    opcode: 'event_whenflagclicked', next: null, inputs: {}, fields: {}, shadow: false, topLevel: true
  }
  const fragment = compileScripts('<xml><block type="event_whenflagclicked" id="replacement" x="0" y="0"/></xml>')
  applyFragmentToProject(document, { target: 'Sprite1', fragment })

  // "replace" means "this sprite's scripts are now these" — both of its old
  // scripts go, and nothing outside the named target is touched.
  assert.deepEqual(Object.keys(document.targets[1].blocks), ['replacement'])
  assert.deepEqual(Object.keys(document.targets[0].blocks), ['stageScript'])
})

test('offline apply with mode append keeps the existing scripts', () => {
  const document = project()
  const fragment = compileScripts('<xml><block type="event_whenkeypressed" id="added" x="0" y="0"><field name="KEY_OPTION">a</field></block></xml>')
  const result = applyFragmentToProject(document, { target: 'Sprite1', fragment, mode: 'append' })
  assert.equal(result.removedBlocks, 0)
  assert.deepEqual(Object.keys(document.targets[1].blocks).sort(), ['added', 'hat', 'set'])
})

test('offline apply with mode replaceScript swaps exactly one script', () => {
  // The offline twin of the live single-script swap. They have to agree: "read the
  // file, edit it, write it back" is only the same operation as editing live if the
  // two implementations slice the same way.
  const byIndex = project()
  const fragment = compileScripts('<xml><block type="event_whenkeypressed" id="swapped" x="0" y="0"><field name="KEY_OPTION">b</field></block></xml>')
  const result = applyFragmentToProject(byIndex, {
    target: 'Sprite1',
    fragment,
    mode: 'replaceScript',
    script: 1
  })
  assert.equal(result.removedBlocks, 2, 'the first script is the hat plus the block it runs')
  assert.deepEqual(Object.keys(byIndex.targets[1].blocks).sort(), ['swapped'])

  // ...and by id, which is what a caller who has the XML in hand would use. The script
  // is the hat AND everything it continues into, so both go.
  const byId = project()
  applyFragmentToProject(byId, {
    target: 'Sprite1',
    fragment: compileScripts('<xml><block type="event_whenkeypressed" id="swapped2" x="0" y="0"><field name="KEY_OPTION">c</field></block></xml>'),
    mode: 'replaceScript',
    script: 'hat'
  })
  assert.deepEqual(Object.keys(byId.targets[1].blocks), ['swapped2'])
})

test('offline replaceScript refuses a script that is not there, and says what is', () => {
  const document = project()
  assert.throws(
    () => applyFragmentToProject(document, {
      target: 'Sprite1',
      fragment: { blocks: {}, topLevelIds: [] },
      mode: 'replaceScript',
      script: 7
    }),
    (error) => {
      assert.equal(error.name, 'ProjectError')
      assert.match(error.message, /no such script: 7/)
      assert.match(error.message, /1 top-level script\(s\)/)
      assert.match(error.message, /hat/)
      return true
    }
  )
  // Nothing was removed on the way to the error.
  assert.deepEqual(Object.keys(document.targets[1].blocks).sort(), ['hat', 'set'])
})

test('offline apply declares variables on the stage, lists and broadcasts included', () => {
  const document = project()
  const fragment = compileScripts(`<xml>
    <variables>
      <variable id="newScore" type="">points</variable>
      <variable id="newList" type="list">bag</variable>
      <variable id="newMsg" type="broadcast_msg">ping</variable>
    </variables>
    <block type="event_whenflagclicked" id="hat2" x="0" y="0"/>
  </xml>`)
  const result = applyFragmentToProject(document, { target: 'Sprite1', fragment })

  assert.deepEqual(result.declaredVariables, ['points', 'bag', 'ping'])
  const stage = document.targets[0]
  assert.deepEqual(stage.variables.newScore, ['points', ''])
  assert.deepEqual(stage.lists.newList, ['bag', []])
  // Broadcasts are stored as a bare name, not a pair.
  assert.equal(stage.broadcasts.newMsg, 'ping')
})

test('offline apply refuses a fragment whose block ids would collide', () => {
  const document = project()
  const fragment = compileScripts('<xml><block type="event_whenflagclicked" id="hat" x="0" y="0"/></xml>')
  assert.throws(
    () => applyFragmentToProject(document, { target: 'Sprite1', fragment, mode: 'append' }),
    (error) => {
      assert.ok(error instanceof ProjectError)
      assert.match(error.message, /reuses block id "hat"/)
      return true
    }
  )
})

test('offline edit round-trips through the file format', () => {
  // Read a target out of a project, add a script to it, and read the result back:
  // this is the offline authoring loop in miniature.
  const document = project()
  const added = compileScripts(`<xml>
    <variables><variable id="lives" type="">lives</variable></variables>
    <block type="event_whenflagclicked" id="start" x="40" y="40">
      <next>
        <block type="data_setvariableto" id="setLives">
          <field name="VARIABLE" id="lives">lives</field>
          <value name="VALUE"><shadow type="text"><field name="TEXT">3</field></shadow></value>
        </block>
      </next>
    </block>
  </xml>`)
  applyFragmentToProject(document, { target: 'Sprite1', fragment: added })

  const readBack = targetXmlFromProject(document, 'Sprite1')
  assert.match(readBack.xml, /<block type="event_whenflagclicked" id="start"/)
  assert.match(readBack.xml, /<field name="VARIABLE" id="lives">lives<\/field>/)
  // And it compiles again — the loop is closed.
  const recompiled = compileScripts(readBack.xml)
  assert.deepEqual(recompiled.warnings, [])
  assert.equal(recompiled.blocks.setLives.fields.VARIABLE[1], 'lives')
})
