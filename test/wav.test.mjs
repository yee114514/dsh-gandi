import test from 'node:test'
import assert from 'node:assert/strict'

import { WAVEFORM_NAMES, WavError, SAMPLE_RATE, encodeWav, synthesizeTone, synthesizeToneWav } from '../src/scratch/wav.mjs'

/** Read the fields a WAV reader would. */
const parseWav = (buffer) => ({
  riff: buffer.toString('ascii', 0, 4),
  riffSize: buffer.readUInt32LE(4),
  wave: buffer.toString('ascii', 8, 12),
  fmt: buffer.toString('ascii', 12, 16),
  audioFormat: buffer.readUInt16LE(20),
  channels: buffer.readUInt16LE(22),
  sampleRate: buffer.readUInt32LE(24),
  byteRate: buffer.readUInt32LE(28),
  blockAlign: buffer.readUInt16LE(32),
  bitsPerSample: buffer.readUInt16LE(34),
  data: buffer.toString('ascii', 36, 40),
  dataSize: buffer.readUInt32LE(40),
  frames: buffer.readUInt32LE(40) / 2,
  sampleAt: (index) => buffer.readInt16LE(44 + index * 2)
})

test('encodes a header a WAV reader will accept', () => {
  const wav = encodeWav(new Float32Array(100))
  const parsed = parseWav(wav)

  assert.equal(parsed.riff, 'RIFF')
  assert.equal(parsed.wave, 'WAVE')
  assert.equal(parsed.fmt, 'fmt ')
  assert.equal(parsed.data, 'data')
  assert.equal(parsed.audioFormat, 1, 'PCM')
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.bitsPerSample, 16)
  assert.equal(parsed.sampleRate, SAMPLE_RATE)
  assert.equal(parsed.byteRate, SAMPLE_RATE * 2)
  assert.equal(parsed.blockAlign, 2)
  assert.equal(parsed.frames, 100)
  assert.equal(wav.length, 44 + 200)
  // The declared sizes must match the bytes actually present.
  assert.equal(parsed.dataSize, 200)
  assert.equal(parsed.riffSize, wav.length - 8)
})

test('honours a custom sample rate', () => {
  const wav = encodeWav(new Float32Array(10), { sampleRate: 22050 })
  assert.equal(parseWav(wav).sampleRate, 22050)
})

test('converts floats to signed 16-bit samples', () => {
  const wav = encodeWav([0, 1, -1, 0.5])
  const parsed = parseWav(wav)
  assert.equal(parsed.sampleAt(0), 0)
  assert.equal(parsed.sampleAt(1), 32767)
  assert.equal(parsed.sampleAt(2), -32768)
  assert.equal(parsed.sampleAt(3), Math.round(0.5 * 32767))
})

test('clamps samples that would overflow the format', () => {
  const parsed = parseWav(encodeWav([4, -4, 1.2, -1.7]))
  assert.equal(parsed.sampleAt(0), 32767)
  assert.equal(parsed.sampleAt(1), -32768)
  assert.equal(parsed.sampleAt(2), 32767)
  assert.equal(parsed.sampleAt(3), -32768)
})

test('synthesizes the requested duration at the requested rate', () => {
  const samples = synthesizeTone({ frequency: 440, seconds: 0.5, sampleRate: 8000 })
  assert.equal(samples.length, 4000)
})

test('a sine crosses zero about twice per cycle', () => {
  const frequency = 100
  const seconds = 1
  const sampleRate = 8000
  const samples = synthesizeTone({ frequency, seconds, sampleRate, waveform: 'sine', volume: 1 })
  let crossings = 0
  for (let index = 1; index < samples.length; index++) {
    if ((samples[index - 1] < 0 && samples[index] >= 0) || (samples[index - 1] >= 0 && samples[index] < 0)) crossings++
  }
  // Two crossings per period, give or take the boundary.
  assert.ok(Math.abs(crossings - 2 * frequency) <= 2, `expected about ${2 * frequency} crossings, saw ${crossings}`)
})

test('fades the ends so the sound does not click', () => {
  const samples = synthesizeTone({ seconds: 0.1, sampleRate: 8000, volume: 1 })
  assert.equal(samples[0], 0, 'starts at silence')
  assert.equal(samples[samples.length - 1], 0, 'ends at silence')
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  assert.ok(peak > 0.9, `the body of the sound should be near full scale, peaked at ${peak}`)
})

test('a sweep moves the instantaneous frequency', () => {
  const rising = synthesizeTone({ frequency: 200, sweepTo: 800, seconds: 0.2, sampleRate: 8000, waveform: 'sine' })
  const countCrossings = (samples, from, to) => {
    let crossings = 0
    for (let index = from + 1; index < to; index++) {
      if ((samples[index - 1] < 0 && samples[index] >= 0) || (samples[index - 1] >= 0 && samples[index] < 0)) crossings++
    }
    return crossings
  }
  const half = Math.floor(rising.length / 2)
  const firstHalf = countCrossings(rising, 0, half)
  const secondHalf = countCrossings(rising, half, rising.length)
  assert.ok(secondHalf > firstHalf, `a rising sweep should speed up: ${firstHalf} then ${secondHalf}`)
})

test('every advertised waveform produces sound', () => {
  assert.deepEqual(WAVEFORM_NAMES, ['sine', 'square', 'triangle', 'sawtooth'])
  for (const waveform of WAVEFORM_NAMES) {
    const samples = synthesizeTone({ waveform, seconds: 0.05, sampleRate: 8000 })
    const peak = samples.reduce((highest, sample) => Math.max(highest, Math.abs(sample)), 0)
    assert.ok(peak > 0.5, `${waveform} should produce a signal, peaked at ${peak}`)
  }
})

test('rejects parameters that would produce nonsense', () => {
  assert.throws(() => synthesizeTone({ frequency: 0 }), WavError)
  assert.throws(() => synthesizeTone({ seconds: -1 }), WavError)
  assert.throws(() => synthesizeTone({ volume: 2 }), WavError)
  assert.throws(() => synthesizeTone({ waveform: 'wobble' }), /waveform must be one of/)
  assert.throws(() => synthesizeTone({ sweepTo: 0 }), /sweepTo must be a positive number/)
})

test('synthesizeToneWav produces a playable file with the right frame count', () => {
  const wav = synthesizeToneWav({ frequency: 523.25, seconds: 0.2, waveform: 'triangle' })
  const parsed = parseWav(wav)
  assert.equal(parsed.sampleRate, SAMPLE_RATE)
  assert.equal(parsed.frames, Math.round(0.2 * SAMPLE_RATE))
  assert.equal(wav.length, 44 + parsed.frames * 2)
  assert.ok(parsed.frames > 9000)
})
