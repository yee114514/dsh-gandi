import test from 'node:test'
import assert from 'node:assert/strict'

import { compileScripts, decompileScripts } from '../src/scratch/xml.mjs'

/**
 * Script comments.
 *
 * A project document keeps comments on the TARGET, not in the block graph: each one
 * records the block it hangs off, and the block points back at it. The runtime's
 * `Blocks.toXML()` renders them from the comment objects it is handed
 * (`Comment.toXML`), and `emitWorkspaceUpdate` emits every comment TWICE — once at
 * the workspace level and once inside its block. These tests pin down that both
 * spellings are read, that they merge instead of duplicating, and that a comment
 * survives a round trip through the decompiler.
 */

const commentOf = (fragment, id) => fragment.comments.find((comment) => comment.id === id)

test('attaches a comment written inside a block', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" id="hat" x="100" y="200">
      <comment id="c1">start here</comment>
      <next><block type="motion_movesteps" id="move"/></next>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  assert.equal(fragment.blocks.hat.comment, 'c1')
  const comment = commentOf(fragment, 'c1')
  assert.equal(comment.blockId, 'hat')
  assert.equal(comment.text, 'start here')
  // Placed beside its script rather than at the workspace origin.
  assert.equal(comment.x, 340)
  assert.equal(comment.y, 200)
  assert.equal(comment.width, 200)
  assert.equal(comment.height, 200)
  assert.equal(comment.minimized, false)
})

test('honours explicit position and size, and the minimized flag', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" id="hat" x="0" y="0">
      <comment id="c1" x="10" y="20" w="300" h="90" minimized="true">note</comment>
    </block>
  </xml>`)
  const comment = commentOf(fragment, 'c1')
  assert.deepEqual(
    [comment.x, comment.y, comment.width, comment.height, comment.minimized],
    [10, 20, 300, 90, true]
  )
})

test('accepts width/height spelled out', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" id="hat" x="0" y="0">
      <comment id="c1" width="250" height="80">note</comment>
    </block>
  </xml>`)
  const comment = commentOf(fragment, 'c1')
  assert.equal(comment.width, 250)
  assert.equal(comment.height, 80)
})

test('a workspace-level comment with no block is kept', () => {
  const fragment = compileScripts(`<xml>
    <comment id="loose" x="500" y="40" pinned="false">a note on the canvas</comment>
    <block type="event_whenflagclicked" id="hat" x="0" y="0"/>
  </xml>`)
  assert.deepEqual(fragment.warnings, [])
  const comment = commentOf(fragment, 'loose')
  assert.equal(comment.blockId, null)
  assert.equal(comment.text, 'a note on the canvas')
  assert.equal(comment.x, 500)
})

test('the same comment emitted twice merges instead of duplicating', () => {
  // This is exactly what emitWorkspaceUpdate produces: every comment at the
  // workspace level, plus the attached ones again inside their block.
  const fragment = compileScripts(`<xml>
    <comment id="c1" x="340" y="200" w="200" h="200" pinned="true" minimized="false">attached note</comment>
    <comment id="c2" x="10" y="10" w="200" h="200" pinned="false" minimized="false">loose note</comment>
    <block type="event_whenflagclicked" id="hat" x="100" y="200">
      <comment id="c1" x="340" y="200" w="200" h="200" pinned="true" minimized="false">attached note</comment>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  assert.equal(fragment.comments.length, 2, JSON.stringify(fragment.comments))
  assert.equal(commentOf(fragment, 'c1').blockId, 'hat', 'the in-block copy decides the attachment')
  assert.equal(commentOf(fragment, 'c2').blockId, null)
  assert.equal(fragment.blocks.hat.comment, 'c1')
})

test('an in-block copy wins on text but keeps the position it did not repeat', () => {
  const fragment = compileScripts(`<xml>
    <comment id="c1" x="42" y="24" w="200" h="200">workspace text</comment>
    <block type="event_whenflagclicked" id="hat" x="0" y="0">
      <comment id="c1">the real text</comment>
    </block>
  </xml>`)
  const comment = commentOf(fragment, 'c1')
  assert.equal(comment.text, 'the real text')
  assert.equal(comment.x, 42, 'the position from the workspace copy survives')
  assert.equal(comment.y, 24)
})

test('generates an id when a comment has none', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" id="hat" x="0" y="0">
      <comment>no id here</comment>
    </block>
  </xml>`)
  assert.equal(fragment.warnings.length, 0)
  assert.equal(fragment.comments.length, 1)
  assert.equal(typeof fragment.comments[0].id, 'string')
  assert.equal(fragment.blocks.hat.comment, fragment.comments[0].id)
})

