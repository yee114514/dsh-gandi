import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts } from '../src/scratch/xml.mjs'
import { fragmentToEngine, EngineConversionError } from '../src/scratch/engine.mjs'

/** Deterministic ids so materialised shadow blocks are nameable in assertions. */
const counterIds = () => {
  let n = 0
  return () => `prim${++n}`
}

test('converts a compiled fragment into engine blocks with the primitives materialised', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" id="hat" x="10" y="20">
      <next>
        <block type="motion_movesteps" id="move">
          <value name="STEPS"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
        </block>
      </next>
    </block>
  </xml>`)

  const engine = fragmentToEngine(fragment, { newId: counterIds() })
  const byId = Object.fromEntries(engine.blocks.map((block) => [block.id, block]))

  // Two authored blocks plus one materialised primitive shadow.
  assert.equal(engine.blocks.length, 3)
  assert.deepEqual(engine.topLevelIds, ['hat'])

  assert.equal(byId.hat.opcode, 'event_whenflagclicked')
  assert.equal(byId.hat.next, 'move')
  assert.equal(byId.hat.parent, null)
  assert.equal(byId.hat.topLevel, true)
  assert.equal(byId.hat.x, 10)
  assert.equal(byId.hat.y, 20)

  assert.equal(byId.move.parent, 'hat')
  assert.equal(byId.move.next, null)
  assert.equal(byId.move.topLevel, false)
  // Inputs are the engine shape: an object naming both sides, pointing at ids.
  assert.deepEqual(byId.move.inputs.STEPS, { name: 'STEPS', block: 'prim1', shadow: 'prim1' })

  const primitive = byId.prim1
  assert.equal(primitive.opcode, 'math_number')
  assert.equal(primitive.shadow, true)
  assert.equal(primitive.topLevel, false)
  assert.equal(primitive.parent, 'move')
  assert.deepEqual(primitive.fields.NUM, { name: 'NUM', value: '10' })
})

test('keeps a block with no shadow behind it as a null shadow', () => {
  const fragment = compileScripts(`<xml>
    <block type="looks_say" id="say" x="0" y="0">
      <value name="MESSAGE"><block type="operator_join" id="join"/></value>
    </block>
  </xml>`)
  const engine = fragmentToEngine(fragment)
  const say = engine.blocks.find((block) => block.id === 'say')
  assert.deepEqual(say.inputs.MESSAGE, { name: 'MESSAGE', block: 'join', shadow: null })
})

test('keeps an obscured shadow distinct from the block covering it', () => {
  const fragment = compileScripts(`<xml>
    <block type="motion_movesteps" id="move" x="0" y="0">
      <value name="STEPS">
        <block type="operator_add" id="add"/>
        <shadow type="math_number"><field name="NUM">10</field></shadow>
      </value>
    </block>
  </xml>`)
  const engine = fragmentToEngine(fragment, { newId: counterIds() })
  const move = engine.blocks.find((block) => block.id === 'move')
  assert.deepEqual(move.inputs.STEPS, { name: 'STEPS', block: 'add', shadow: 'prim1' })
  assert.equal(engine.blocks.find((block) => block.id === 'prim1').shadow, true)
})

test('materialises a non-primitive shadow without inventing a new block', () => {
  const fragment = compileScripts(`<xml>
    <block type="looks_switchcostumeto" id="switch" x="0" y="0">
      <value name="COSTUME">
        <shadow type="looks_costume" id="menu"><field name="COSTUME">costume1</field></shadow>
      </value>
    </block>
  </xml>`)
  const engine = fragmentToEngine(fragment, { newId: counterIds() })
  assert.equal(engine.blocks.length, 2, 'the shadow was already a real block in the fragment')
  const switchBlock = engine.blocks.find((block) => block.id === 'switch')
  assert.deepEqual(switchBlock.inputs.COSTUME, { name: 'COSTUME', block: 'menu', shadow: 'menu' })
  assert.equal(engine.blocks.find((block) => block.id === 'menu').shadow, true)
})

test('attaches variableType to fields that reference variables, lists and broadcasts', () => {
  const fragment = compileScripts(`<xml>
    <variables>
      <variable id="v1" type="">score</variable>
      <variable id="l1" type="list">items</variable>
      <variable id="b1" type="broadcast_msg">go</variable>
    </variables>
    <block type="data_setvariableto" id="set" x="0" y="0">
      <field name="VARIABLE" id="v1" variabletype="">score</field>
    </block>
    <block type="data_addtolist" id="add" x="0" y="200">
      <field name="LIST" id="l1" variabletype="list">items</field>
    </block>
    <block type="event_whenbroadcastreceived" id="when" x="0" y="400">
      <field name="BROADCAST_OPTION" id="b1" variabletype="broadcast_msg">go</field>
    </block>
  </xml>`)

  const engine = fragmentToEngine(fragment)
  const byId = Object.fromEntries(engine.blocks.map((block) => [block.id, block]))
  assert.deepEqual(byId.set.fields.VARIABLE, { name: 'VARIABLE', value: 'score', id: 'v1', variableType: '' })
  assert.deepEqual(byId.add.fields.LIST, { name: 'LIST', value: 'items', id: 'l1', variableType: 'list' })
  assert.deepEqual(byId.when.fields.BROADCAST_OPTION, { name: 'BROADCAST_OPTION', value: 'go', id: 'b1', variableType: 'broadcast_msg' })
})

test('gives materialised variable primitives their variableType too', () => {
  const fragment = compileScripts(`<xml>
    <variables><variable id="v1" type="">score</variable></variables>
    <block type="looks_say" id="say" x="0" y="0">
      <value name="MESSAGE">
        <shadow type="text"><field name="TEXT">x</field></shadow>
      </value>
      <value name="SECS">
        <shadow type="data_variable"><field name="VARIABLE" id="v1" variabletype="">score</field></shadow>
      </value>
    </block>
  </xml>`)
  const engine = fragmentToEngine(fragment, { newId: counterIds() })
  const variablePrimitive = engine.blocks.find((block) => block.opcode === 'data_variable')
  assert.ok(variablePrimitive, 'the data_variable primitive was materialised')
  assert.deepEqual(variablePrimitive.fields.VARIABLE, { name: 'VARIABLE', value: 'score', id: 'v1', variableType: '' })
})

test('carries a mutation through unchanged', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_call" id="call" x="0" y="0">
      <mutation proccode="jump %n" argumentids="[&quot;a1&quot;]" warp="true"></mutation>
    </block>
  </xml>`)
  const engine = fragmentToEngine(fragment)
  assert.deepEqual(engine.blocks[0].mutation, { proccode: 'jump %n', argumentids: '["a1"]', warp: 'true' })
})

