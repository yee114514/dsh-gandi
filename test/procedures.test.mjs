import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts, decompileScripts } from '../src/scratch/xml.mjs'

/**
 * Custom blocks ("my blocks").
 *
 * Scratch spells one out three times over — a definition, a prototype shadow
 * holding the mutation, and a call per use site — and matches arguments between
 * them by id, stored as a JSON string inside a mutation attribute. Writing that by
 * hand is the single most error-prone thing in this whole dialect, so the compiler
 * accepts a short form and expands it. These tests pin down the expansion, and pin
 * down that the fully spelled-out form is left exactly as written.
 *
 * The expected shapes come from the editor itself: see tools/spike-procedures.mjs,
 * which loads a custom block and prints what Blocks.toXML() produces from it.
 */

const definitionOf = (fragment) => {
  const prototypeId = fragment.blocks.def.inputs.custom_block[1]
  return fragment.blocks[prototypeId]
}

test('expands the short form into a full prototype mutation', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="10" y="20">
      <mutation proccode="jump %n %s" argumentnames="height,message" argumentdefaults="10,hi" warp="false"></mutation>
      <next>
        <block type="motion_movesteps" id="body">
          <value name="STEPS">
            <block type="argument_reporter_string_number" id="reporter">
              <field name="VALUE">height</field>
            </block>
          </value>
        </block>
      </next>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  const prototype = definitionOf(fragment)
  assert.equal(prototype.opcode, 'procedures_prototype')
  assert.equal(prototype.shadow, true)
  assert.equal(prototype.parent, 'def')

  const mutation = prototype.mutation
  assert.equal(mutation.proccode, 'jump %n %s')
  assert.equal(mutation.warp, 'false')
  assert.equal(mutation.tagName, 'mutation')
  assert.deepEqual(mutation.children, [])

  const ids = JSON.parse(mutation.argumentids)
  assert.equal(ids.length, 2)
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0), ids.join(','))
  assert.equal(new Set(ids).size, 2, 'argument ids must be distinct')
  assert.deepEqual(JSON.parse(mutation.argumentnames), ['height', 'message'])
  assert.deepEqual(JSON.parse(mutation.argumentdefaults), ['10', 'hi'])
})

test('generates placeholder names when the proccode has arguments but no names', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="0" y="0">
      <mutation proccode="go %n %b"></mutation>
    </block>
  </xml>`)
  assert.deepEqual(JSON.parse(definitionOf(fragment).mutation.argumentnames), ['arg1', 'arg2'])
  assert.deepEqual(JSON.parse(definitionOf(fragment).mutation.argumentdefaults), ['', ''])
})

test('keeps a fully spelled-out prototype exactly as written', () => {
  const xml = `<xml>
    <block type="procedures_definition" id="def" x="0" y="0">
      <value name="custom_block">
        <shadow type="procedures_prototype" id="proto">
          <mutation proccode="jump %n" argumentids="[&quot;argId1&quot;]" argumentnames="[&quot;height&quot;]" argumentdefaults="[&quot;10&quot;]" warp="true"></mutation>
        </shadow>
      </value>
    </block>
  </xml>`
  const fragment = compileScripts(xml)
  assert.deepEqual(fragment.warnings, [])
  const prototype = fragment.blocks.proto
  assert.equal(prototype.mutation.argumentids, '["argId1"]', 'given ids must survive')
  assert.equal(prototype.mutation.warp, 'true')
  // The definition must not grow a second prototype.
  assert.equal(fragment.blocks.def.inputs.custom_block[1], 'proto')
  assert.equal(Object.values(fragment.blocks).filter((b) => b.opcode === 'procedures_prototype').length, 1)
})

test('resolves a call whose inputs are named by argument name', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="0" y="0">
      <mutation proccode="jump %n" argumentnames="height"></mutation>
    </block>
    <block type="event_whenflagclicked" id="hat" x="0" y="200">
      <next>
        <block type="procedures_call" id="call">
          <mutation proccode="jump %n"></mutation>
          <value name="height"><shadow type="math_number"><field name="NUM">25</field></shadow></value>
        </block>
      </next>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  const id = JSON.parse(definitionOf(fragment).mutation.argumentids)[0]
  assert.deepEqual(Object.keys(fragment.blocks.call.inputs), [id], 'the input is renamed to the argument id')
  assert.deepEqual(fragment.blocks.call.inputs[id], [1, [4, '25']])
  assert.equal(fragment.blocks.call.mutation.argumentids, JSON.stringify([id]))
  assert.equal(fragment.blocks.call.mutation.proccode, 'jump %n')
  // A call mutation carries no names or defaults — those are the prototype's.
  assert.equal(fragment.blocks.call.mutation.argumentnames, undefined)
})

test('accepts call inputs already addressed by id', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="0" y="0">
      <value name="custom_block">
        <shadow type="procedures_prototype" id="proto">
          <mutation proccode="jump %n" argumentids="[&quot;a1&quot;]" argumentnames="[&quot;height&quot;]" argumentdefaults="[&quot;&quot;]" warp="false"></mutation>
        </shadow>
      </value>
    </block>
    <block type="procedures_call" id="call" x="0" y="200">
      <mutation proccode="jump %n" argumentids="[&quot;a1&quot;]"></mutation>
      <value name="a1"><shadow type="math_number"><field name="NUM">7</field></shadow></value>
    </block>
  </xml>`)
  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(Object.keys(fragment.blocks.call.inputs), ['a1'])
  assert.equal(fragment.blocks.call.mutation.argumentids, '["a1"]')
})

