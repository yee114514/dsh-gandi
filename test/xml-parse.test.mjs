import test from 'node:test'
import assert from 'node:assert/strict'

import {
  XmlParseError,
  parseXml,
  childElement,
  childElements,
  escapeXml
} from '../src/scratch/xml-parse.mjs'

const SCRIPT = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a scratch script -->
<xml xmlns="http://www.w3.org/1999/xhtml">
  <variables>
    <variable id="v1" type="">score</variable>
    <variable id="l1" type="list">items</variable>
  </variables>
  <block type="event_whenflagclicked" id="b1" x="52" y="48">
    <next>
      <block type="motion_movesteps" id="b2">
        <value name="STEPS">
          <shadow type="math_number" id="s1"><field name="NUM">10</field></shadow>
        </value>
        <next>
          <block type="looks_say" id="b3">
            <value name="MESSAGE">
              <shadow type="text" id="s2"><field name="TEXT">Hi</field></shadow>
            </value>
          </block>
        </next>
      </block>
    </next>
  </block>
</xml>`

test('parses a scratch script into a navigable tree', () => {
  const root = parseXml(SCRIPT)
  assert.equal(root.name, 'xml')
  // Namespace declarations are exposed as ordinary attributes.
  assert.equal(root.attributes.xmlns, 'http://www.w3.org/1999/xhtml')

  const variables = childElement(root, 'variables')
  assert.ok(variables, 'variables element is present')
  const declared = childElements(variables, 'variable')
  assert.equal(declared.length, 2)
  assert.deepEqual(
    declared.map((v) => [v.attributes.id, v.attributes.type, v.text]),
    [['v1', '', 'score'], ['l1', 'list', 'items']]
  )

  const hat = childElement(root, 'block')
  assert.equal(hat.attributes.type, 'event_whenflagclicked')
  assert.equal(hat.attributes.id, 'b1')
  assert.equal(hat.attributes.x, '52')

  const move = childElement(childElement(hat, 'next'), 'block')
  assert.equal(move.attributes.type, 'motion_movesteps')

  const steps = childElement(childElement(move, 'value'), 'shadow')
  assert.equal(steps.attributes.type, 'math_number')
  assert.equal(childElement(steps, 'field').text, '10')

  const say = childElement(childElement(move, 'next'), 'block')
  assert.equal(say.attributes.type, 'looks_say')
  assert.equal(childElement(childElement(childElement(say, 'value'), 'shadow'), 'field').text, 'Hi')
})

test('keeps field text verbatim, including significant whitespace', () => {
  const root = parseXml('<xml><block type="looks_say"><value name="MESSAGE">' +
    '<shadow type="text"><field name="TEXT">  two  spaces\nand a newline  </field></shadow>' +
    '</value></block></xml>')
  const field = childElement(childElement(childElement(childElement(root, 'block'), 'value'), 'shadow'), 'field')
  assert.equal(field.text, '  two  spaces\nand a newline  ')
})

test('ignores whitespace between elements but keeps it inside a field', () => {
  const root = parseXml('<xml>\n  <block type="a">\n    <field name="F">x</field>\n  </block>\n</xml>')
  assert.equal(root.text.trim(), '')
  assert.equal(childElement(childElement(root, 'block'), 'field').text, 'x')
})

test('decodes entities and character references in text and attributes', () => {
  const root = parseXml('<xml><block type="a" b="&lt;&amp;&gt;">' +
    '<field name="TEXT">&lt;tag&gt; &amp; &quot;quotes&quot; &apos;a&apos; &#65;&#x42;</field>' +
    '</block></xml>')
  assert.equal(root.children[0].attributes.b, '<&>')
  assert.equal(childElement(root.children[0], 'field').text, '<tag> & "quotes" \'a\' AB')
})

test('handles self-closing elements, comments, processing instructions and a DOCTYPE', () => {
  const root = parseXml('<!DOCTYPE xml><!-- lead --><?pi data?><xml>\n' +
    '  <!-- inner -->\n  <block type="a"/>\n  <block type="b"></block>\n</xml>')
  assert.equal(root.children.length, 2)
  assert.equal(root.children[0].children.length, 0)
  assert.equal(root.children[0].text, '')
})

test('accepts single-quoted attributes', () => {
  const root = parseXml("<xml><block type='motion_movesteps' id='b2'/></xml>")
  assert.equal(root.children[0].attributes.type, 'motion_movesteps')
})

test('reports malformed XML with an offset', () => {
  const cases = [
    ['<xml><block></xml>', /closed by/],
    ['<xml><block>', /unterminated/],
    ['<xml a=1></xml>', /not quoted/],
    ['<xml a></xml>', /has no value/],
    ['<xml>&nope;</xml>', /unknown entity/],
    ['<xml><![CDATA[x]]></xml>', /CDATA/],
    ['<xml/>trailing', /unexpected content/],
    ['   ', /no root element/],
    ['<xml><!-- unterminated </xml>', /unterminated comment/]
  ]
  for (const [source, pattern] of cases) {
    assert.throws(() => parseXml(source), (error) => {
      assert.ok(error instanceof XmlParseError, `${source} -> XmlParseError`)
      assert.match(error.message, pattern)
      assert.equal(typeof error.index, 'number')
      return true
    }, `expected a parse error for ${JSON.stringify(source)}`)
  }
})

test('rejects non-string input and misplaced names', () => {
  assert.throws(() => parseXml(null), TypeError)
  assert.throws(() => parseXml('<1bad/>'), XmlParseError)
})

test('escapes text for XML output', () => {
  assert.equal(escapeXml('a & b < c > d " e'), 'a &amp; b &lt; c &gt; d &quot; e')
})
