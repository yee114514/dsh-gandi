/**
 * Extension blocks in the compiler.
 *
 * An extension's dialect is NOT in the generated table: an opcode like
 * `music_playDrumForBeats` only exists once the extension is loaded into a running
 * editor, so it arrives per call as the `dialect` option (read by
 * `bridge/extensions.mjs`). These tests pin both halves of that:
 *
 *   - with the dialect in hand the compiler judges the block exactly as it judges a core
 *     one — input names, statement inputs and dropdown shadows — so a wrong shadow is
 *     refused BEFORE it reaches an editor;
 *   - without it, the block is left alone. That is not laziness: rejecting a block whose
 *     shape cannot be known offline would break every project that uses an extension.
 *
 * The shapes here are copied from a real editor's `runtime._blockInfo` for Gandi's music
 * and pen extensions (docs/gandi-spike.md §21), including the two details that took a
 * probe to find: `info.arguments` is an OBJECT keyed by argument name, and a menu's
 * shadow type comes from the generated block JSON's own `type` field.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts, decompileScripts, extensionsOfBlocks, extensionsOfFragment, ScriptCompileError } from '../src/scratch/xml.mjs'
import { formatExtensionCatalogue, formatExtensionDialect } from '../src/bridge/extensions.mjs'

/** A deterministic id generator so a recompile can be compared exactly. */
const counterIds = () => {
  let n = 0
  return () => `gen${++n}`
}

/** The `music` extension as the editor describes it (abridged to the blocks used here). */
const MUSIC = {
  id: 'music',
  name: '音乐',
  blocks: [
    {
      opcode: 'music_restForBeats',
      bareOpcode: 'restForBeats',
      blockType: 'command',
      text: '休止[BEATS]拍',
      valueInputs: ['BEATS'],
      statementInputs: [],
      menuInputs: {},
      fields: ['BEATS']
    },
    {
      opcode: 'music_playDrumForBeats',
      bareOpcode: 'playDrumForBeats',
      blockType: 'command',
      text: '击打 [DRUM] [BEATS] 拍',
      valueInputs: ['DRUM', 'BEATS'],
      statementInputs: [],
      menuInputs: { DRUM: 'music_menu_DRUM' },
      fields: ['DRUM', 'BEATS']
    }
  ],
  menus: [{ shadow: 'music_menu_DRUM', field: 'DRUM', firstOption: '(1) 小军鼓', optionCount: 18 }]
}

test('an extension block is compiled as named, prefix and all', () => {
  const fragment = compileScripts(`<xml>
    <block type="music_restForBeats" id="rest" x="0" y="0">
      <value name="BEATS"><shadow type="math_number" id="n"><field name="NUM">0.5</field></shadow></value>
    </block>
  </xml>`, { dialect: [MUSIC] })

  assert.deepEqual(fragment.warnings, [])
  assert.equal(fragment.blocks.rest.opcode, 'music_restForBeats')
  assert.deepEqual(fragment.blocks.rest.inputs, { BEATS: [1, [4, '0.5']] })
  assert.deepEqual(fragment.dialectIds, ['music'])
  assert.deepEqual(extensionsOfFragment(fragment), ['music'])
})

test('with the dialect loaded, an extension dropdown is held to the editor\'s own shadow', () => {
  const good = compileScripts(`<xml>
    <block type="music_playDrumForBeats" id="play" x="0" y="0">
      <value name="DRUM"><shadow type="music_menu_DRUM" id="m"><field name="DRUM">3</field></shadow></value>
      <value name="BEATS"><shadow type="math_number" id="n"><field name="NUM">0.5</field></shadow></value>
    </block>
  </xml>`, { dialect: [MUSIC] })
  assert.deepEqual(good.warnings, [])
  // A non-primitive shadow is a real block referenced by id, never inlined.
  assert.deepEqual(good.blocks.play.inputs.DRUM, [1, 'm'])
  assert.equal(good.blocks.m.opcode, 'music_menu_DRUM')
  assert.equal(good.blocks.m.shadow, true)
  assert.deepEqual(good.blocks.m.fields, { DRUM: ['3'] })

  // The wrong shadow: this is the failure that is silent in an editor (a dropdown that
  // reads nothing) and unopenable in a file (an opcode read as an extension id).
  assert.throws(
    () => compileScripts(`<xml>
      <block type="music_playDrumForBeats" id="play" x="0" y="0">
        <value name="DRUM"><shadow type="looks_costume" id="m"><field name="COSTUME">x</field></shadow></value>
      </block>
    </xml>`, { dialect: [MUSIC] }),
    (error) => {
      assert.ok(error instanceof ScriptCompileError)
      assert.match(error.message, /takes the dropdown <shadow type="music_menu_DRUM">/)
      assert.match(error.message, /looks_costume belongs under looks_switchcostumeto\.COSTUME/)
      return true
    }
  )

  // ...and an extension menu used somewhere it does not belong is named as the
  // extension's own, because the dialect knows where it goes.
  assert.throws(
    () => compileScripts(`<xml>
      <block type="music_restForBeats" id="rest" x="0" y="0">
        <value name="BEATS"><shadow type="music_menu_DRUM" id="m"><field name="DRUM">3</field></shadow></value>
      </block>
    </xml>`, { dialect: [MUSIC] }),
    /music_menu_DRUM, which belongs under music_playDrumForBeats\.DRUM/
  )

  // The right shadow type with the wrong field name is refused too: the dropdown then has
  // no value selected, which reads as "the first drum" and looks like a working script.
  assert.throws(
    () => compileScripts(`<xml>
      <block type="music_playDrumForBeats" id="play" x="0" y="0">
        <value name="DRUM"><shadow type="music_menu_DRUM" id="m"><field name="WRONG">3</field></shadow></value>
      </block>
    </xml>`, { dialect: [MUSIC] }),
    /needs <field name="DRUM">/
  )
})

