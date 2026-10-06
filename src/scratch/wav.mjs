/**
 * Building WAV audio, so a project can get a sound without anyone shipping one.
 *
 * Scratch stores a sound as an asset plus `{rate, sampleCount, format}`. For
 * uncompressed PCM the format is the empty string and the rate/sampleCount are read
 * back out of the decoded buffer by the loader
 * (`scratch-vm/src/import/load-sound.js:30-31`), so all this module has to produce
 * is a well-formed RIFF/WAVE file.
 *
 * Synthesising here rather than asking for base64 audio is the whole point: a model
 * can say "a short rising blip" and get a real sound, and the result is deterministic
 * and testable without any audio hardware.
 */

/** Raised when a sound request cannot be turned into audio. */
export class WavError extends Error {
  constructor (message) {
    super(message)
    this.name = 'WavError'
  }
}

/** Sample rate of everything this module produces. */
export const SAMPLE_RATE = 48000

/**
 * Encode mono 16-bit PCM samples as a RIFF/WAVE file.
 *
 * @param {Float32Array|number[]} samples values in [-1, 1]
 * @param {{sampleRate?: number}} [options] encoding options
 * @returns {Buffer} WAV bytes
 */
export const encodeWav = (samples, options = {}) => {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE
  const frames = samples.length
  const dataBytes = frames * 2

  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // PCM chunk size
  header.writeUInt16LE(1, 20) // format: PCM
  header.writeUInt16LE(1, 22) // channels: mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)

  const body = Buffer.alloc(dataBytes)
  for (let index = 0; index < frames; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    // Asymmetric scaling: the negative range has one more step than the positive.
    body.writeInt16LE(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), index * 2)
  }

  return Buffer.concat([header, body])
}

/** Waveform generators, each mapping a phase in [0, 1) to [-1, 1]. */
const WAVEFORMS = {
  sine: (phase) => Math.sin(phase * 2 * Math.PI),
  square: (phase) => (phase < 0.5 ? 1 : -1),
  triangle: (phase) => 4 * Math.abs(phase - 0.5) - 1,
  sawtooth: (phase) => 2 * phase - 1
}

/** The waveforms a caller may ask for. */
export const WAVEFORM_NAMES = Object.freeze(Object.keys(WAVEFORMS))

/**
 * Synthesize a short tone.
 *
 * `sweepTo` glides the frequency across the sound, which is what turns a flat beep
 * into the "coin" / "jump" shapes games actually want. A short attack and release
 * are applied so the result does not click at the edges.
 *
 * @param {{frequency?: number, seconds?: number, waveform?: string, sweepTo?: number, volume?: number, sampleRate?: number}} [options] what to synthesize
 * @returns {Float32Array} samples in [-1, 1]
 * @throws {WavError} when a parameter is not usable
 */
export const synthesizeTone = (options = {}) => {
  const frequency = options.frequency ?? 440
  const seconds = options.seconds ?? 0.25
  const waveformName = options.waveform ?? 'sine'
  const volume = options.volume ?? 0.6
  const sampleRate = options.sampleRate ?? SAMPLE_RATE

  if (!Number.isFinite(frequency) || frequency <= 0) throw new WavError('frequency must be a positive number')
  if (!Number.isFinite(seconds) || seconds <= 0) throw new WavError('seconds must be a positive number')
  if (!Number.isFinite(volume) || volume <= 0 || volume > 1) throw new WavError('volume must be within (0, 1]')
  const waveform = WAVEFORMS[waveformName]
  if (waveform === undefined) throw new WavError(`waveform must be one of ${WAVEFORM_NAMES.join(', ')}`)
  const sweepTo = options.sweepTo
  if (sweepTo !== undefined && (!Number.isFinite(sweepTo) || sweepTo <= 0)) {
    throw new WavError('sweepTo must be a positive number')
  }

  const frames = Math.max(1, Math.round(seconds * sampleRate))
  const samples = new Float32Array(frames)
  // A 5 ms fade at each end removes the click a hard start/stop produces.
  const fadeFrames = Math.min(Math.floor(0.005 * sampleRate), Math.floor(frames / 2))

  let phase = 0
  for (let index = 0; index < frames; index++) {
    const progress = frames === 1 ? 0 : index / (frames - 1)
    const currentFrequency = sweepTo === undefined
      ? frequency
      : frequency + (sweepTo - frequency) * progress
    phase += currentFrequency / sampleRate
    phase -= Math.floor(phase)

    let envelope = 1
    if (fadeFrames > 0) {
      if (index < fadeFrames) envelope = index / fadeFrames
      else if (index >= frames - fadeFrames) envelope = (frames - 1 - index) / fadeFrames
    }
    samples[index] = waveform(phase) * volume * envelope
  }
  return samples
}

/**
 * Turn a sound request into WAV bytes.
 *
 * @param {{frequency?: number, seconds?: number, waveform?: string, sweepTo?: number, volume?: number, sampleRate?: number}} request what to synthesize
 * @returns {Buffer} WAV bytes
 */
export const synthesizeToneWav = (request = {}) => {
  const sampleRate = request.sampleRate ?? SAMPLE_RATE
  return encodeWav(synthesizeTone({ ...request, sampleRate }), { sampleRate })
}
