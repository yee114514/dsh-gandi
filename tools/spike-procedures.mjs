/**
 * What does the editor's OWN XML look like for a custom block and a comment?
 *
 * The plugin compiles scratch-blocks XML, so the authoritative description of that
 * dialect is what `Blocks.toXML()` emits — not anyone's memory of it. This probe
 * builds a project that contains a custom block (definition, prototype, call,
 * argument reporter) and a script comment, loads it, and prints the XML the runtime
 * produces from it.
 *
 * The blocks are written in the COMPRESSED WIRE FORM, which is what the plugin's
 * compiler emits and what a project document stores, so nothing here depends on the
 * dialect being guessed correctly.
 *
 * Run with: node tools/spike-procedures.mjs [--port 9222]
 */

import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const argv = process.argv.slice(2)
const portFlag = argv.indexOf('--port')
const port = Number(portFlag === -1 ? (process.env.TW_PORT ?? '9222') : argv[portFlag + 1])

/** A stage and one sprite whose scripts use a custom block with one argument. */
const probeProject = () => {
  const ARG_ID = 'argHeightId01'
  const PROTO_ID = 'protoBlockId01'
  const DEFINITION_ID = 'defBlockId0001'
  const CALL_ID = 'callBlockId001'
  const HAT_ID = 'hatBlockId0001'
  const BODY_ID = 'bodyBlockId001'
  const REPORTER_ID = 'reporterId0001'

  const prototypeMutation = {
    tagName: 'mutation',
    children: [],
    proccode: 'jump %n',
    argumentids: JSON.stringify([ARG_ID]),
    argumentnames: JSON.stringify(['height']),
    argumentdefaults: JSON.stringify(['10']),
    warp: 'false'
  }
  const callMutation = {
    tagName: 'mutation',
    children: [],
    proccode: 'jump %n',
    argumentids: JSON.stringify([ARG_ID]),
    warp: 'false'
  }

  return {
    targets: [
      {
        isStage: true,
        name: 'Stage',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {},
        comments: {},
        currentCostume: 0,
        costumes: [],
        sounds: [],
        volume: 100,
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'off',
        textToSpeechLanguage: null
      },
      {
        isStage: false,
        name: 'Sprite1',
        variables: {},
        lists: {},
        broadcasts: {},
        blocks: {
          [DEFINITION_ID]: {
            opcode: 'procedures_definition',
            next: BODY_ID,
            parent: null,
            inputs: { custom_block: [1, PROTO_ID] },
            fields: {},
            shadow: false,
            topLevel: true,
            x: 40,
            y: 40
          },
          [PROTO_ID]: {
            opcode: 'procedures_prototype',
            next: null,
            parent: DEFINITION_ID,
            inputs: {},
            fields: {},
            shadow: true,
            topLevel: false,
            mutation: prototypeMutation
          },
          [BODY_ID]: {
            opcode: 'motion_movesteps',
            next: null,
            parent: DEFINITION_ID,
            inputs: { STEPS: [3, REPORTER_ID, [4, '10']] },
            fields: {},
            shadow: false,
            topLevel: false
          },
          [REPORTER_ID]: {
            opcode: 'argument_reporter_string_number',
            next: null,
            parent: BODY_ID,
            inputs: {},
            fields: { VALUE: ['height'] },
            shadow: false,
            topLevel: false
          },
          [HAT_ID]: {
            opcode: 'event_whenflagclicked',
            next: CALL_ID,
            parent: null,
            inputs: {},
            fields: {},
            shadow: false,
            topLevel: true,
            x: 40,
            y: 300
          },
          [CALL_ID]: {
            opcode: 'procedures_call',
            next: null,
            parent: HAT_ID,
            inputs: { [ARG_ID]: [1, [4, '25']] },
            fields: {},
            shadow: false,
            topLevel: false,
            mutation: callMutation
          }
        },
        comments: {
          commentId00001: {
            blockId: HAT_ID,
            x: 300,
            y: 320,
            width: 200,
            height: 120,
            minimized: false,
            text: 'this is a script comment'
          },
          commentId00002: {
            blockId: null,
            x: 480,
            y: 60,
            width: 200,
            height: 120,
            minimized: false,
            text: 'this one is not attached to a block'
          }
        },
        currentCostume: 0,
        costumes: [],
        sounds: [],
        volume: 100,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around'
      }
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'probe' }
  }
}

const targets = await listTargets(port)
const page = targets.find((t) => typeof t.url === 'string' && t.url.startsWith('tw-editor://'))
if (page === undefined) throw new Error('no tw-editor:// page target found')
const connection = await CdpConnection.connect(page.webSocketDebuggerUrl)

const report = await evaluate(connection, `(async () => {
  const project = ${JSON.stringify(JSON.stringify(probeProject()))}
  await window.vm.loadProject(project)
  const runtime = window.vm.runtime
  const sprite = runtime.targets.find((t) => !t.isStage && t.getName() === 'Sprite1')
  if (!sprite) return JSON.stringify({ error: 'the probe sprite did not load' })

  const definition = sprite.blocks.getBlock('defBlockId0001')
  const prototype = sprite.blocks.getBlock('protoBlockId01')
  const call = sprite.blocks.getBlock('callBlockId001')

  // Now RUN it. A custom block that is shaped wrongly still writes, still reads back,
  // and still looks right in the editor — it only fails when the runtime resolves the
  // call and glows the stack it is about to run.
  const before = { x: sprite.x }
  let runFailure = null
  try {
    window.vm.greenFlag()
    for (let i = 0; i < 5; i++) runtime._step()
  } catch (error) {
    runFailure = { message: String(error && error.message), stack: String(error && error.stack).slice(0, 1200) }
  }
  runtime.stopAll?.()

  return JSON.stringify({
    loadedSprites: runtime.targets.map((t) => t.getName()),
    // toXML takes the comments as an ARGUMENT: the block graph does not contain
    // them, they live on the target, and emitWorkspaceUpdate passes them in. Calling
    // it with no argument (as this probe first did) silently drops every comment.
    xmlWithComments: sprite.blocks.toXML(sprite.comments),
    definitionOpcode: definition ? definition.opcode : null,
    prototypeMutation: prototype ? prototype.mutation : null,
    callMutation: call ? call.mutation : null,
    callInputs: call ? Object.keys(call.inputs) : null,
    commentsInRuntime: sprite.comments ? Object.keys(sprite.comments).length : 'no comments property',
    commentsInXml: sprite.blocks.toXML(sprite.comments).includes('comment'),
    procedureLookup: (() => {
      const found = sprite.blocks.getProcedureDefinition('jump %n')
      return { getProcedureDefinition: found === undefined || found === null ? String(found) : found }
    })(),
    movedBy: sprite.x - before.x,
    runFailure
  }, null, 1)
})()`, { awaitPromise: true, timeoutMs: 60000 })

console.log(report)
connection.close()
