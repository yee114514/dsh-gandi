/**
 * The compiler's dialect checks.
 *
 * Every case here is a bug a real delivery hit, and each one failed SILENTLY or
 * catastrophically rather than loudly:
 *
 *   - a broadcast dropdown written as `broadcast_msg` compiled into a block whose opcode
 *     the runtime read as an extension id, and the project stopped opening at all
 *     (`Extension not found: broadcast`);
 *   - a clone-object dropdown written as `looks_costume` compiled clean, reported no
 *     warnings, and then created no clones — the block read an argument nothing had set;
 *   - an input name that a block does not have was written to the archive and read by
 *     nobody.
 *
 * The table these checks use is generated from the editor's own toolbox flyout
 * (`src/scratch/menus.mjs`); this file asserts the behaviour that table buys.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts, decompileScripts, proceduresFromBlocks, ScriptCompileError } from '../src/scratch/xml.mjs'

/**
 * Compile, expecting the fragment to be refused.
 * @param {string} xml the fragment
 * @returns {string} the error message
 */
const refusal = (xml) => {
  try {
    compileScripts(xml)
  } catch (error) {
    assert.ok(error instanceof ScriptCompileError, `expected a ScriptCompileError, got ${error?.name}: ${error?.message}`)
    return error.message
  }
  throw new Error(`expected the compiler to refuse:\n${xml}`)
}

test('a broadcast dropdown spelled with a variable type is refused, and named', () => {
  // The exact mistake that cost a delivery a project that would not open.
  const message = refusal(`<xml>
    <block type="event_broadcast" id="send" x="0" y="0">
      <value name="BROADCAST_INPUT">
        <shadow type="broadcast_msg"><field name="BROADCAST_OPTION" id="m1">go</field></shadow>
      </value>
    </block>
  </xml>`)
  assert.match(message, /input BROADCAST_INPUT takes the dropdown <shadow type="event_broadcast_menu">, not type="broadcast_msg"/)
  assert.match(message, /`broadcast_msg` is the type of a broadcast VARIABLE in <variables>/)
})

test('the broadcast dropdown the editor actually uses inlines into [11, name, id]', () => {
  const fragment = compileScripts(`<xml>
    <variables><variable id="m1" type="broadcast_msg">go</variable></variables>
    <block type="event_broadcast" id="send" x="0" y="0">
      <value name="BROADCAST_INPUT">
        <shadow type="event_broadcast_menu"><field name="BROADCAST_OPTION" id="m1">go</field></shadow>
      </value>
    </block>
  </xml>`)
  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(fragment.blocks.send.inputs.BROADCAST_INPUT, [1, [11, 'go', 'm1']])
  // Nothing was materialised as a block of its own, which is what broke the project.
  assert.deepEqual(Object.keys(fragment.blocks), ['send'])
})

test('a clone dropdown written as a costume menu is refused, and the right one named', () => {
  // Compiled clean before: `create clone of` read no clone option and created nothing.
  const message = refusal(`<xml>
    <block type="control_create_clone_of" id="clone" x="0" y="0">
      <value name="CLONE_OPTION">
        <shadow type="looks_costume"><field name="COSTUME">_myself_</field></shadow>
      </value>
    </block>
  </xml>`)
  assert.match(message, /takes the dropdown <shadow type="control_create_clone_of_menu">, not type="looks_costume"/)
  assert.match(message, /looks_costume belongs under looks_switchcostumeto.COSTUME/)
})

test('the dropdown the editor uses for every menu input compiles', () => {
  const fragment = compileScripts(`<xml>
    <block type="control_create_clone_of" id="clone" x="0" y="0">
      <value name="CLONE_OPTION">
        <shadow type="control_create_clone_of_menu"><field name="CLONE_OPTION">_myself_</field></shadow>
      </value>
    </block>
    <block type="sensing_keypressed" id="key" x="0" y="100">
      <value name="KEY_OPTION">
        <shadow type="sensing_keyoptions"><field name="KEY_OPTION">space</field></shadow>
      </value>
    </block>
    <block type="sound_play" id="sound" x="0" y="200">
      <value name="SOUND_MENU">
        <shadow type="sound_sounds_menu"><field name="SOUND_MENU">跳跃</field></shadow>
      </value>
    </block>
    <block type="looks_switchbackdropto" id="back" x="0" y="300">
      <value name="BACKDROP">
        <shadow type="looks_backdrops"><field name="BACKDROP">背景1</field></shadow>
      </value>
    </block>
  </xml>`)
  assert.deepEqual(fragment.warnings, [])
  // A menu is a real shadow block, so the input refers to it by id and the block itself
  // lives in the same map — the shape the sb3 deserializer expects.
  assert.equal(fragment.blocks[fragment.blocks.clone.inputs.CLONE_OPTION[1]].opcode, 'control_create_clone_of_menu')
  assert.deepEqual(fragment.blocks[fragment.blocks.sound.inputs.SOUND_MENU[1]].fields.SOUND_MENU, ['跳跃'])
})

