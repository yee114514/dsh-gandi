import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts, decompileScripts } from '../src/scratch/xml.mjs'

/**
 * Compile, render back to XML, compile again.
 *
 * The second fragment must equal the first: that is the property the offline path
 * depends on, because it is what makes "read a project, edit the text, write it
 * back" safe. Comparing the fragments rather than the XML text keeps the assertion
 * about meaning instead of formatting.
 */
const roundTrip = (xml) => {
  const first = compileScripts(xml)
  const rendered = decompileScripts(first)
  const second = compileScripts(rendered)
  return { first, rendered, second }
}

const expectStable = (xml) => {
  const { first, rendered, second } = roundTrip(xml)
  assert.deepEqual(first.warnings, [], 'the first compile should be clean')
  assert.deepEqual(second.warnings, [], `the recompile should be clean:\n${rendered}`)
  assert.deepEqual(second.blocks, first.blocks, `block graph changed on round trip:\n${rendered}`)
  assert.deepEqual(second.topLevelIds, first.topLevelIds)
  assert.deepEqual(second.variables, first.variables)
  return rendered
}

test('round-trips a next chain with an inlined primitive shadow', () => {
  const rendered = expectStable(`<xml>
    <block type="event_whenflagclicked" id="hat" x="50" y="60">
      <next>
        <block type="motion_movesteps" id="move">
          <value name="STEPS"><shadow type="math_number"><field name="NUM">10</field></shadow></value>
          <next>
            <block type="looks_say" id="say">
              <value name="MESSAGE"><shadow type="text"><field name="TEXT">hi</field></shadow></value>
            </block>
          </next>
        </block>
      </next>
    </block>
  </xml>`)
  assert.match(rendered, /<block type="event_whenflagclicked" id="hat" x="50" y="60">/)
  assert.match(rendered, /<shadow type="math_number">/)
})

test('round-trips all four input forms', () => {
  expectStable(`<xml>
    <block type="motion_movesteps" id="a" x="0" y="0">
      <value name="STEPS">
        <block type="operator_add" id="add">
          <value name="NUM1"><shadow type="math_number"><field name="NUM">1</field></shadow></value>
          <value name="NUM2"><shadow type="math_number"><field name="NUM">2</field></shadow></value>
        </block>
        <shadow type="math_number"><field name="NUM">10</field></shadow>
      </value>
    </block>
    <block type="looks_switchcostumeto" id="b" x="0" y="200">
      <value name="COSTUME">
        <shadow type="looks_costume" id="menu"><field name="COSTUME">costume1</field></shadow>
      </value>
    </block>
    <block type="looks_say" id="c" x="0" y="400">
      <value name="MESSAGE">
        <block type="operator_join" id="join"/>
      </value>
    </block>
  </xml>`)
})

test('round-trips statements, fields with ids, mutations and a top-level primitive', () => {
  const rendered = expectStable(`<xml>
    <variables>
      <variable id="v1" type="">score</variable>
      <variable id="l1" type="list">items</variable>
    </variables>
    <block type="control_repeat" id="loop" x="10" y="20">
      <value name="TIMES"><shadow type="math_whole_number"><field name="NUM">4</field></shadow></value>
      <statement name="SUBSTACK">
        <block type="data_setvariableto" id="set">
          <field name="VARIABLE" id="v1" variabletype="">score</field>
          <value name="VALUE"><shadow type="text"><field name="TEXT">1</field></shadow></value>
          <next>
            <block type="data_addtolist" id="add">
              <field name="LIST" id="l1" variabletype="list">items</field>
              <value name="ITEM"><shadow type="text"><field name="TEXT">x</field></shadow></value>
            </block>
          </next>
        </block>
      </statement>
    </block>
    <block type="procedures_call" id="call" x="0" y="300">
      <mutation proccode="jump %n" argumentids="[&quot;a1&quot;]" warp="false"></mutation>
    </block>
    <block type="data_variable" id="reporterKey" x="120" y="240">
      <field name="VARIABLE" id="v1" variabletype="">score</field>
    </block>
  </xml>`)
  assert.match(rendered, /<statement name="SUBSTACK">/)
  // The mutation comes back in the editor's own spelling: the compiler normalises what
  // it was handed, and `children` is an array the editor writes as an empty attribute.
  assert.match(rendered, /<mutation tagName="mutation" children="" proccode="jump %n"/)
  // The top-level primitive keeps its own map key AND its field id.
  assert.match(rendered, /<block type="data_variable" id="reporterKey" x="120" y="240">/)
  assert.match(rendered, /<field name="VARIABLE" id="v1">score<\/field>/)
})

test('is deterministic', () => {
  const xml = '<xml><block type="event_whenflagclicked" id="h" x="1" y="2"/></xml>'
  const fragment = compileScripts(xml)
  assert.equal(decompileScripts(fragment), decompileScripts(fragment))
})

test('generated ids survive the round trip', () => {
  const { first, second, rendered } = roundTrip(`<xml>
    <block type="event_whenflagclicked" x="0" y="0">
      <next><block type="motion_movesteps"><value name="STEPS"><shadow type="math_number"><field name="NUM">1</field></shadow></value></block></next>
    </block>
  </xml>`)
  assert.equal(first.topLevelIds.length, 1)
  assert.deepEqual(second.topLevelIds, first.topLevelIds, rendered)
  assert.equal(Object.keys(second.blocks).length, Object.keys(first.blocks).length)
})

test('renders a fragment with no scripts as an empty document', () => {
  const rendered = decompileScripts({ blocks: {}, topLevelIds: [], variables: [] })
  assert.equal(rendered, '<xml xmlns="http://www.w3.org/1999/xhtml">\n</xml>')
})

test('reports a dangling block instead of throwing', () => {
  const rendered = decompileScripts({
    blocks: { a: { opcode: 'motion_movesteps', inputs: { STEPS: [2, 'ghost'] }, fields: {}, topLevel: true } },
    topLevelIds: ['a']
  })
  assert.match(rendered, /<!-- missing block ghost -->/)
})

test('escapes content that would otherwise break the XML', () => {
  const rendered = decompileScripts(compileScripts(`<xml>
    <block type="looks_say" id="s" x="0" y="0">
      <value name="MESSAGE"><shadow type="text"><field name="TEXT">a &lt; b &amp; c "d"</field></shadow></value>
    </block>
  </xml>`))
  // Quotes are escaped too. That is not required inside element text, but it is
  // valid and it keeps one escaper for both text and attribute contexts.
  assert.match(rendered, /a &lt; b &amp; c &quot;d&quot;/)
  assert.doesNotMatch(rendered, /<field name="TEXT">a < b/)
  // The property that actually matters: it parses back to the same string.
  const reparsed = compileScripts(rendered)
  assert.deepEqual(reparsed.warnings, [])
  assert.deepEqual(reparsed.blocks.s.inputs, { MESSAGE: [1, [10, 'a < b & c "d"']] })
})
