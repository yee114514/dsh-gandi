/**
 * Reading a project document without an editor.
 *
 * Everything here works on the parsed `project.json` of a `.sb3`, so it needs no
 * running editor. It is the offline half of the plugin: the live path reads scripts
 * straight from the VM (`Blocks.toXML()`), while this path reconstructs the same XML
 * from the file.
 *
 * The shapes it has to know about come from the sb3 format rather than from any
 * runtime API:
 *
 *   - `targets[].blocks` maps block id -> block, and is ALREADY the compressed wire
 *     form the compiler emits (that is the point of having one IR).
 *   - `targets[].variables` and `targets[].lists` map id -> `[name, value]`.
 *   - `targets[].broadcasts` maps id -> name, as a bare string.
 *   - a sprite sees the stage's variables, so a sprite fragment has to carry both
 *     its own and the stage's declarations or a global reference would not resolve.
 */

import { decompileScripts } from './xml.mjs'

/** Raised when a project document cannot be read as asked. */
export class ProjectError extends Error {
  constructor (message) {
    super(message)
    this.name = 'ProjectError'
  }
}

/**
 * Declarations of one target's variables, lists and broadcasts, in the shape the
 * compiler's `<variables>` section uses.
 *
 * @param {any} target a project target
 * @returns {{id: string, name: string, type: string}[]} declarations
 */
export const declarationsOf = (target) => {
  const named = (entry) => (Array.isArray(entry) ? entry[0] : entry)
  return [
    ...Object.entries(target?.variables ?? {}).map(([id, entry]) => ({ id, name: String(named(entry)), type: '' })),
    ...Object.entries(target?.lists ?? {}).map(([id, entry]) => ({ id, name: String(named(entry)), type: 'list' })),
    ...Object.entries(target?.broadcasts ?? {}).map(([id, name]) => ({ id, name: String(named(name)), type: 'broadcast_msg' }))
  ]
}

/**
 * Find a target by name, id, or the literal "stage".
 *
 * @param {any} project parsed project document
 * @param {string} [reference] name, id, or "stage"; omitted means the first sprite
 * @returns {any} the target
 * @throws {ProjectError} when there is no match
 */
export const findProjectTarget = (project, reference) => {
  const targets = project?.targets
  if (!Array.isArray(targets)) throw new ProjectError('the project has no targets array')
  if (reference === undefined || reference === null || reference === '') {
    const sprite = targets.find((target) => target.isStage !== true)
    if (sprite === undefined) throw new ProjectError('the project has no sprites')
    return sprite
  }
  if (String(reference).toLowerCase() === 'stage') {
    const stage = targets.find((target) => target.isStage === true)
    if (stage === undefined) throw new ProjectError('the project has no stage')
    return stage
  }
  const match = targets.find((target) => target.name === reference)
  if (match === undefined) {
    throw new ProjectError(`no target named "${reference}"; the project has: ${targets.map((t) => t.name).join(', ')}`)
  }
  return match
}

/**
 * List every target with a readable one-line description.
 * @param {any} project parsed project document
 * @returns {{name: string, isStage: boolean, blocks: number, scripts: number, costumes: string[], sounds: string[], variables: string[]}[]} the targets
 */
export const listProjectTargets = (project) => (project?.targets ?? []).map((target) => {
  const blocks = target.blocks ?? {}
  const ids = Object.keys(blocks)
  return {
    name: target.name,
    isStage: target.isStage === true,
    blocks: ids.length,
    scripts: ids.filter((id) => blocks[id]?.topLevel === true || Array.isArray(blocks[id])).length,
    costumes: (target.costumes ?? []).map((costume) => costume.name),
    sounds: (target.sounds ?? []).map((sound) => sound.name),
    variables: declarationsOf(target).map((declaration) => declaration.type === 'list' ? `${declaration.name} (list)` : declaration.name)
  }
})

/**
 * Build the fragment the decompiler expects for one target.
 *
 * @param {any} project parsed project document
 * @param {string} [reference] target name, id, or "stage"
 * @returns {{target: string, fragment: {blocks: Record<string, any>, topLevelIds: string[], variables: any[], comments: any[]}}} the fragment
 * @throws {ProjectError} when the target does not exist
 */