test('a menu shadow on an input that takes a value is refused', () => {
  const message = refusal(`<xml>
    <block type="motion_movesteps" id="move" x="0" y="0">
      <value name="STEPS">
        <shadow type="looks_costume"><field name="COSTUME">造型1</field></shadow>
      </value>
    </block>
  </xml>`)
  assert.match(message, /input STEPS does not take a dropdown, but its shadow is the menu looks_costume/)
})

test('an unknown shadow opcode is refused instead of written as an extension block', () => {
  const message = refusal(`<xml>
    <block type="motion_movesteps" id="move" x="0" y="0">
      <value name="STEPS">
        <shadow type="math_numer"><field name="NUM">10</field></shadow>
      </value>
    </block>
  </xml>`)
  assert.match(message, /is neither a primitive/)
  assert.match(message, /math_number/)
})

test('a dropdown shadow with the wrong field name is refused', () => {
  const message = refusal(`<xml>
    <block type="sensing_keypressed" id="key" x="0" y="0">
      <value name="KEY_OPTION">
        <shadow type="sensing_keyoptions"><field name="KEY">space</field></shadow>
      </value>
    </block>
  </xml>`)
  assert.match(message, /the sensing_keyoptions shadow needs <field name="KEY_OPTION">/)
})

test('an unknown input name on a known block is a warning', () => {
  const fragment = compileScripts(`<xml>
    <block type="motion_movesteps" id="move" x="0" y="0">
      <value name="STEP"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
    </block>
  </xml>`)
  assert.match(fragment.warnings.join('\n'), /motion_movesteps\) has no input named "STEP"/)
})

test('a field the block does not have is a warning, not a silent no-op', () => {
  // The dropdown names are the editor's, and some are easy to guess wrong:
  // `sensing_current` calls its field CURRENTMENU and `looks_backdropnumbername` calls
  // its NUMBER_NAME. A wrong name is stored in the archive and read by nobody.
  const fragment = compileScripts(`<xml>
    <block type="sensing_current" id="current" x="0" y="0">
      <field name="CURRENT_OPTION">YEAR</field>
    </block>
  </xml>`)
  assert.match(fragment.warnings.join('\n'), /sensing_current\) has no field named "CURRENT_OPTION"; its fields are "CURRENTMENU"/)

  const correct = compileScripts(`<xml>
    <block type="sensing_current" id="current" x="0" y="0">
      <field name="CURRENTMENU">YEAR</field>
    </block>
  </xml>`)
  assert.deepEqual(correct.warnings, [])
})

test('<value> on a statement input, and vice versa, are warnings', () => {
  const asValue = compileScripts(`<xml>
    <block type="control_forever" id="loop" x="0" y="0">
      <value name="SUBSTACK"><block type="motion_movesteps"><value name="STEPS"><shadow type="math_number"><field name="NUM">1</field></shadow></value></block></value>
    </block>
  </xml>`)
  assert.match(asValue.warnings.join('\n'), /<value name="SUBSTACK"> — that input holds a script; use <statement>/)

  const asStatement = compileScripts(`<xml>
    <block type="control_if" id="if" x="0" y="0">
      <statement name="CONDITION"><block type="operator_not"><value name="OPERAND"><block type="sensing_mousedown"/></value></block></statement>
    </block>
  </xml>`)
  assert.match(asStatement.warnings.join('\n'), /<statement name="CONDITION"> — that input holds a value; use <value>/)
})