test('refuses to convert a top-level primitive, which has no engine block of its own', () => {
  const fragment = compileScripts(`<xml>
    <variables><variable id="v1" type="">score</variable></variables>
    <block type="data_variable" id="reporter" x="10" y="10">
      <field name="VARIABLE" id="v1" variabletype="">score</field>
    </block>
  </xml>`)
  assert.throws(() => fragmentToEngine(fragment), (error) => {
    assert.ok(error instanceof EngineConversionError)
    assert.match(error.message, /top-level primitive/)
    assert.match(error.message, /whole-project load/)
    return true
  })
})

test('refuses an input that points at a block the fragment does not contain', () => {
  assert.throws(() => fragmentToEngine({
    blocks: { a: { opcode: 'motion_movesteps', inputs: { STEPS: [2, 'ghost'] }, fields: {}, topLevel: true } },
    topLevelIds: ['a']
  }), (error) => {
    assert.match(error.message, /references unknown block "ghost"/)
    return true
  })
})

test('refuses an input tag it does not understand', () => {
  assert.throws(() => fragmentToEngine({
    blocks: { a: { opcode: 'motion_movesteps', inputs: { STEPS: [9, 'x'] }, fields: {}, topLevel: true } },
    topLevelIds: ['a']
  }), /unknown tag 9/)
})