test('without the dialect an extension block is written as named, and never judged', () => {
  // This is the offline path: no editor to ask, so the shape is unknowable. The block
  // still compiles — a .sb3 that uses an extension is a completely normal file, and the
  // editor loads the extension from the opcode prefix when it opens it.
  const fragment = compileScripts(`<xml>
    <block type="music_playDrumForBeats" id="play" x="0" y="0">
      <value name="DRUM"><shadow type="music_menu_DRUM" id="m"><field name="DRUM">3</field></shadow></value>
    </block>
  </xml>`)
  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(extensionsOfFragment(fragment), ['music'])
})

test('an extension block that declares a statement input takes a script there', () => {
  // Statement inputs come from the block's own text ("%1 {SUBSTACK} %2"), so a repeat
  // block from an extension takes SUBSTACK as a script and everything else as a value.
  const LOOPY = {
    id: 'demo',
    name: 'demo',
    blocks: [{
      opcode: 'demo_repeat',
      blockType: 'loop',
      text: 'repeat %1 {SUBSTACK} %2',
      valueInputs: ['TIMES'],
      statementInputs: ['SUBSTACK'],
      menuInputs: {},
      fields: ['TIMES']
    }],
    menus: []
  }
  const fragment = compileScripts(`<xml>
    <block type="demo_repeat" id="loop" x="0" y="0">
      <value name="TIMES"><shadow type="math_number" id="n"><field name="NUM">3</field></shadow></value>
      <statement name="SUBSTACK">
        <block type="music_restForBeats" id="body">
          <value name="BEATS"><shadow type="math_number" id="b"><field name="NUM">1</field></shadow></value>
        </block>
      </statement>
    </block>
  </xml>`, { dialect: [LOOPY] })
  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(fragment.blocks.loop.inputs.SUBSTACK, [2, 'body'])

  // A value where the block wants a script is a warning, exactly as for a core block.
  const loose = compileScripts(`<xml>
    <block type="demo_repeat" id="loop" x="0" y="0">
      <value name="SUBSTACK"><shadow type="math_number" id="n"><field name="NUM">3</field></shadow></value>
    </block>
  </xml>`, { dialect: [LOOPY] })
  assert.match(loose.warnings.join('\n'), /that input holds a script; use <statement>/)
})

test('the dialect only ever widens what is accepted', () => {
  // A core block with a wrong shadow is still refused with an extension loaded: the
  // dialect adds opcodes, it does not replace the generated table.
  assert.throws(
    () => compileScripts(`<xml>
      <block type="control_create_clone_of" id="clone" x="0" y="0">
        <value name="CLONE_OPTION"><shadow type="looks_costume" id="c"><field name="COSTUME">_myself_</field></shadow></value>
      </block>
    </xml>`, { dialect: [MUSIC] }),
    /takes the dropdown <shadow type="control_create_clone_of_menu">/
  )
})

test('extension blocks survive a read-modify-write round trip', () => {
  const xml = `<xml>
    <block type="music_playDrumForBeats" id="play" x="0" y="0">
      <value name="DRUM"><shadow type="music_menu_DRUM" id="m"><field name="DRUM">3</field></shadow></value>
      <value name="BEATS"><shadow type="math_number" id="n"><field name="NUM">0.5</field></shadow></value>
    </block>
  </xml>`
  const first = compileScripts(xml, { dialect: [MUSIC] })
  const rendered = decompileScripts(first)
  const second = compileScripts(rendered, { dialect: [MUSIC], newId: counterIds() })
  // Ids are regenerated by the second compile only where the first left them out; both
  // compiles see the same ids here, so the fragments must be identical.
  assert.deepEqual(second.blocks, first.blocks)
  assert.match(rendered, /<block type="music_playDrumForBeats"/)
  assert.match(rendered, /<shadow type="music_menu_DRUM"[^>]*>/)
})