test('a block this table has never seen is not judged', () => {
  // Extension blocks (and anything newer than the generated table) own their own inputs;
  // refusing them would break working projects.
  const fragment = compileScripts(`<xml>
    <block type="music_playDrumForBeats" id="drum" x="0" y="0">
      <value name="DRUM"><shadow type="music_menu_DRUM"><field name="DRUM">1</field></shadow></value>
      <value name="BEATS"><shadow type="math_number"><field name="NUM">0.25</field></shadow></value>
    </block>
  </xml>`)
  assert.deepEqual(fragment.warnings, [])
  assert.equal(fragment.blocks[fragment.blocks.drum.inputs.DRUM[1]].opcode, 'music_menu_DRUM')
})

test('every problem is reported at once, not one per attempt', () => {
  const message = refusal(`<xml>
    <block type="event_broadcast" id="send" x="0" y="0">
      <value name="BROADCAST_INPUT"><shadow type="broadcast_msg"><field name="BROADCAST_OPTION">go</field></shadow></value>
    </block>
    <block type="control_create_clone_of" id="clone" x="0" y="100">
      <value name="CLONE_OPTION"><shadow type="looks_costume"><field name="COSTUME">_myself_</field></shadow></value>
    </block>
  </xml>`)
  assert.match(message, /^2 problem\(s\) would make the project unusable:/)
  assert.match(message, /event_broadcast/)
  assert.match(message, /control_create_clone_of/)
})

test('the decompiler and the compiler agree about what is legal', () => {
  // The round trip is the contract: whatever `gandi_inspect` prints, `gandi_apply`
  // takes. If the checks above were stricter than the printer, reading a project and
  // writing it back would start failing.
  const fragment = compileScripts(`<xml>
    <variables>
      <variable id="v1" type="">score</variable>
      <variable id="m1" type="broadcast_msg">go</variable>
    </variables>
    <block type="event_whenflagclicked" id="hat" x="0" y="0">
      <next>
        <block type="event_broadcast" id="send">
          <value name="BROADCAST_INPUT"><shadow type="event_broadcast_menu"><field name="BROADCAST_OPTION" id="m1">go</field></shadow></value>
          <next><block type="control_create_clone_of" id="clone">
            <value name="CLONE_OPTION"><shadow type="control_create_clone_of_menu"><field name="CLONE_OPTION">_myself_</field></shadow></value>
            <next><block type="data_setvariableto" id="set">
              <field name="VARIABLE" id="v1">score</field>
              <value name="VALUE"><shadow type="text"><field name="TEXT">1</field></shadow></value>
            </block></next>
          </block></next>
        </block>
      </next>
    </block>
  </xml>`)
  const rendered = decompileScripts(fragment)
  const again = compileScripts(rendered)
  assert.deepEqual(again.warnings, [], rendered)
  assert.deepEqual(again.blocks, fragment.blocks, rendered)
})

test('proceduresFromBlocks collects the target definition a call needs', () => {
  // Read out of a project document, which is where an appended call gets its ids.
  const project = {
    targets: [{
      name: '角色1',
      blocks: {
        def: {
          opcode: 'procedures_definition',
          inputs: { custom_block: [1, 'proto'] },
          topLevel: true
        },
        proto: {
          opcode: 'procedures_prototype',
          shadow: true,
          mutation: {
            proccode: '跳跃 %n',
            argumentids: '["id1"]',
            argumentnames: '["高度"]',
            warp: 'false'
          }
        }
      }
    }]
  }
  const declarations = proceduresFromBlocks(project.targets[0].blocks)
  assert.deepEqual(declarations, [{
    proccode: '跳跃 %n',
    argumentids: '["id1"]',
    argumentnames: '["高度"]',
    warp: 'false'
  }])

  const fragment = compileScripts(`<xml>
    <block type="procedures_call" id="call" x="0" y="0">
      <mutation proccode="跳跃 %n"></mutation>
      <value name="高度"><shadow type="math_number"><field name="NUM">30</field></shadow></value>
    </block>
  </xml>`, { procedures: declarations })
  assert.deepEqual(fragment.warnings, [])
  assert.equal(fragment.blocks.call.mutation.argumentids, '["id1"]')
  assert.ok(fragment.blocks.call.inputs.id1)
})