export const fragmentFromProject = (project, reference) => {
  const target = findProjectTarget(project, reference)
  const blocks = target.blocks ?? {}
  const topLevelIds = Object.keys(blocks).filter((id) => {
    const block = blocks[id]
    // A top-level primitive is a bare array; everything else says so explicitly.
    return Array.isArray(block) || block?.topLevel === true
  })

  // A sprite's scripts can reference the stage's globals, so both sets of
  // declarations ride along; the decompiler needs the names to print fields.
  const stage = (project.targets ?? []).find((candidate) => candidate.isStage === true)
  const variables = target.isStage === true
    ? declarationsOf(target)
    : [...declarationsOf(target), ...declarationsOf(stage).filter((global) =>
        !declarationsOf(target).some((local) => local.id === global.id))]

  // Comments live on the target too, keyed by id, each naming the block it hangs off.
  const comments = Object.entries(target.comments ?? {}).map(([id, comment]) => ({
    id: comment?.id ?? id,
    blockId: comment?.blockId === undefined ? null : comment.blockId,
    text: comment?.text ?? '',
    x: comment?.x,
    y: comment?.y,
    width: comment?.width,
    height: comment?.height,
    minimized: comment?.minimized === true
  }))

  return {
    target: target.name,
    fragment: { blocks, topLevelIds, variables, comments }
  }
}

/**
 * Render one target's scripts as scratch-blocks XML, from the file alone.
 * @param {any} project parsed project document
 * @param {string} [reference] target name, id, or "stage"
 * @returns {{target: string, xml: string, scripts: number}} the rendered scripts
 */
export const targetXmlFromProject = (project, reference) => {
  const { target, fragment } = fragmentFromProject(project, reference)
  return {
    target,
    xml: decompileScripts(fragment),
    scripts: fragment.topLevelIds.length
  }
}

/**
 * A readable digest of a project, for tool output.
 * @param {any} project parsed project document
 * @param {{assetCount?: number}} [extras] facts the container adds
 * @returns {string} the digest
 */
export const summarizeProject = (project, extras = {}) => {
  const lines = ['targets:']
  for (const target of listProjectTargets(project)) {
    lines.push(`  ${target.name}${target.isStage ? ' (stage)' : ''} — ${target.scripts} script(s), ${target.blocks} block(s), costumes: ${target.costumes.join(', ') || 'none'}`)
    if (target.sounds.length > 0) lines.push(`    sounds: ${target.sounds.join(', ')}`)
    if (target.variables.length > 0) lines.push(`    variables: ${target.variables.join(', ')}`)
  }
  const extensions = project?.extensions ?? []
  if (extensions.length > 0) lines.push(`extensions: ${extensions.join(', ')}`)
  if (extras.assetCount !== undefined) lines.push(`assets: ${extras.assetCount}`)
  return lines.join('\n')
}

/**
 * Every block belonging to one script, including shadows reached through inputs.
 *
 * The runtime deletes a stack as a unit (`Blocks.deleteBlock` walks the tree), but
 * a project document is a flat id -> block map: removing only the top-level entry
 * leaves its children behind as orphans whose `parent` points at nothing. Doing
 * this by hand is the price of editing the file instead of the editor.
 *
 * @param {Record<string, any>} blocks the target's block map
 * @param {string} rootId the top-level block to walk from
 * @returns {Set<string>} every id in that script
 */
export const collectScript = (blocks, rootId) => {
  const collected = new Set()
  const walk = (id) => {
    if (typeof id !== 'string' || collected.has(id)) return
    const block = blocks[id]
    if (block === undefined) return
    collected.add(id)
    if (Array.isArray(block)) return
    if (typeof block.next === 'string') walk(block.next)
    for (const wire of Object.values(block.inputs ?? {})) {
      if (!Array.isArray(wire)) continue
      for (const reference of wire.slice(1)) {
        if (typeof reference === 'string') walk(reference)
        else if (Array.isArray(reference)) continue // an inlined primitive owns no entry
      }
    }
  }
  walk(rootId)
  return collected
}

/**
 * Splice a compiled fragment into a project document — the offline counterpart of
 * `applyFragment`, which does the same thing against a live runtime.
 *
 * @param {any} project parsed project document (mutated in place)
 * @param {{target?: string, fragment: {blocks: Record<string, any>, topLevelIds: string[], variables?: any[]}, mode?: 'replace'|'append'|'replaceScript', script?: number|string, scope?: 'global'|'local'}} request the edit
 * @returns {{target: string, removedBlocks: number, createdBlocks: number, declaredVariables: string[], blocksAfter: number}} what changed
 * @throws {ProjectError} when the target does not exist, or the named script does not
 */