test('warns and renames when two comments share an id', () => {
  const fragment = compileScripts(`<xml>
    <block type="event_whenflagclicked" id="hat" x="0" y="0">
      <comment id="same">one</comment>
    </block>
    <block type="motion_movesteps" id="move" x="0" y="200">
      <comment id="same">two</comment>
    </block>
  </xml>`)
  assert.match(fragment.warnings.join('\n'), /duplicate comment id "same" renamed/)
  assert.equal(fragment.comments.length, 2)
  assert.notEqual(fragment.comments[0].id, fragment.comments[1].id)
  assert.equal(fragment.blocks.hat.comment, fragment.comments[0].id)
  assert.equal(fragment.blocks.move.comment, fragment.comments[1].id)
})

test('round-trips comments through the decompiler', () => {
  const first = compileScripts(`<xml>
    <comment id="loose" x="500" y="40" w="220" h="180" pinned="false" minimized="false">on the canvas</comment>
    <block type="event_whenflagclicked" id="hat" x="100" y="200">
      <comment id="c1" x="340" y="200" w="200" h="200" pinned="true" minimized="false">attached &amp; escaped</comment>
      <next><block type="motion_movesteps" id="move"/></next>
    </block>
  </xml>`)

  const rendered = decompileScripts(first)
  const second = compileScripts(rendered)

  assert.deepEqual(second.warnings, [], rendered)
  assert.deepEqual(second.blocks, first.blocks, rendered)
  assert.deepEqual(second.comments, first.comments, rendered)
  // The attached comment is rendered inside its block, the loose one at the top.
  assert.match(rendered, /<comment id="c1" x="340" y="200" w="200" h="200" pinned="true" minimized="false">attached &amp; escaped<\/comment>/)
  assert.match(rendered, /<comment id="loose" x="500" y="40" w="220" h="180" pinned="false" minimized="false">on the canvas<\/comment>/)
})

test('a comment whose block is missing from the fragment is not lost', () => {
  const rendered = decompileScripts({
    blocks: { a: { opcode: 'event_whenflagclicked', inputs: {}, fields: {}, comment: 'gone', topLevel: true, x: 0, y: 0 } },
    topLevelIds: ['a'],
    comments: [{ id: 'orphan', blockId: 'noSuchBlock', text: 'still here', x: 5, y: 6, width: 200, height: 200, minimized: false }]
  })
  assert.match(rendered, /<comment id="orphan"/)
  assert.match(rendered, /<!-- missing comment gone -->/)
})

test('compiles a project the editor itself emitted, comments and all', () => {
  // Shaped like emitWorkspaceUpdate: a variables section, every comment at the
  // workspace level, and the attached ones repeated inside their blocks.
  const fragment = compileScripts(`<xml xmlns="http://www.w3.org/1999/xhtml">
    <variables><variable id="v1" type="">score</variable></variables>
    <comment id="c1" x="340" y="200" w="200" h="200" pinned="true" minimized="false">tick</comment>
    <block type="event_whenflagclicked" id="hat" x="100" y="200">
      <comment id="c1" x="340" y="200" w="200" h="200" pinned="true" minimized="false">tick</comment>
      <next>
        <block type="data_setvariableto" id="set">
          <field name="VARIABLE" id="v1" variabletype="">score</field>
          <value name="VALUE"><shadow type="text"><field name="TEXT">1</field></shadow></value>
        </block>
      </next>
    </block>
  </xml>`)

  assert.deepEqual(fragment.warnings, [])
  assert.deepEqual(fragment.variables, [{ id: 'v1', name: 'score', type: '' }])
  assert.equal(fragment.comments.length, 1)
  assert.equal(fragment.blocks.set.fields.VARIABLE[1], 'v1')
  assert.equal(fragment.blocks.hat.comment, 'c1')
})