test('extensions are read off opcode prefixes, and core opcodes are not extensions', () => {
  const ids = extensionsOfBlocks({
    a: { opcode: 'motion_movesteps' },
    b: { opcode: 'music_restForBeats' },
    c: { opcode: 'text_setText' },
    d: { opcode: 'GandiAIHub_run' },
    e: { opcode: 'music_getTempo' },
    f: [12, 'score', 'scoreId'],
    g: { opcode: 'pen_penDown' }
  })
  assert.deepEqual(ids, ['music', 'GandiAIHub', 'pen'])
})

/**
 * The tool output IS the documentation for an extension: SKILL.md tells an author to copy
 * the field name and the dropdown values out of it, so the format is a contract, not
 * decoration. These tests pin the two things an author cannot guess — the menu's FIELD
 * name (which differs from the input name: `pen_menu_colorParam` carries `colorParam`)
 * and a real option to put in it. A dialect listing that omitted them would leave the
 * author writing `<field name="COLOR_PARAM">` and silently getting the first option.
 */
test('the dialect output names each menu\'s field and a real option to put in it', () => {
  const text = formatExtensionDialect({
    id: 'pen',
    name: '画笔',
    blocks: [
      {
        opcode: 'pen_setPenColorParamTo',
        text: 'set pen [COLOR_PARAM] to [VALUE]',
        valueInputs: ['COLOR_PARAM', 'VALUE'],
        statementInputs: [],
        menuInputs: { COLOR_PARAM: 'pen_menu_colorParam' },
        fields: ['COLOR_PARAM', 'VALUE']
      },
      {
        opcode: 'pen_clear',
        text: 'erase all',
        valueInputs: [],
        statementInputs: [],
        menuInputs: {},
        fields: []
      }
    ],
    menus: [
      // The field name is NOT the input name here — that is the whole point.
      { shadow: 'pen_menu_colorParam', field: 'colorParam', firstOption: '颜色', optionCount: 4, guessed: false }
    ]
  })

  assert.match(text, /pen_setPenColorParamTo/)
  // The input line carries the shadow type AND its field, so the author cannot copy the
  // shadow and then guess the field wrong.
  assert.match(text, /COLOR_PARAM \(dropdown <shadow type="pen_menu_colorParam"><field name="colorParam">\)/)
  assert.match(text, /<shadow type="pen_menu_colorParam"><field name="colorParam"> — e\.g\. "颜色" \(4 options\)/)
  // A block with no inputs still shows its shape, so an author can tell it apart.
  assert.match(text, /shape: erase all/)
})

test('a menu whose field the editor did not declare is called out instead of guessed', () => {
  const text = formatExtensionDialect({
    id: 'demo',
    name: null,
    blocks: [{
      opcode: 'demo_go',
      text: null,
      valueInputs: ['WHICH'],
      statementInputs: ['SUBSTACK'],
      menuInputs: { WHICH: 'demo_menu_WHICH' },
      fields: ['WHICH']
    }],
    menus: [{ shadow: 'demo_menu_WHICH', field: null, firstOption: null, optionCount: 0, guessed: true }]
  })
  assert.match(text, /statement inputs: SUBSTACK/)
  assert.match(text, /field name="\?"/)
  assert.match(text, /whose field name the editor did not declare/)
})

test('the catalogue marks device-backed extensions, because loading one opens a device', () => {
  const text = formatExtensionCatalogue({
    available: true,
    loadedIds: ['music'],
    builtinIds: ['pen'],
    catalogue: [
      { id: 'music', kind: 'official', nameKey: 'music.name', featured: true, deviceBacked: false },
      { id: 'GandiKamera', kind: 'official', nameKey: 'GandiKamera.name', featured: true, deviceBacked: true },
      { id: 'hidden', kind: 'official', nameKey: null, disabled: true, deviceBacked: false }
    ]
  })
  assert.match(text, /\*\s+music/)
  assert.match(text, /GandiKamera.*\[uses a device\]/)
  // The warning line names the ids, and the disabled entry is not offered at all.
  assert.match(text, /loading it opens your camera or microphone/)
  assert.match(text, /GandiKamera/)
  assert.doesNotMatch(text, /hidden/)
})
