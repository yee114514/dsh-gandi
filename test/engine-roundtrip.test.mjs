import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts } from '../src/scratch/xml.mjs'
import { engineToFragment, fragmentToEngine } from '../src/scratch/engine.mjs'

/**
 * The engine form and the wire form are two views of the same block graph.
 *
 * The plugin compiles to the wire form (what a project document and `createBlock`
 * both take after conversion), but a LIVE target's block map is in engine form, so
 * reading a running editor goes the other way. A bug in that direction is quiet: the
 * decompiler renders an empty script, which reads as "this sprite has no blocks".
 */

const roundTrip = (xml) => {
  const wire = compileScripts(xml)
  const engine = fragmentToEngine(wire)
  const back = engineToFragment(engine)
  return { wire, engine, back }
}

test('returns a fragment equal to the one it was made from', () => {
  const { wire, back } = roundTrip(`<xml>
    <block type="event_whenflagclicked" id="hat" x="40" y="60">
      <next>
        <block type="motion_gotoxy" id="go">
          <value name="X"><shadow type="math_number"><field name="NUM">120</field></shadow></value>
          <value name="Y">
            <block type="operator_add" id="add">
              <value name="NUM1"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
              <value name="NUM2"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
            </block>
            <shadow type="math_number"><field name="NUM">0</field></shadow>
          </value>
          <next>
            <block type="looks_say" id="say">
              <value name="MESSAGE"><shadow type="text"><field name="TEXT">done</field></shadow></value>
            </block>
          </next>
        </block>
      </next>
    </block>
  </xml>`)

  assert.deepEqual(back.blocks, wire.blocks)
  assert.deepEqual(back.topLevelIds, wire.topLevelIds)
})

test('inlines materialised primitives again, leaving no stray blocks', () => {
  const { wire, engine, back } = roundTrip(`<xml>
    <block type="motion_movesteps" id="move" x="0" y="0">
      <value name="STEPS"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
    </block>
  </xml>`)

  // The engine form has the primitive as a real block...
  assert.equal(engine.blocks.length, 2)
  assert.equal(engine.blocks.find((block) => block.opcode === 'math_number').shadow, true)
  // ...and the wire form has it inlined, with exactly one entry in the map.
  assert.deepEqual(Object.keys(back.blocks), ['move'])
  assert.deepEqual(back.blocks.move.inputs.STEPS, [1, [4, '10']])
  assert.deepEqual(back.blocks, wire.blocks)
})

test('carries a non-primitive shadow across as a shadow block id', () => {
  const { wire, back } = roundTrip(`<xml>
    <block type="looks_switchcostumeto" id="switch" x="0" y="0">
      <value name="COSTUME">
        <shadow type="looks_costume" id="menu"><field name="COSTUME">costume1</field></shadow>
      </value>
    </block>
  </xml>`)
  assert.deepEqual(back.blocks.switch.inputs.COSTUME, [1, 'menu'])
  assert.equal(back.blocks.menu.shadow, true)
  assert.deepEqual(back.blocks, wire.blocks)
})

test('keeps field ids, variable kinds and mutations', () => {
  const { wire, back } = roundTrip(`<xml>
    <variables><variable id="v1" type="">score</variable></variables>
    <block type="data_setvariableto" id="set" x="0" y="0">
      <field name="VARIABLE" id="v1" variabletype="">score</field>
      <value name="VALUE"><shadow type="text"><field name="TEXT">1</field></shadow></value>
    </block>
    <block type="procedures_call" id="call" x="0" y="200">
      <mutation proccode="go %n" argumentids="[&quot;a1&quot;]" warp="false"></mutation>
      <value name="a1"><shadow type="math_number"><field name="NUM">3</field></shadow></value>
    </block>
  </xml>`)
  assert.deepEqual(back.blocks.set.fields.VARIABLE, ['score', 'v1'])
  assert.equal(back.blocks.call.mutation.proccode, 'go %n')
  assert.deepEqual(back.blocks, wire.blocks)
})

test('carries comment links across', () => {
  const { wire, back } = roundTrip(`<xml>
    <block type="event_whenflagclicked" id="hat" x="0" y="0">
      <comment id="c1">note</comment>
    </block>
  </xml>`)
  assert.equal(back.blocks.hat.comment, 'c1')
  assert.deepEqual(back.blocks, wire.blocks)
})

test('drops a dangling top-level id instead of inventing a block', () => {
  const back = engineToFragment({ blocks: [], topLevelIds: ['ghost'] })
  assert.deepEqual(back.topLevelIds, [])
  assert.deepEqual(back.blocks, {})
})

test('represents a top-level primitive the way a project document does', () => {
  // A reporter dragged onto the canvas: the engine keeps it as a shadow block with
  // coordinates, the wire form keeps it as a bare array whose id slot is the FIELD
  // id, not the block's map key. (This direction only — fragmentToEngine refuses
  // top-level primitives, because the engine form needs a real block for them.)
  const back = engineToFragment({
    blocks: [{
      id: 'reporterKey',
      opcode: 'data_variable',
      next: null,
      parent: null,
      inputs: {},
      fields: { VARIABLE: { name: 'VARIABLE', value: 'score', id: 'v1', variableType: '' } },
      shadow: true,
      topLevel: true,
      x: 120,
      y: 240
    }],
    topLevelIds: ['reporterKey']
  })
  assert.deepEqual(back.blocks.reporterKey, [12, 'score', 'v1', 120, 240])
  assert.deepEqual(back.topLevelIds, ['reporterKey'])
})

test('leaves a top-level primitive alone even when something points at it', () => {
  // Guarding against the tempting shortcut of inlining every primitive shadow: one
  // that is also top-level owns a place on the canvas.
  const back = engineToFragment({
    blocks: [
      {
        id: 'standalone',
        opcode: 'math_number',
        next: null,
        parent: null,
        inputs: {},
        fields: { NUM: { name: 'NUM', value: '5' } },
        shadow: true,
        topLevel: true,
        x: 10,
        y: 20
      }
    ],
    topLevelIds: ['standalone']
  })
  assert.deepEqual(back.blocks.standalone, [4, '5', 10, 20])
  assert.deepEqual(back.topLevelIds, ['standalone'])
})
