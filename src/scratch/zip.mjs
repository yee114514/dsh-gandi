/**
 * A minimal ZIP reader/writer built on `node:zlib`.
 *
 * `.sb3` is a ZIP: `project.json` plus one file per asset, named `<md5>.<ext>`.
 * The plugin needs both directions (open a project the user already has; write
 * one the AI produced) and must not add an npm dependency to the DSH host
 * process, so this implements the slice of the format Scratch actually uses:
 *
 *   - stored (method 0) and deflate (method 8) entries,
 *   - UTF-8 entry names (general-purpose flag bit 11),
 *   - data-descriptor entries (sizes are read from the central directory, so
 *     streaming writers are handled correctly),
 *   - a fixed DOS timestamp by default, so writing the same project twice
 *     produces identical bytes and tests can compare them.
 *
 * Deliberately unsupported, and reported as errors rather than misread:
 * ZIP64, encryption, and multi-disk archives. Scratch never produces them.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** Raised for malformed or unsupported archives. */
export class ZipError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ZipError'
  }
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

const EOCD_MIN_SIZE = 22
/** An EOCD record can be followed by at most this many bytes of comment. */
const MAX_COMMENT = 0xffff

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** DOS date/time for 1980-01-01 00:00:00, the earliest representable value. */
const FIXED_DOS_TIME = 0
const FIXED_DOS_DATE = ((1980 - 1980) << 9) | (1 << 5) | 1

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * Compute the CRC-32 of a buffer, as ZIP requires.
 * @param {Uint8Array} bytes input
 * @returns {number} unsigned 32-bit checksum
 */
export const crc32 = (bytes) => {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Locate the End Of Central Directory record.
 * @param {Buffer} buffer the whole archive
 * @returns {number} offset of the record
 * @throws {ZipError} when no record is found
 */
const findEndOfCentralDirectory = (buffer) => {
  if (buffer.length < EOCD_MIN_SIZE) throw new ZipError('not a ZIP archive: too short')
  const earliest = Math.max(0, buffer.length - EOCD_MIN_SIZE - MAX_COMMENT)
  for (let offset = buffer.length - EOCD_MIN_SIZE; offset >= earliest; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  throw new ZipError('not a ZIP archive: no end-of-central-directory record')
}

/**
 * Read every entry of an archive into memory.
 *
 * @param {Uint8Array} input archive bytes
 * @returns {Map<string, Buffer>} entry name -> bytes, in central-directory order
 * @throws {ZipError} on a malformed or unsupported archive
 */
export function readZip (input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const eocd = findEndOfCentralDirectory(buffer)

  const entryCount = buffer.readUInt16LE(eocd + 10)
  const centralSize = buffer.readUInt32LE(eocd + 12)
  const centralOffset = buffer.readUInt32LE(eocd + 16)

  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported')
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new ZipError('central directory extends past the end of the archive')
  }

  /** @type {Map<string, Buffer>} */
  const entries = new Map()
  let cursor = centralOffset

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.length) throw new ZipError('central directory entry is truncated')
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`central directory entry ${index} has a bad signature`)
    }

    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const expectedCrc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)

    if ((flags & 0x1) !== 0) throw new ZipError('encrypted entries are not supported')
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('ZIP64 entries are not supported')
    }

    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    if (localOffset + 30 > buffer.length) throw new ZipError(`entry "${name}" has a local header past the end of the archive`)
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new ZipError(`entry "${name}" has a bad local header signature`)
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) throw new ZipError(`entry "${name}" is truncated`)

    const raw = buffer.subarray(dataStart, dataEnd)
    let data
    if (method === METHOD_STORE) {
      data = Buffer.from(raw)
    } else if (method === METHOD_DEFLATE) {
      try {
        data = inflateRawSync(raw)
      } catch (error) {
        throw new ZipError(`entry "${name}" failed to inflate: ${error.message}`)
      }
    } else {
      throw new ZipError(`entry "${name}" uses unsupported compression method ${method}`)
    }

    if (data.length !== uncompressedSize) {
      throw new ZipError(`entry "${name}" inflated to ${data.length} bytes, expected ${uncompressedSize}`)
    }
    if (crc32(data) !== expectedCrc) throw new ZipError(`entry "${name}" failed its CRC check`)

    entries.set(name, data)
  }

  return entries
}

/**
 * Build an archive from named entries.
 *
 * @param {Iterable<{name: string, data: Uint8Array}>} entries files to store
 * @param {{compress?: boolean, level?: number}} [options] `compress: false` stores everything uncompressed
 * @returns {Buffer} the archive bytes
 */
export function writeZip (entries, options = {}) {
  const compress = options.compress ?? true
  const level = options.level ?? 6

  /** @type {Buffer[]} */
  const parts = []
  /** @type {Buffer[]} */
  const centralRecords = []
  let offset = 0
  let count = 0

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const checksum = crc32(data)

    let method = METHOD_STORE
    let payload = data
    if (compress) {
      const deflated = deflateRawSync(data, { level })
      if (deflated.length < data.length) {
        method = METHOD_DEFLATE
        payload = deflated
      }
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_SIGNATURE, 0)
    local.writeUInt16LE(20, 4) // version needed to extract: 2.0
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(FIXED_DOS_TIME, 10)
    local.writeUInt16LE(FIXED_DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(FIXED_DOS_TIME, 12)
    central.writeUInt16LE(FIXED_DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30) // extra length
    central.writeUInt16LE(0, 32) // comment length
    central.writeUInt16LE(0, 34) // disk number
    central.writeUInt16LE(0, 36) // internal attributes
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)

    parts.push(local, nameBuffer, payload)
    centralRecords.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + payload.length
    count++

    if (count > 0xffff) throw new ZipError('too many entries for a non-ZIP64 archive')
  }

  const centralBuffer = Buffer.concat(centralRecords)
  const end = Buffer.alloc(EOCD_MIN_SIZE)
  end.writeUInt32LE(EOCD_SIGNATURE, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...parts, centralBuffer, end])
}
