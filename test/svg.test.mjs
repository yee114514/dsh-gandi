import test from 'node:test'
import assert from 'node:assert/strict'

import { svgSize, defaultRotationCenter, assertLooksLikeSvg, SvgError } from '../src/scratch/svg.mjs'

test('reads explicit width and height', () => {
  assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"></svg>'), { width: 64, height: 48 })
})

test('accepts single quotes and decimal values', () => {
  assert.deepEqual(svgSize("<svg width='12.5' height='7.25'></svg>"), { width: 12.5, height: 7.25 })
})

test('falls back to the viewBox extent', () => {
  assert.deepEqual(svgSize('<svg viewBox="0 0 100 50"></svg>'), { width: 100, height: 50 })
  assert.deepEqual(svgSize('<svg viewBox="-20,-10,40,30"></svg>'), { width: 40, height: 30 })
})

test('prefers width and height over the viewBox', () => {
  assert.deepEqual(svgSize('<svg width="10" height="20" viewBox="0 0 100 50"></svg>'), { width: 10, height: 20 })
})

test('ignores percentage sizes, which have no intrinsic extent', () => {
  // "100%" must not be read as the number 100.
  assert.deepEqual(svgSize('<svg width="100%" height="100%" viewBox="0 0 32 16"></svg>'), { width: 32, height: 16 })
  assert.equal(svgSize('<svg width="100%" height="100%"></svg>'), null)
})

test('returns null when there is nothing to measure', () => {
  assert.equal(svgSize('<svg></svg>'), null)
  assert.equal(svgSize(''), null)
  assert.equal(svgSize(null), null)
  assert.equal(svgSize('<svg width="0" height="0"/>'), null)
})

test('measures the root element, not a nested shape', () => {
  // A nested <rect> must not be mistaken for the artwork's own size.
  assert.equal(svgSize('<svg><rect width="10" height="10"/></svg>'), null)
  assert.deepEqual(
    svgSize('<svg width="64" height="32"><rect width="10" height="10"/></svg>'),
    { width: 64, height: 32 }
  )
})

test('suggests the centre of the artwork as the rotation centre', () => {
  assert.deepEqual(defaultRotationCenter('<svg width="80" height="40"/>'), { x: 40, y: 20, derived: true })
})

test('falls back to the origin and says so when the size is unknown', () => {
  assert.deepEqual(defaultRotationCenter('<svg/>'), { x: 0, y: 0, derived: false })
})

test('accepts plausible SVG documents', () => {
  assert.doesNotThrow(() => assertLooksLikeSvg('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'))
  assert.doesNotThrow(() => assertLooksLikeSvg('<svg width="1" height="1"></svg>\n'))
})

test('rejects data that would install an invisible costume', () => {
  assert.throws(() => assertLooksLikeSvg('   '), SvgError)
  assert.throws(() => assertLooksLikeSvg('{"not":"svg"}'), /does not contain an <svg> element/)
  assert.throws(() => assertLooksLikeSvg('<svg><circle r="5"/>'), /not closed with <\/svg>/)
})
