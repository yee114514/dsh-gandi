/**
 * The load check.
 *
 * Each case here corresponds to a real project that would not open, or opened and
 * silently did nothing. The point of these tests is that the check can be trusted in
 * both directions: it must catch the breakage, and it must not cry wolf about a project
 * the editor is perfectly happy with (a false alarm here blocks a legitimate edit, since
 * `gandi_apply` reports this check).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { formatReport, verifyProject } from '../src/scratch/verify.mjs'

/** A minimal usable project: a stage with a backdrop and one sprite. */
const project = (spriteBlocks = {}, extra = {}) => ({
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: { globalScore: ['score', 0] },
      lists: {},
      broadcasts: { msg1: 'go' },
      blocks: {},
      comments: {},
      costumes: [{ name: 'backdrop1', md5ext: 'aaa.svg', dataFormat: 'svg', assetId: 'aaa' }],
      sounds: []
    },
    {
      isStage: false,
      name: '角色1',
      variables: {},
      lists: {},
      blocks: spriteBlocks,
      comments: {},
      costumes: [{ name: 'costume1', md5ext: 'bbb.svg', dataFormat: 'svg', assetId: 'bbb' }],
      sounds: [],
      ...extra
    }
  ],
  extensions: [],
  meta: { semver: '3.0.0', vm: '0.2.0', agent: '' }
})

/** A hat with a `next` chain, so a fixture is a real script rather than a loose block. */
const hat = (id, next, extra = {}) => ({
  [id]: { opcode: 'event_whenflagclicked', next, parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true, ...extra }
})

test('a clean project reports nothing', () => {
  const report = verifyProject(project({
    ...hat('hat', 'move'),
    move: {
      opcode: 'motion_movesteps',
      next: null,
      parent: 'hat',
      inputs: { STEPS: [1, [4, '10']] },
      fields: {},
      shadow: false,
      topLevel: false
    },
    clone: {
      opcode: 'control_create_clone_of',
      next: null,
      parent: null,
      inputs: { CLONE_OPTION: [1, 'cloneMenu'] },
      fields: {},
      shadow: false,
      topLevel: true
    },
    cloneMenu: {
      opcode: 'control_create_clone_of_menu',
      next: null,
      parent: 'clone',
      inputs: {},
      fields: { CLONE_OPTION: ['_myself_', null] },
      shadow: true,
      topLevel: false
    }
  }), { assets: new Map([['aaa.svg', Buffer.from('a')], ['bbb.svg', Buffer.from('b')]]) })
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.warnings, [])
  assert.equal(report.stats.sprites, 1)
  assert.equal(report.stats.scripts, 2)
})

test('an invented opcode is reported as the extension the editor will try to load', () => {
  // The file-level form of the bug that made a project unopenable: `broadcast_msg` is a
  // variable TYPE, and as a block opcode it becomes "Extension not found: broadcast".
  const report = verifyProject(project({
    send: {
      opcode: 'event_broadcast',
      next: null,
      parent: null,
      inputs: { BROADCAST_INPUT: [1, 'menu'] },
      fields: {},
      shadow: false,
      topLevel: true
    },
    menu: { opcode: 'broadcast_msg', next: null, parent: 'send', inputs: {}, fields: { BROADCAST_OPTION: ['go', 'msg1'] }, shadow: true, topLevel: false }
  }))
  assert.equal(report.errors.length, 1)
  assert.match(report.errors[0], /input BROADCAST_INPUT uses the shadow block broadcast_msg, but the editor expects event_broadcast_menu/)
  assert.match(report.errors[0], /broadcast_msg is a variable type/)
  assert.match(report.warnings.join('\n'), /"broadcast" prefix is not a Scratch category/)
})

test('a dropdown holding an inlined primitive is reported', () => {
  // The clone bug in a project file: the input holds a value, not a menu, so the block
  // reads no clone option and nothing is ever cloned.
  const report = verifyProject(project({
    clone: {
      opcode: 'control_create_clone_of',
      next: null,
      parent: null,
      inputs: { CLONE_OPTION: [1, [10, '_myself_']] },
      fields: {},
      shadow: false,
      topLevel: true
    }
  }))
  assert.match(report.errors.join('\n'), /holds an inlined primitive where the control_create_clone_of_menu dropdown belongs/)
})