test('two calls to the same block get the same argument ids', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="0" y="0">
      <mutation proccode="teleport %n %n" argumentnames="x,y"></mutation>
    </block>
    <block type="procedures_call" id="one" x="0" y="200">
      <mutation proccode="teleport %n %n"></mutation>
      <value name="x"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
      <value name="y"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
    </block>
    <block type="procedures_call" id="two" x="0" y="300">
      <mutation proccode="teleport %n %n"></mutation>
      <value name="x"><shadow type="math_number"><field name="NUM">3</field></shadow></value>
      <value name="y"><shadow type="math_number"><field name="NUM">4</field></shadow></value>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  const ids = JSON.parse(definitionOf(fragment).mutation.argumentids)
  assert.deepEqual(Object.keys(fragment.blocks.one.inputs), ids)
  assert.deepEqual(Object.keys(fragment.blocks.two.inputs), ids)
  assert.equal(fragment.blocks.one.mutation.argumentids, fragment.blocks.two.mutation.argumentids)
})

test('round-trips a custom block through the decompiler', () => {
  const first = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="40" y="40">
      <mutation proccode="jump %n and say %s" argumentnames="height,words" argumentdefaults="10,hi"></mutation>
      <next>
        <block type="motion_movesteps" id="body">
          <value name="STEPS">
            <block type="argument_reporter_string_number" id="reporter">
              <field name="VALUE">height</field>
            </block>
            <shadow type="math_number"><field name="NUM">10</field></shadow>
          </value>
        </block>
      </next>
    </block>
    <block type="event_whenflagclicked" id="hat" x="40" y="300">
      <next>
        <block type="procedures_call" id="call">
          <mutation proccode="jump %n and say %s"></mutation>
          <value name="height"><shadow type="math_number"><field name="NUM">25</field></shadow></value>
          <value name="words"><shadow type="text"><field name="TEXT">go</field></shadow></value>
        </block>
      </next>
    </block>
  </xml>`)

  const rendered = decompileScripts(first)
  const second = compileScripts(rendered)

  assert.deepEqual(second.warnings, [], rendered)
  assert.deepEqual(second.blocks, first.blocks, rendered)
  assert.deepEqual(second.topLevelIds, first.topLevelIds)
  // The rendered form is Scratch's own spelling, so it can be read back by a person.
  assert.match(rendered, /<shadow type="procedures_prototype" id="[^"]+">/)
  assert.match(rendered, /argumentnames="\[&quot;height&quot;,&quot;words&quot;\]"/)
  assert.match(rendered, /<field name="VALUE">height<\/field>/)
})

test('warns about a definition with no proccode', () => {
  const fragment = compileScripts('<xml><block type="procedures_definition" id="def" x="0" y="0"/></xml>')
  assert.equal(fragment.warnings.length, 1)
  assert.match(fragment.warnings[0], /custom block def has no mutation proccode/)
})

test('warns about a call that cannot resolve its argument ids', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_call" id="call" x="0" y="0">
      <mutation proccode="nowhere %n"></mutation>
    </block>
  </xml>`)
  assert.equal(fragment.warnings.length, 1)
  assert.match(fragment.warnings[0], /call to "nowhere %n" has no matching definition/)
})

test('a call with ids but no definition in the fragment is left alone', () => {
  // Legitimate: the definition may already exist in the target (append mode).
  const fragment = compileScripts(`<xml>
    <block type="procedures_call" id="call" x="0" y="0">
      <mutation proccode="already %n there" argumentids="[&quot;a1&quot;]" warp="false"></mutation>
      <value name="a1"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
    </block>
  </xml>`)
  assert.deepEqual(fragment.warnings, [])
  assert.equal(fragment.blocks.call.mutation.argumentids, '["a1"]')
})

test('warns when the declared argument lists do not match the proccode', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="0" y="0">
      <mutation proccode="three %n %n %n" argumentnames="onlyone"></mutation>
    </block>
  </xml>`)
  assert.match(fragment.warnings.join('\n'), /argumentnames has 1 entries but the proccode has 3 placeholder\(s\)/)
  // ...and still produces a usable block.
  assert.deepEqual(JSON.parse(definitionOf(fragment).mutation.argumentnames), ['arg1', 'arg2', 'arg3'])
})

test('warns when one proccode is defined twice', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="first" x="0" y="0">
      <mutation proccode="same %n" argumentnames="a"></mutation>
    </block>
    <block type="procedures_definition" id="second" x="0" y="200">
      <mutation proccode="same %n" argumentnames="a"></mutation>
    </block>
  </xml>`)
  assert.match(fragment.warnings.join('\n'), /"same %n" is defined more than once/)
})

test('honours warp', () => {
  const fragment = compileScripts(`<xml>
    <block type="procedures_definition" id="def" x="0" y="0">
      <mutation proccode="run %n" argumentnames="times" warp="true"></mutation>
    </block>
    <block type="procedures_call" id="call" x="0" y="200">
      <mutation proccode="run %n"></mutation>
      <value name="times"><shadow type="math_number"><field name="NUM">4</field></shadow></value>
    </block>
  </xml>`)
  assert.deepEqual(fragment.warnings, [])
  assert.equal(definitionOf(fragment).mutation.warp, 'true')
  assert.equal(fragment.blocks.call.mutation.warp, 'true', 'the call has to agree about warp')
})
