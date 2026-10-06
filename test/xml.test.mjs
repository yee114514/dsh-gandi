import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts, ScriptCompileError, randomBlockId } from '../src/scratch/xml.mjs'

/** Deterministic id generator so assertions can name generated ids. */
const counterIds = () => {
  let n = 0
  return () => `gen${++n}`
}

test('compiles a hat block with a primitive input into the sb3 input protocol', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" id="hat" x="50" y="60">
      <next>
        <block type="motion_movesteps" id="move">
          <value name="STEPS">
            <shadow type="math_number" id="s1"><field name="NUM">10</field></shadow>
          </value>
        </block>
      </next>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(fragment.topLevelIds, ['hat'])
  assert.deepEqual(fragment.blocks, {
    hat: {
      opcode: 'event_whenflagclicked',
      next: 'move',
      parent: null,
      inputs: {},
      fields: {},
      shadow: false,
      topLevel: true,
      x: 50,
      y: 60
    },
    move: {
      opcode: 'motion_movesteps',
      next: null,
      parent: 'hat',
      // [1, [4, "10"]]: an unobscured primitive shadow, inlined.
      inputs: { STEPS: [1, [4, '10']] },
      fields: {},
      shadow: false,
      topLevel: false
    }
  })
})

test('encodes a block obscuring a primitive shadow as [3, id, primitive]', () => {
  const fragment = compileScripts(`<xml>
    <block type="motion_movesteps" id="move" x="0" y="0">
      <value name="STEPS">
        <block type="operator_add" id="add">
          <value name="NUM1"><shadow type="math_number" id="n1"><field name="NUM">1</field></shadow></value>
          <value name="NUM2"><shadow type="math_number" id="n2"><field name="NUM">2</field></shadow></value>
        </block>
        <shadow type="math_number" id="s1"><field name="NUM">10</field></shadow>
      </value>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(fragment.blocks.move.inputs, { STEPS: [3, 'add', [4, '10']] })
  assert.deepEqual(fragment.blocks.add.inputs, {
    NUM1: [1, [4, '1']],
    NUM2: [1, [4, '2']]
  })
  assert.equal(fragment.blocks.add.parent, 'move')
})

test('materialises a non-primitive shadow as a shadow block referenced by id', () => {
  const fragment = compileScripts(`<xml>
    <block type="looks_switchcostumeto" id="switch" x="0" y="0">
      <value name="COSTUME">
        <shadow type="looks_costume" id="menu">
          <field name="COSTUME">costume1</field>
        </shadow>
      </value>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(fragment.blocks.switch.inputs, { COSTUME: [1, 'menu'] })
  assert.deepEqual(fragment.blocks.menu, {
    opcode: 'looks_costume',
    next: null,
    parent: 'switch',
    inputs: {},
    fields: { COSTUME: ['costume1'] },
    shadow: true,
    topLevel: false
  })
  assert.deepEqual(fragment.topLevelIds, ['switch'])
})

test('encodes a statement input as [2, id] and chains inside it', () => {
  const fragment = compileScripts(`<xml>
    <block type="control_repeat" id="repeat" x="0" y="0">
      <value name="TIMES"><shadow type="math_whole_number" id="t"><field name="NUM">10</field></shadow></value>
      <statement name="SUBSTACK">
        <block type="motion_movesteps" id="move">
          <value name="STEPS"><shadow type="math_number" id="s"><field name="NUM">5</field></shadow></value>
        </block>
      </statement>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(fragment.blocks.repeat.inputs, {
    TIMES: [1, [6, '10']],
    SUBSTACK: [2, 'move']
  })
  assert.equal(fragment.blocks.move.parent, 'repeat')
  assert.equal(fragment.blocks.move.next, null)
})

test('keeps variable field ids and collects variable declarations', () => {
  const fragment = compileScripts(`<xml>
    <variables>
      <variable id="varId1" type="">score</variable>
      <variable id="listId1" type="list">items</variable>
      <variable id="msgId1" type="broadcast_msg">start</variable>
    </variables>
    <block type="data_setvariableto" id="set" x="0" y="0">
      <field name="VARIABLE" id="varId1" variabletype="">score</field>
      <value name="VALUE"><shadow type="text" id="t"><field name="TEXT">0</field></shadow></value>
    </block>
  </xml>`)

  assert.deepEqual(fragment.variables, [
    { id: 'varId1', name: 'score', type: '' },
    { id: 'listId1', name: 'items', type: 'list' },
    { id: 'msgId1', name: 'start', type: 'broadcast_msg' }
  ])
  assert.deepEqual(fragment.blocks.set.fields, { VARIABLE: ['score', 'varId1'] })
  assert.deepEqual(fragment.blocks.set.inputs, { VALUE: [1, [10, '0']] })
})

test('inlines a broadcast menu primitive with its message id', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenbroadcastreceived" id="when" x="0" y="0">
      <field name="BROADCAST_OPTION" id="msgId1" variabletype="broadcast_msg">start</field>
    </block>
    <block type="event_broadcast" id="send" x="0" y="200">
      <value name="BROADCAST_INPUT">
        <shadow type="event_broadcast_menu" id="menu">
          <field name="BROADCAST_OPTION" id="msgId1" variabletype="broadcast_msg">start</field>
        </shadow>
      </value>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  // [11, "start", "msgId1"] — the primitive constant for event_broadcast_menu is 11.
  assert.deepEqual(fragment.blocks.send.inputs, { BROADCAST_INPUT: [1, [11, 'start', 'msgId1']] })
})

test('keeps a top-level variable reporter as an inlined primitive array in the blocks map', () => {
  const fragment = compileScripts(`<xml>
    <variables><variable id="varId1" type="">score</variable></variables>
    <block type="data_variable" id="reporter" x="120" y="240">
      <field name="VARIABLE" id="varId1" variabletype="">score</field>
    </block>
  </xml>`)

  assert.deepEqual(fragment.topLevelIds, ['reporter'])
  // [12, "score", "varId1", x, y] — constant 12 is data_variable.
  assert.deepEqual(fragment.blocks.reporter, [12, 'score', 'varId1', 120, 240])
})

test('normalizes a mutation written on a custom block definition', () => {
  // A mutation on the definition is the short form: the compiler moves it onto the
  // procedures_prototype shadow it creates, which is where Scratch keeps it, and
  // fills in the attributes Scratch expects. test/procedures.test.mjs covers the
  // expansion in full; this checks the compiler does it at all.
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="0" y="0">
      <mutation proccode="jump %n times" argumentids="[&quot;argId1&quot;]" argumentnames="[&quot;times&quot;]" warp="false"></mutation>
      <next>
        <block type="procedures_call" id="call">
          <mutation proccode="jump %n times" argumentids="[&quot;argId1&quot;]" warp="false"></mutation>
        </block>
      </next>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  assert.equal(fragment.blocks.def.mutation, undefined, 'the definition should not carry the mutation')
  const prototypeId = fragment.blocks.def.inputs.custom_block[1]
  assert.equal(fragment.blocks[prototypeId].opcode, 'procedures_prototype')
  assert.equal(fragment.blocks[prototypeId].shadow, true)
  assert.deepEqual(fragment.blocks[prototypeId].mutation, {
    tagName: 'mutation',
    children: [],
    proccode: 'jump %n times',
    argumentids: '["argId1"]',
    argumentnames: '["times"]',
    argumentdefaults: '[""]',
    warp: 'false'
  })
  assert.equal(fragment.blocks.call.mutation.proccode, 'jump %n times')
  assert.equal(fragment.blocks.call.mutation.argumentids, '["argId1"]')
})

test('preserves significant whitespace in text fields', () => {
  const fragment = compileScripts(`<xml>
    <block type="looks_say" id="say" x="0" y="0">
      <value name="MESSAGE">
        <shadow type="text" id="t"><field name="TEXT">  line one
line two  </field></shadow>
      </value>
    </block>
  </xml>`)
  assert.deepEqual(fragment.blocks.say.inputs, { MESSAGE: [1, [10, '  line one\nline two  ']] })
})

test('accepts a bare block element as the document root', () => {
  const fragment = compileScripts('<block type="event_whenflagclicked" id="hat" x="1" y="2"/>')
  assert.deepEqual(fragment.topLevelIds, ['hat'])
  assert.equal(fragment.blocks.hat.topLevel, true)
  assert.equal(fragment.blocks.hat.x, 1)
})

test('rejects a root that is not a script fragment', () => {
  assert.throws(() => compileScripts('<nope/>'), ScriptCompileError)
})

test('generates ids for blocks that omit them', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" x="0" y="0">
      <next><block type="motion_movesteps"><value name="STEPS"><shadow type="math_number"><field name="NUM">1</field></shadow></value></block></next>
    </block>
  </xml>`, { newId: counterIds() })

  assert.deepEqual(fragment.topLevelIds, ['gen1'])
  assert.equal(fragment.blocks.gen1.next, 'gen2')
  assert.equal(fragment.blocks.gen2.opcode, 'motion_movesteps')
})

test('renames duplicate ids and warns', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" id="same" x="0" y="0"/>
    <block type="event_whenkeypressed" id="same" x="0" y="200"/>
  </xml>`, { newId: counterIds() })

  assert.equal(fragment.topLevelIds.length, 2)
  assert.equal(fragment.topLevelIds[0], 'same')
  assert.equal(fragment.topLevelIds[1], 'gen1')
  assert.ok(fragment.warnings.some((w) => /duplicate block id/.test(w)), fragment.warnings.join('; '))
})

test('warns about unusable pieces instead of throwing', () => {
  const fragment = compileScripts(`<xml>
    <block id="noType" x="0" y="0"/>
    <block type="looks_say" id="say" x="0" y="100">
      <value name="MESSAGE"><shadow type="text" id="t"><field name="WRONG">x</field></shadow></value>
      <value><shadow type="text" id="t2"><field name="TEXT">y</field></shadow></value>
      <field>x</field>
    </block>
  </xml>`)

  assert.equal(fragment.blocks.noType, undefined)
  assert.ok(fragment.warnings.some((w) => /without a type attribute/.test(w)))
  assert.ok(fragment.warnings.some((w) => /missing its <field name="TEXT">/.test(w)))
  assert.ok(fragment.warnings.some((w) => /<value> without a name/.test(w)))
  assert.ok(fragment.warnings.some((w) => /<field> without a name/.test(w)))
  // The malformed input was dropped rather than emitted half-formed.
  assert.deepEqual(fragment.blocks.say.inputs, {})
})

test('leaves positions off top-level blocks that declare none', () => {
  const fragment = compileScripts('<xml><block type="event_whenflagclicked" id="hat"/></xml>')
  assert.equal('x' in fragment.blocks.hat, false)
  assert.equal('y' in fragment.blocks.hat, false)
})

test('generated ids look like Blockly ids', () => {
  const id = randomBlockId()
  assert.match(id, /^[0-9A-Za-z]{20}$/)
  assert.notEqual(id, randomBlockId())
})