export const applyFragmentToProject = (project, request) => {
  const target = findProjectTarget(project, request.target)
  const stage = (project.targets ?? []).find((candidate) => candidate.isStage === true)
  const mode = request.mode ?? 'replace'

  const blocks = { ...(target.blocks ?? {}) }
  let removedBlocks = 0
  if (mode === 'replace' || mode === 'replaceScript') {
    const roots = Object.keys(blocks).filter((id) => Array.isArray(blocks[id]) || blocks[id]?.topLevel === true)
    let doomedRoots = roots
    if (mode === 'replaceScript') {
      // The offline twin of the live path's single-script swap: a 1-based position in
      // the script list, or a top-level block id. The two paths have to agree, or
      // "read the file, edit it, write it back" stops meaning the same as editing live.
      const wanted = request.script
      const byIndex = typeof wanted === 'number' ? roots[wanted - 1] : undefined
      const byId = typeof wanted === 'string' && roots.includes(wanted) ? wanted : undefined
      const chosen = byIndex ?? byId
      if (chosen === undefined) {
        throw new ProjectError(`no such script: ${JSON.stringify(wanted)} — this target has ${roots.length} top-level ` +
          `script(s); pass a 1-based number, or one of their ids: ${roots.join(', ')}`)
      }
      doomedRoots = [chosen]
    }
    const doomed = new Set()
    for (const root of doomedRoots) for (const id of collectScript(blocks, root)) doomed.add(id)
    for (const id of doomed) {
      delete blocks[id]
      removedBlocks++
    }
  }

  let createdBlocks = 0
  for (const [id, block] of Object.entries(request.fragment?.blocks ?? {})) {
    if (Object.hasOwn(blocks, id)) {
      throw new ProjectError(`the fragment reuses block id "${id}", which the target already has; ids must be unique within a target`)
    }
    blocks[id] = block
    createdBlocks++
  }
  target.blocks = blocks

  // Broadcasts always live on the stage; ordinary variables follow the requested
  // scope, matching what the live path does.
  const declaredVariables = []
  for (const declaration of request.fragment?.variables ?? []) {
    const mapName = declaration.type === 'list'
      ? 'lists'
      : (declaration.type === 'broadcast_msg' ? 'broadcasts' : 'variables')
    const owner = mapName === 'broadcasts' || request.scope !== 'local' ? stage : target
    if (owner === undefined) continue
    owner[mapName] = owner[mapName] ?? {}
    if (Object.hasOwn(owner[mapName], declaration.id)) continue
    owner[mapName][declaration.id] = mapName === 'broadcasts'
      ? declaration.name
      : [declaration.name, mapName === 'lists' ? [] : '']
    declaredVariables.push(declaration.name)
  }

  // Comments: drop the ones whose block is gone, then write the fragment's. The
  // block-to-comment link lives on the block (already spliced in above); the comment
  // record here is the other half of it.
  const comments = { ...(target.comments ?? {}) }
  let removedComments = 0
  for (const [id, comment] of Object.entries(comments)) {
    const blockId = comment?.blockId
    if (blockId === null || blockId === undefined) continue
    if (!Object.hasOwn(blocks, blockId)) {
      delete comments[id]
      removedComments++
    }
  }
  let createdComments = 0
  for (const comment of request.fragment?.comments ?? []) {
    if (typeof comment?.id !== 'string' || comment.id.length === 0) continue
    comments[comment.id] = {
      blockId: comment.blockId === undefined ? null : comment.blockId,
      x: Number.isFinite(comment.x) ? comment.x : 0,
      y: Number.isFinite(comment.y) ? comment.y : 0,
      width: Number.isFinite(comment.width) ? comment.width : 200,
      height: Number.isFinite(comment.height) ? comment.height : 200,
      minimized: comment.minimized === true,
      text: comment.text === undefined ? '' : String(comment.text)
    }
    createdComments++
  }
  target.comments = comments

  return {
    target: target.name,
    removedBlocks,
    createdBlocks,
    declaredVariables,
    createdComments,
    removedComments,
    blocksAfter: Object.keys(blocks).length
  }
}
