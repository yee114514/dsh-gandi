import test from 'node:test'
import assert from 'node:assert/strict'

import { toDomKey, isPostableKey, knownKeyNames } from '../src/scratch/keys.mjs'

test('translates the friendly names a model actually writes', () => {
  assert.equal(toDomKey('space'), ' ')
  assert.equal(toDomKey('spacebar'), ' ')
  assert.equal(toDomKey('Space'), ' ')
  assert.equal(toDomKey('left'), 'ArrowLeft')
  assert.equal(toDomKey('right'), 'ArrowRight')
  assert.equal(toDomKey('up'), 'ArrowUp')
  assert.equal(toDomKey('down'), 'ArrowDown')
  assert.equal(toDomKey('enter'), 'Enter')
  assert.equal(toDomKey('esc'), 'Escape')
})

test('translates the Scratch key names, which postData would silently drop', () => {
  // These are the block-menu spellings. Posting them verbatim presses nothing,
  // because keyboard.js treats any unknown multi-character name as a modifier.
  assert.equal(toDomKey('left arrow'), 'ArrowLeft')
  assert.equal(toDomKey('up arrow'), 'ArrowUp')
})

test('passes DOM key values through unchanged', () => {
  assert.equal(toDomKey('ArrowLeft'), 'ArrowLeft')
  assert.equal(toDomKey('Enter'), 'Enter')
  assert.equal(toDomKey('PageDown'), 'PageDown')
})

test('accepts single characters, including a literal space', () => {
  assert.equal(toDomKey('a'), 'a')
  assert.equal(toDomKey('Z'), 'Z')
  assert.equal(toDomKey('7'), '7')
  assert.equal(toDomKey(' '), ' ')
})

test('rejects names that would press nothing', () => {
  for (const bad of ['fn', 'Meta', 'PrintScreen', 'a b c', '', '   ', null, undefined, 42]) {
    assert.equal(toDomKey(bad), '', `${JSON.stringify(bad)} should not be postable`)
    assert.equal(isPostableKey(bad), false)
  }
})

test('reports the spellings worth suggesting in an error', () => {
  const names = knownKeyNames()
  assert.ok(names.includes('space'))
  assert.ok(names.includes('left'))
  assert.ok(names.length > 10)
})
