/**
 * Merging two writers' projects.
 *
 * The two failure modes this module exists to prevent are both silent, and both were hit
 * for real by a hand-written merge script: copying `blocks` without the sprite's own
 * `variables` leaves every local reference dangling (374 of them in one delivery, in a
 * project that still opened), and copying a costume LIST without its bytes produces a
 * sprite that renders as nothing. So the tests check the halves travel together, and —
 * the one that actually matters — that the merged project passes the load check.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeProjects } from '../src/scratch/merge.mjs'
import { verifyProject } from '../src/scratch/verify.mjs'

/** A stage plus one sprite, with just enough shape to merge. */
const project = (spriteName, options = {}) => ({
  targets: [
    {
      isStage: true,
      name: 'Stage',
      variables: { globalScore: ['score', 0], ...(options.stageVariables ?? {}) },
      lists: {},
      broadcasts: { msg1: 'go', ...(options.broadcasts ?? {}) },
      blocks: {},
      comments: {},
      costumes: [{ name: 'backdrop1', md5ext: 'stage.svg', dataFormat: 'svg', assetId: 'stage' }],
      sounds: []
    },
    {
      isStage: false,
      name: spriteName,
      variables: options.variables ?? {},
      lists: options.lists ?? {},
      blocks: options.blocks ?? {},
      comments: options.comments ?? {},
      costumes: options.costumes ?? [{ name: 'c1', md5ext: `${spriteName}.svg`, dataFormat: 'svg', assetId: spriteName }],
      sounds: options.sounds ?? []
    },
    ...(options.extraTargets ?? [])
  ],
  extensions: [],
  meta: {}
})

/** A sprite-local script that reads a sprite-local variable. */
const localScript = (variableId) => ({
  hat: { opcode: 'event_whenflagclicked', next: 'set', parent: null, inputs: {}, fields: {}, shadow: false, topLevel: true },
  set: {
    opcode: 'data_setvariableto',
    next: null,
    parent: 'hat',
    inputs: { VALUE: [1, [10, '1']] },
    fields: { VARIABLE: ['lives', variableId] },
    shadow: false,
    topLevel: false
  }
})

test('a merge carries the sprite\'s variables and assets along with its blocks', () => {
  const destination = project('玩家', { blocks: {}, variables: {} })
  const source = project('玩家', {
    blocks: localScript('lives1'),
    variables: { lives1: ['lives', 3] },
    costumes: [{ name: 'hero', md5ext: 'hero.svg', dataFormat: 'svg', assetId: 'hero' }]
  })
  const assets = new Map([['stage.svg', Buffer.from('s')]])
  const sourceAssets = new Map([['hero.svg', Buffer.from('h')]])

  const result = mergeProjects(destination, source, { assets, sourceAssets })

  assert.equal(result.taken.length, 1)
  assert.equal(result.taken[0].target, '玩家')
  assert.equal(result.taken[0].variables, 1)
  assert.equal(result.taken[0].costumes, 1)
  assert.equal(result.assetsCopied, 1)
  assert.ok(assets.has('hero.svg'), 'the costume bytes came with the costume list')

  // The integrated check: what a hand-written merge got wrong is exactly what this
  // catches, and it is the reason the merge tool reports the load check too.
  const report = verifyProject(destination, { assets })
  assert.deepEqual(report.errors, [], report.errors.join('\n'))
})

test('merging blocks without variables would be caught — so the merge does not do it', () => {
  // The control case, spelled out: take the blocks only and the load check fires.
  const destination = project('玩家')
  destination.targets[1].blocks = structuredClone(localScript('lives1'))
  const report = verifyProject(destination)
  assert.match(report.errors.join('\n'), /uses VARIABLE "lives" \(id lives1\), which no variable/)
})

test('globals are unioned by id, and a name collision is reported', () => {
  const destination = project('玩家')
  const source = project('玩家', {
    stageVariables: { coinsId: ['coins', 0], globalScore: ['points', 0] },
    broadcasts: { msg2: 'stop' }
  })
  const result = mergeProjects(destination, source, { assets: new Map(), sourceAssets: new Map() })

  assert.deepEqual(result.globals.variables, ['coins'])
  assert.deepEqual(result.globals.broadcasts, ['stop'])
  // Same id, different name: the destination's name stays, and the caller is told.
  assert.match(result.warnings.join('\n'), /global variable globalScore is "score" in the destination and "points" in the source/)
  assert.deepEqual(destination.targets[0].variables.globalScore, ['score', 0])
})

