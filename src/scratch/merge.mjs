/**
 * Merging one project into another — the missing piece of multi-agent work.
 *
 * Several writers on one Scratch project naturally end up as several `.sb3` files, one
 * per author, each owning a few sprites. The merge is then "take this sprite's scripts
 * from there", and doing it by hand on `project.json` goes wrong in two ways that are
 * both invisible until much later:
 *
 *   - replacing a sprite's `blocks` without its `variables`/`lists` leaves every
 *     sprite-local reference dangling. In one delivery that was 374 references, and the
 *     project still opened and still ran: the reporters just read nothing;
 *   - the sprite's costumes and sounds are references into the ARCHIVE. Replacing the
 *     lists without copying the images produces a project that opens with blank
 *     sprites, or does not open at all.
 *
 * This module does both halves together, and reports what it changed so the caller can
 * check the result instead of trusting it.
 */

/** Raised when a merge cannot be carried out as asked. */
export class MergeError extends Error {
  constructor (message) {
    super(message)
    this.name = 'MergeError'
  }
}

/** Read an asset name off a costume/sound record, tolerating the legacy property name. */
const md5extOf = (entry) => {
  const value = entry?.md5ext ?? entry?.md5
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Shallow-clone a target's blocks and comments so a merge never aliases its source. */
const copyScriptState = (target) => ({
  blocks: structuredClone(target.blocks ?? {}),
  comments: structuredClone(target.comments ?? {})
})

/**
 * Merge `source` into `destination`, in place.
 *
 * @param {any} destination the project document to merge INTO (mutated)
 * @param {any} source the project document to take sprites from (not mutated)
 * @param {{targets?: string[], mode?: 'replace'|'scripts', sourceAssets?: Map<string, any>, assets?: Map<string, any>}} [options] merge options
 * @returns {{taken: {target: string, blocks: number, variables: number, lists: number, costumes: number, sounds: number}[], added: string[], missing: string[], globals: {variables: string[], lists: string[], broadcasts: string[]}, assetsCopied: number, warnings: string[]}} what happened
 * @throws {MergeError} when neither project is usable
 */
export const mergeProjects = (destination, source, options = {}) => {
  if (!Array.isArray(destination?.targets)) throw new MergeError('the destination project has no targets array')
  if (!Array.isArray(source?.targets)) throw new MergeError('the source project has no targets array')

  const mode = options.mode ?? 'replace'
  const assets = options.assets ?? new Map()
  const sourceAssets = options.sourceAssets ?? new Map()
  const wanted = Array.isArray(options.targets) && options.targets.length > 0 ? options.targets : null

  const destinationStage = destination.targets.find((target) => target.isStage === true)
  const sourceStage = source.targets.find((target) => target.isStage === true)
  if (destinationStage === undefined) throw new MergeError('the destination project has no stage')
  if (sourceStage === undefined) throw new MergeError('the source project has no stage')

  const warnings = []
  const taken = []
  const added = []
  const missing = []
  let assetsCopied = 0

  const needed = new Set()

  for (const sourceTarget of source.targets) {
    if (sourceTarget.isStage === true) continue
    if (wanted !== null && !wanted.includes(sourceTarget.name)) continue

    const destinationTarget = destination.targets.find((target) => target.isStage !== true && target.name === sourceTarget.name)
    if (destinationTarget === undefined) {
      // A sprite the destination does not have is ADDED whole, rather than silently
      // dropped: "this writer owns a new actor" is the normal case in a merge.
      const clone = structuredClone(sourceTarget)
      destination.targets.push(clone)
      added.push(clone.name)
      for (const entry of [...(clone.costumes ?? []), ...(clone.sounds ?? [])]) {
        const md5ext = md5extOf(entry)
        if (md5ext !== null) needed.add(md5ext)
      }
      continue
    }

    const scripts = copyScriptState(sourceTarget)
    destinationTarget.blocks = scripts.blocks
    destinationTarget.comments = scripts.comments

    let variables = 0
    let lists = 0
    let costumes = 0
    let sounds = 0

    if (mode === 'replace') {
      // The two halves that have to travel together. A sprite's own variables are the
      // ones its scripts reference by id; taking the blocks without them is what makes
      // a merge look successful and behave like nothing was copied.
      destinationTarget.variables = structuredClone(sourceTarget.variables ?? {})
      destinationTarget.lists = structuredClone(sourceTarget.lists ?? {})
      variables = Object.keys(destinationTarget.variables).length
      lists = Object.keys(destinationTarget.lists).length

      // Costumes and sounds are archive references, so the lists AND the bytes move.
      destinationTarget.costumes = structuredClone(sourceTarget.costumes ?? [])
      destinationTarget.sounds = structuredClone(sourceTarget.sounds ?? [])
      costumes = (destinationTarget.costumes ?? []).length
      sounds = (destinationTarget.sounds ?? []).length
      for (const entry of [...(destinationTarget.costumes ?? []), ...(destinationTarget.sounds ?? [])]) {
        const md5ext = md5extOf(entry)
        if (md5ext !== null) needed.add(md5ext)
      }
    }

    taken.push({ target: destinationTarget.name, blocks: Object.keys(scripts.blocks).length, variables, lists, costumes, sounds })
  }

  for (const name of wanted ?? []) {
    if (source.targets.some((target) => target.name === name && target.isStage !== true)) continue
    if (destination.targets.some((target) => target.name === name && target.isStage !== true)) continue
    missing.push(name)
  }

  // Globals live on the stage and belong to the whole project, so they are UNIONED by
  // id rather than replaced: two writers each adding their own global is normal, and
  // replacing would delete the other's. A same-id-different-name collision is reported
  // because one of the two names is about to become wrong everywhere it is used.
  const globals = { variables: [], lists: [], broadcasts: [] }
  const mergeMap = (sourceMap, destinationMap, label, isBroadcast) => {
    const names = []
    for (const [id, entry] of Object.entries(sourceMap ?? {})) {
      if (Object.hasOwn(destinationMap, id)) {
        const before = Array.isArray(destinationMap[id]) ? destinationMap[id][0] : destinationMap[id]
        const after = Array.isArray(entry) ? entry[0] : entry
        if (String(before) !== String(after)) {
          warnings.push(`${label} ${id} is "${before}" in the destination and "${after}" in the source; the destination's name was kept`)
        }
        continue
      }
      destinationMap[id] = structuredClone(entry)
      names.push(isBroadcast ? String(entry) : String(Array.isArray(entry) ? entry[0] : entry))
    }
    return names
  }

  globals.variables = mergeMap(sourceStage.variables, destinationStage.variables ?? (destinationStage.variables = {}), 'global variable', false)
  globals.lists = mergeMap(sourceStage.lists, destinationStage.lists ?? (destinationStage.lists = {}), 'global list', false)
  globals.broadcasts = mergeMap(sourceStage.broadcasts, destinationStage.broadcasts ?? (destinationStage.broadcasts = {}), 'broadcast', true)

  // Only the assets the merged content actually references are copied, so a merge does
  // not silently double the archive.
  for (const md5ext of needed) {
    if (assets.has(md5ext)) continue
    const bytes = sourceAssets.get?.(md5ext) ?? sourceAssets[md5ext]
    if (bytes === undefined) {
      warnings.push(`asset ${md5ext} is referenced by the merged content but is not in the source archive`)
      continue
    }
    assets.set(md5ext, bytes)
    assetsCopied++
  }

  return { taken, added, missing, globals, assetsCopied, warnings }
}

/**
 * Describe a merge for tool output.
 *
 * @param {ReturnType<typeof mergeProjects>} result the merge result
 * @param {string} from the source name, for the heading
 * @returns {string} the report
 */
export const formatMerge = (result, from) => {
  const lines = [`merged ${from}:`]
  for (const entry of result.taken) {
    lines.push(`  took ${entry.target}: ${entry.blocks} block(s)` +
      (entry.variables + entry.lists > 0 ? `, ${entry.variables} variable(s), ${entry.lists} list(s)` : '') +
      (entry.costumes > 0 ? `, ${entry.costumes} costume(s)` : '') +
      (entry.sounds > 0 ? `, ${entry.sounds} sound(s)` : ''))
  }
  if (result.added.length > 0) lines.push(`  added sprite(s): ${result.added.join(', ')}`)
  for (const [key, names] of Object.entries(result.globals)) {
    if (names.length > 0) lines.push(`  new global ${key}: ${names.join(', ')}`)
  }
  if (result.assetsCopied > 0) lines.push(`  copied ${result.assetsCopied} asset(s)`)
  if (result.taken.length === 0 && result.added.length === 0) lines.push('  nothing matched: no sprite name from the source is in the destination')
  if (result.missing.length > 0) lines.push(`  asked for but not found in the source: ${result.missing.join(', ')}`)
  for (const warning of result.warnings) lines.push(`  note: ${warning}`)
  return lines.join('\n')
}