test('a custom-block mutation missing the fields the editor reads is reported', () => {
  const report = verifyProject(project({
    call: {
      opcode: 'procedures_call',
      next: null,
      parent: null,
      inputs: {},
      fields: {},
      mutation: { proccode: '撞X', argumentids: '[]' },
      shadow: false,
      topLevel: true
    }
  }))
  assert.match(report.errors.join('\n'), /mutation.children is missing or not an array/)
})

test('a reference to a variable nothing declares is reported — the merge failure', () => {
  const report = verifyProject(project({
    set: {
      opcode: 'data_setvariableto',
      next: null,
      parent: null,
      inputs: { VALUE: [1, [10, '1']] },
      fields: { VARIABLE: ['lives', 'ghostId'] },
      shadow: false,
      topLevel: true
    },
    reporter: {
      opcode: 'data_variable',
      next: null,
      parent: null,
      inputs: {},
      fields: { VARIABLE: ['lives', 'ghostId'] },
      shadow: false,
      topLevel: false
    }
  }))
  const errors = report.errors.join('\n')
  assert.match(errors, /uses VARIABLE "lives" \(id ghostId\), which no variable, list or broadcast in this project declares/)
})

test('an inlined variable reporter with an undeclared id is reported', () => {
  const report = verifyProject(project({
    say: {
      opcode: 'looks_say',
      next: null,
      parent: null,
      inputs: { MESSAGE: [1, [12, 'score', 'globalScore']] },
      fields: {},
      shadow: false,
      topLevel: true
    },
    other: {
      opcode: 'looks_say',
      next: null,
      parent: null,
      inputs: { MESSAGE: [1, [12, 'missing', 'nope']] },
      fields: {},
      shadow: false,
      topLevel: true
    }
  }))
  const errors = report.errors.join('\n')
  assert.match(errors, /inlined data_variable "missing" \(id nope\) is not declared/)
  assert.doesNotMatch(errors, /"score"/, 'a declared global resolves — the stage declares it')
})

test('an input pointing at a block that is not there is reported', () => {
  const report = verifyProject(project({
    move: {
      opcode: 'motion_movesteps',
      next: 'ghost',
      parent: null,
      inputs: { STEPS: [2, 'nowhere'] },
      fields: {},
      shadow: false,
      topLevel: true
    }
  }))
  const errors = report.errors.join('\n')
  assert.match(errors, /input STEPS points at block nowhere, which does not exist/)
  assert.match(errors, /continues into block ghost, which does not exist/)
})

test('an asset the archive does not contain is reported', () => {
  const report = verifyProject(project({}), { assets: new Map([['aaa.svg', Buffer.from('a')]]) })
  assert.match(report.errors.join('\n'), /costume "costume1" references asset bbb.svg, which is not in the archive/)
})

test('a target with no costume at all is reported', () => {
  // scratch-parser refuses such a project outright: "should NOT have fewer than 1 items".
  const document = project({})
  document.targets[1].costumes = []
  assert.match(verifyProject(document).errors.join('\n'), /no costume at all/)
})

test('unreachable blocks are a note, not an error', () => {
  // Deleting a script leaves its children behind; the editor ignores them, so refusing
  // the project over them would be wrong.
  const report = verifyProject(project({
    ...hat('hat', null),
    orphan: { opcode: 'motion_movesteps', next: null, parent: 'gone', inputs: {}, fields: {}, shadow: false, topLevel: false }
  }))
  assert.deepEqual(report.errors, [])
  assert.match(report.notes.join('\n'), /1 block\(s\) are not reachable from any script/)
})

test('the formatted report leads with the problems and stays readable', () => {
  const report = verifyProject(project({
    send: {
      opcode: 'event_broadcast',
      next: null,
      parent: null,
      inputs: { BROADCAST_INPUT: [1, 'menu'] },
      fields: {},
      shadow: false,
      topLevel: true
    },
    menu: { opcode: 'broadcast_msg', next: null, parent: 'send', inputs: {}, fields: {}, shadow: true, topLevel: false }
  }))
  const text = formatReport(report, { heading: 'load check' })
  assert.match(text, /^load check\nerrors \(1\):/)
  assert.match(text, /^ {2}- /m)
})

test('a document that is not a project is refused, not crashed on', () => {
  assert.match(verifyProject({}).errors.join('\n'), /no targets array/)
  assert.match(verifyProject({ targets: [{ isStage: false, name: 'x' }] }).errors.join('\n'), /no stage target/)
})