test('a sprite the destination does not have is added whole', () => {
  const destination = project('玩家')
  const source = project('玩家', {
    extraTargets: [{
      isStage: false,
      name: '敌人',
      variables: { hp: ['hp', 5] },
      lists: {},
      blocks: {},
      comments: {},
      costumes: [{ name: 'enemy', md5ext: 'enemy.svg', dataFormat: 'svg', assetId: 'enemy' }],
      sounds: []
    }]
  })
  const assets = new Map()
  const result = mergeProjects(destination, source, { assets, sourceAssets: new Map([['enemy.svg', Buffer.from('e')]]) })

  assert.deepEqual(result.added, ['敌人'])
  assert.ok(destination.targets.some((target) => target.name === '敌人'))
  assert.ok(assets.has('enemy.svg'))
})

test('targets can be restricted, and a name that is not there is reported', () => {
  const destination = project('玩家')
  const source = project('玩家', { extraTargets: [{ isStage: false, name: '敌人', variables: {}, lists: {}, blocks: {}, comments: {}, costumes: [], sounds: [] }] })
  const result = mergeProjects(destination, source, {
    targets: ['敌人', '不存在'],
    assets: new Map(),
    sourceAssets: new Map()
  })
  assert.deepEqual(result.added, ['敌人'])
  assert.deepEqual(result.missing, ['不存在'])
  assert.equal(result.taken.length, 0)
})

test('mode "scripts" takes the code and leaves the destination\'s art and variables alone', () => {
  const destination = project('玩家', { variables: { mine: ['lives', 9] }, costumes: [{ name: 'keepme', md5ext: 'keep.svg', dataFormat: 'svg', assetId: 'keep' }] })
  const source = project('玩家', { blocks: localScript('lives1'), variables: { lives1: ['lives', 3] } })
  const result = mergeProjects(destination, source, { mode: 'scripts', assets: new Map(), sourceAssets: new Map() })

  assert.equal(result.taken[0].blocks, 2)
  assert.deepEqual(destination.targets[1].variables, { mine: ['lives', 9] })
  assert.equal(destination.targets[1].costumes[0].name, 'keepme')
  // ...and that is a legitimate state to be in, as long as the caller knows.
  assert.equal(result.taken[0].variables, 0)
})

test('a source missing a sprite\u2019s asset warns instead of writing a dangling reference', () => {
  const destination = project('玩家')
  const source = project('玩家', { costumes: [{ name: 'ghost', md5ext: 'ghost.svg', dataFormat: 'svg', assetId: 'ghost' }] })
  const assets = new Map()
  const result = mergeProjects(destination, source, { assets, sourceAssets: new Map() })
  assert.match(result.warnings.join('\n'), /asset ghost.svg is referenced by the merged content but is not in the source archive/)
  assert.ok(!assets.has('ghost.svg'))
})

test('merging is not aliased to the source document', () => {
  const destination = project('玩家')
  const source = project('玩家', { blocks: localScript('lives1'), variables: { lives1: ['lives', 3] } })
  mergeProjects(destination, source, { assets: new Map(), sourceAssets: new Map() })
  destination.targets[1].variables.lives1[1] = 99
  assert.equal(source.targets[1].variables.lives1[1], 3, 'editing the merged copy must not reach back into the source')
  destination.targets[1].blocks.set.fields.VARIABLE[0] = 'changed'
  assert.equal(source.targets[1].blocks.set.fields.VARIABLE[0], 'lives')
})

test('a sprite only the source has is added, and a filter that matches nothing says so', () => {
  const destination = project('玩家')
  const source = project('别的角色')
  const added = mergeProjects(destination, source, { assets: new Map(), sourceAssets: new Map() })
  assert.deepEqual(added.added, ['别的角色'], 'a new actor is the normal case, not a failure')

  // ...whereas a filter that matches nothing has to look different from success.
  const filtered = mergeProjects(project('玩家'), source, {
    targets: ['不要这个'],
    assets: new Map(),
    sourceAssets: new Map()
  })
  assert.equal(filtered.taken.length, 0)
  assert.equal(filtered.added.length, 0)
  assert.deepEqual(filtered.missing, ['不要这个'])
})
