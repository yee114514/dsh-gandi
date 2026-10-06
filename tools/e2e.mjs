/**
 * End-to-end acceptance test: drive a live Gandi through the plugin's own tool
 * definitions.
 *
 * This is the plan's acceptance criterion in executable form. It goes through the
 * real tool surface (argument validation, error translation, the bridge service and
 * its lease) rather than calling the lower layers, so a regression anywhere in the
 * stack shows up here.
 *
 *   node tools/e2e.mjs [--port 9222] [--keep]
 *
 * The user's open project is snapshotted first and restored at the end; `--keep`
 * skips the restore when you want to look at the result yourself.
 */

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

import { apply } from '../src/index.mjs'
import { listTargets, CdpConnection } from '../src/bridge/cdp.mjs'
import { getProjectJson, exportSb3, loadProjectBytes } from '../src/bridge/ops.mjs'
import { readSb3 } from '../src/scratch/sb3.mjs'
import { crc32 } from '../src/scratch/zip.mjs'

/**
 * Build a real PNG, so the bitmap costume path is exercised with bytes the renderer
 * genuinely accepts. Hand-rolled rather than checked in as a fixture: it is twenty
 * lines, and a hard-coded base64 blob is the kind of thing that silently rots.
 *
 * @param {number} width image width
 * @param {number} height image height
 * @param {[number, number, number, number]} rgba fill colour
 * @returns {Buffer} PNG bytes
 */
const makePng = (width, height, rgba) => {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const typeBuffer = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
    return Buffer.concat([length, typeBuffer, data, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 4
      raw[offset] = rgba[0]
      raw[offset + 1] = rgba[1]
      raw[offset + 2] = rgba[2]
      raw[offset + 3] = rgba[3]
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outDir = join(root, '.e2e')

const argv = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}
const keep = argv.includes('--keep')
const port = Number(argOf('--port', process.env.GANDI_PORT ?? '9222'))

let failures = 0
let checks = 0
const check = (label, condition, detail) => {
  checks++
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

/**
 * Register the plugin into a fake cordis context, returning a caller that mirrors
 * the registry's own validation.
 *
 * `ctx.effect` is honoured rather than stubbed: the plugin uses it to close its CDP
 * socket, and a live socket keeps Node's event loop alive forever.
 *
 * @param {Record<string, unknown>} config row config
 */
const harness = (config) => {
  const tools = new Map()
  const disposers = []
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    get: () => undefined,
    effect: (callback) => {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    }
  }
  apply(ctx, config)
  const call = async (name, args = {}) => {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`no such tool: ${name}`)
    const value = await definition.execute(args, {
      agent: { id: 'e2e-agent', session: { header: { id: 'e2e-session', cwd: root } } }
    })
    const blocks = definition.output.render(args, value)
    return { value, blocks, text: blocks[0].text, image: blocks.find((b) => b.type === 'image') }
  }
  call.dispose = () => {
    while (disposers.length > 0) disposers.pop()()
  }
  return call
}

/**
 * A run-unique variable, so the "was it created?" assertion is not defeated by a
 * variable left behind in the editor by an earlier run.
 */
const SUFFIX = Math.random().toString(36).slice(2, 8)
const VAR_NAME = `e2e_${SUFFIX}`
const VAR_ID = `e2eVar${SUFFIX}`

const SCRIPT = `<xml>
  <variables>
    <variable id="${VAR_ID}" type="">${VAR_NAME}</variable>
  </variables>
  <block type="event_whenflagclicked" x="48" y="48">
    <next>
      <block type="data_setvariableto">
        <field name="VARIABLE" id="${VAR_ID}" variabletype="">${VAR_NAME}</field>
        <value name="VALUE"><shadow type="text"><field name="TEXT">7</field></shadow></value>
        <next>
          <block type="control_wait">
            <value name="DURATION"><shadow type="math_positive_number"><field name="NUM">0.3</field></shadow></value>
            <next>
              <block type="motion_gotoxy">
                <value name="X"><shadow type="math_number"><field name="NUM">120</field></shadow></value>
                <value name="Y"><shadow type="math_number"><field name="NUM">-60</field></shadow></value>
              </block>
            </next>
          </block>
        </next>
      </block>
    </next>
  </block>
</xml>`

/**
 * Pull the sprite's x out of a run/observe report.
 *
 * The report lists the stage first, and the stage's x is always 0, so a naive
 * `/x=(-?\d+)/` silently reads the stage and makes "the sprite did not move" look
 * true. Match the first line that is not the stage.
 */
const spriteX = (text) => {
  const line = text.split('\n').find((candidate) => /: x=-?\d+/.test(candidate) && !candidate.includes('(stage)'))
  return Number(line?.match(/x=(-?\d+)/)?.[1] ?? Number.NaN)
}

/**
 * Sprite names read out of an inspect/observe report.
 *
 * This test runs against whatever project is open, so it must not assume a name —
 * the default project's sprite is called "角色1" on a Chinese install and something
 * else elsewhere. Stage and clone rows are filtered out.
 */
const spriteNames = (text) => text
  .split('\n')
  .map((line) => line.match(/^ {2}(.+?) — /))
  .filter((match) => match !== null)
  .map((match) => match[1])
  .filter((name) => !name.includes('(stage)') && !name.includes('(clone)'))

/**
 * Read the "N script(s), M block(s)" counts for one target out of an inspect report.
 * Asserting on a delta rather than an absolute keeps a check honest about what the
 * call it is testing actually changed.
 */
const targetStats = (text, name) => {
  const line = text.split('\n').find((candidate) => candidate.startsWith(`  ${name} — `))
  if (line === undefined) return null
  const match = line.match(/— (\d+) script\(s\), (\d+) block\(s\)/)
  return match === null ? null : { scripts: Number(match[1]), blocks: Number(match[2]) }
}

const main = async () => {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  /** Held so the process can always let go of the sockets, including on failure. */
  let connection = null
  let call = null

  try {
    call = harness({ port, debug: false })

    // ── get an editor tab to drive ───────────────────────────────────────────
    // Gandi starts on its project browser; the editor only exists once a tab is
    // open, and `gandi_status` deliberately does not open one. So the run begins by
    // asking for a tab, which is also the first thing a real session does.
    const launched = await call('gandi_launch', { timeoutMs: 90000 })
    console.log('--- gandi_launch ---\n' + launched.text + '\n')

    const status = await call('gandi_status')
    console.log('--- gandi_status ---\n' + status.text + '\n')
    check('bridge reports the port open', /port \d+: open/.test(status.text))
    check('an editor tab is open', /editor tab: open/.test(status.text))
    check('bridge is attached', /connection: attached/.test(status.text))

  // Snapshot the user's project so everything below can be undone. As ARCHIVE
  // BYTES, not as JSON: a project document carries no assets, so restoring from one
  // leaves every costume referencing bytes nothing has registered — the project
  // still looks fine, but it can no longer be exported faithfully, and the next run
  // inherits that. Capturing the archive keeps the restore honest.
  const targets = await listTargets(port)
  const page = targets.find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
  if (page === undefined) throw new Error('no Gandi editor page target found — call scratch_launch first')
  connection = await CdpConnection.connect(page.webSocketDebuggerUrl)
  const original = await getProjectJson(connection)
  const originalArchive = await exportSb3(connection)
  const originalContainer = readSb3(originalArchive)
  check('the original project snapshots cleanly', originalContainer.warnings.length === 0, originalContainer.warnings)
  // Also put the snapshot on disk. The restore at the end only runs if the run gets
  // that far, and a crash halfway leaves the project altered with no way back.
  const originalPath = join(outDir, 'original-backup.sb3')
  await writeFile(originalPath, originalArchive)
  console.log(`the project that was open is saved to ${originalPath} (restored at the end unless --keep)`)

  // ── dry run compiles without touching the editor ─────────────────────────
  const dry = await call('gandi_apply', { xml: SCRIPT, dryRun: true })
  console.log('--- dry run ---\n' + dry.text + '\n')
  check('dry run compiled without warnings', /warnings:\n {2}\(none\)/.test(dry.text))

  // ── apply for real ───────────────────────────────────────────────────────
  const applied = await call('gandi_apply', { xml: SCRIPT })
  console.log('--- apply ---\n' + applied.text + '\n')
  check('blocks were created', /applied \d+ block\(s\)/.test(applied.text))
  check('the variable was declared', new RegExp(`created variables: ${VAR_NAME}`).test(applied.text), applied.text)
  // Remember WHICH target received the script: later sections create sprites, so
  // "the first sprite" stops meaning "the scripted one" partway through the run.
  const scriptedTarget = applied.text.match(/to (.+?) \(/)?.[1] ?? null

  const inspected = await call('gandi_inspect', {})
  check('inspect shows the new script', /data_setvariableto/.test(inspected.text) && /motion_gotoxy/.test(inspected.text))
  check('inspect prints XML', /<block[\s\S]*event_whenflagclicked/.test(inspected.text))

  // ── run it and look ──────────────────────────────────────────────────────
  const run = await call('gandi_run', { seconds: 1 })
  console.log('--- run ---\n' + run.text + '\n')
  check('the sprite reached the target position', /x=120 y=-60/.test(run.text))
  // The script assigns through a text shadow, so the value is the STRING "7" and is
  // rendered with quotes. Asserting on the quoted form is also what pins the rendering:
  // an unquoted `=7` here would mean a text assignment had been flattened to a number.
  check('the variable holds the written value', new RegExp(`${VAR_NAME}="7"`).test(run.text), run.text)

  // Without the attachments service the tool degrades to writing a PNG and naming
  // it, which is the documented fallback. Either way a real image must exist.
  const fallbackPath = run.text.match(/written to (.+?\.png)/)?.[1]
  if (run.image !== undefined) {
    check('a stage image came back as an attachment', true, 'image block present')
  } else {
    check('a stage image came back as a file', fallbackPath !== undefined, run.text)
    if (fallbackPath !== undefined) {
      const png = await readFile(fallbackPath)
      check('the written file is a real PNG', png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', `${png.length} bytes`)
      await rm(fallbackPath, { force: true })
    }
  }

  const observed = await call('gandi_observe', {})
  check('observe agrees with run', /x=120 y=-60/.test(observed.text))

  // ── artwork: the AI draws its own costume ────────────────────────────────
  // Run-unique names throughout: Scratch de-duplicates a name that is already
  // taken (appending a digit), so a fixed name makes the assertions depend on what
  // previous runs left behind.
  const BALL = `e2e-ball-${SUFFIX}`
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#22cc55"/></svg>'
  const costumed = await call('gandi_costume', { name: BALL, svg })
  console.log('--- costume ---\n' + costumed.text + '\n')
  check('the costume was installed', costumed.text.includes(`added costume "${BALL}"`), costumed.text)
  check('the rotation centre came from the SVG size', /rotation centre 20, 20/.test(costumed.text), costumed.text)

  const afterCostume = await call('gandi_observe', {})
  check('the new costume became the current one', afterCostume.text.includes(`costume=${BALL}`), afterCostume.text)

  const shotWithCostume = await call('gandi_screenshot', { savePath: join(outDir, 'stage-with-costume.png') })
  const costumePng = await readFile(join(outDir, 'stage-with-costume.png'))
  check('a screenshot of the new costume is a real PNG', costumePng.subarray(0, 8).toString('hex') === '89504e470d0a1a0a', `${costumePng.length} bytes`)

  // ── a second actor ───────────────────────────────────────────────────────
  const duplicated = await call('gandi_sprite', { action: 'duplicate', name: 'e2e-clone' })
  console.log('--- sprite ---\n' + duplicated.text + '\n')
  check('the sprite was duplicated and renamed', /duplicated .* as e2e-clone/.test(duplicated.text), duplicated.text)
  check('both sprites exist', /sprites: .*e2e-clone/.test(duplicated.text), duplicated.text)

  const placed = await call('gandi_place', { target: 'e2e-clone', x: -100, y: 50, size: 150 })
  console.log('--- place ---\n' + placed.text + '\n')
  check('the clone was positioned', /x=-100 y=50/.test(placed.text) && /size=150/.test(placed.text), placed.text)

  const afterDelete = await call('gandi_sprite', { action: 'delete', target: 'e2e-clone' })
  // The reply names what was deleted, so check the sprite LIST, not the whole text.
  check('the clone was deleted again', /sprites: (?!.*e2e-clone)/.test(afterDelete.text), afterDelete.text)

  // ── export, then read the export back ────────────────────────────────────
  const savePath = join(outDir, 'e2e-project.sb3')
  const saved = await call('gandi_save', { path: savePath })
  console.log('--- save ---\n' + saved.text + '\n')
  const info = await stat(savePath)
  check('the .sb3 exists on disk', info.size > 0, `${info.size} bytes`)

  const container = readSb3(await readFile(savePath))
  // Look at the target the script was actually applied to, NOT just "the first sprite".
  // The run creates sprites of its own later, and picking the first one made this
  // assertion report "the script is missing" for a project that contained it.
  const scripted = container.project.targets.find((target) => target.name === scriptedTarget) ??
    container.project.targets.find((target) => !target.isStage)
  const opcodes = Object.values(scripted.blocks).map((block) => block.opcode)
  check('the exported project contains the script',
    opcodes.includes('event_whenflagclicked') && opcodes.includes('motion_gotoxy'),
    `${scripted.name}: ${JSON.stringify(opcodes)}`)

  // In the .sb3 format a target's `variables` maps id -> [name, value], not to an
  // object with a `name` field.
  const declaredVariables = container.project.targets
    .flatMap((target) => Object.values(target.variables ?? {}))
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry?.name))
  check('the exported project declares the variable', declaredVariables.includes(VAR_NAME), declaredVariables)
  check('assets round-tripped', container.warnings.length === 0, container.warnings)

  // ── read the real export offline, with no editor involved ────────────────
  // A stronger fixture than anything hand-built: this archive came out of the
  // editor itself, assets and all. What is checked is the ARCHIVE's own content, not
  // whatever the editor happens to have selected now.
  const offline = await call('gandi_inspect', { path: savePath })
  console.log('--- offline read ---\n' + offline.text.slice(0, 400) + '\n')
  const archivedOpcodes = Object.values(scripted.blocks).map((block) => block.opcode)
  check('the exported archive reads offline',
    /project: /.test(offline.text) && archivedOpcodes.includes('data_setvariableto'),
    offline.text.slice(0, 200))
  // Name the sprite from the report rather than assuming one: this test runs
  // against whatever project happens to be open, and hard-coding a name makes it
  // depend on the machine's Scratch locale.
  const subject = spriteNames(offline.text)[0]
  check('offline reading lists the sprite', subject !== undefined, offline.text.slice(0, 300))
  check('offline reading counts its script', new RegExp(`${subject} — 1 script\\(s\\)`).test(offline.text), offline.text.slice(0, 300))

  // ── reopen the export ────────────────────────────────────────────────────
  const reopened = await call('gandi_open', { path: savePath })
  console.log('--- open ---\n' + reopened.text + '\n')
  check('the exported project opens again', /block\(s\)/.test(reopened.text))

  // ── interactive input ────────────────────────────────────────────────────
  // A keyboard-controlled script is the shape a real game has, and it is the only
  // way to prove postIOData actually reaches the runtime.
  const inputScript = `<xml>
    <block type="event_whenflagclicked" x="48" y="420">
      <next>
        <block type="control_forever">
          <statement name="SUBSTACK">
            <block type="control_if">
              <value name="CONDITION">
                <block type="sensing_keypressed">
                  <value name="KEY_OPTION">
                    <shadow type="sensing_keyoptions"><field name="KEY_OPTION">space</field></shadow>
                  </value>
                </block>
              </value>
              <statement name="SUBSTACK">
                <block type="motion_changexby">
                  <value name="DX"><shadow type="math_number"><field name="NUM">60</field></shadow></value>
                </block>
              </statement>
            </block>
          </statement>
        </block>
      </next>
    </block>
  </xml>`

  await call('gandi_apply', { xml: inputScript })
  await call('gandi_place', { x: 0, y: -60 })
  // The keyboard IO device keeps its own state and is NOT reset by restoring a
  // project, so a key left held by an earlier run would make this section
  // order-dependent. Release it explicitly first.
  await call('gandi_input', { key: 'space', isDown: false })

  const idle = await call('gandi_run', { seconds: 0.4, screenshot: false })
  check('the sprite does not move while the key is up', spriteX(idle.text) === 0, idle.text)

  // The key goes down DURING the run, not before it. Two reasons, both of which made
  // the "press it first" version of this test vacuous:
  //   - `runtime.greenFlag()` calls `stopAll()` and `resetKeyPressedCache()`, so a key
  //     posted beforehand is cleared before any script can see it;
  //   - this runtime starts `event_whenkeypressed` from the KEY_PRESSED event rather
  //     than polling the key each frame, so the press has to land while stepping.
  const held = await call('gandi_run', {
    seconds: 0.4,
    screenshot: false,
    input: [{ atSeconds: 0, key: 'space', isDown: true }]
  })
  check('holding the key moves the sprite', spriteX(held.text) > 0, held.text)

  await call('gandi_input', { key: 'space', isDown: false })
  const stopped = await call('gandi_stop', {})
  check('scripts can be stopped', /stopped all scripts/.test(stopped.text), stopped.text)

  // ── artwork the AI draws, on the stage and as a bitmap ───────────────────
  const NIGHT = `e2e-night-${SUFFIX}`
  const DOT = `e2e-dot-${SUFFIX}`
  const backdropSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
    '<rect width="480" height="360" fill="#1b2a4a"/>' +
    '<circle cx="380" cy="80" r="40" fill="#ffe9a8"/>' +
    '</svg>'
  const backdrop = await call('gandi_costume', {
    target: 'stage',
    name: NIGHT,
    svg: backdropSvg,
    rotationCenterX: 0,
    rotationCenterY: 0
  })
  console.log('--- backdrop ---\n' + backdrop.text + '\n')
  check('a backdrop was added to the stage', backdrop.text.includes(`added backdrop "${NIGHT}" to the stage`), backdrop.text)
  check('the stage lists the new backdrop', new RegExp(`backdrops now: .*${NIGHT}`).test(backdrop.text), backdrop.text)

  // A bitmap exercises the OTHER asset type: load-costume.js picks
  // AssetType.ImageBitmap for anything that is not svg, so a costume created with
  // the vector type would fail to load here.
  const pngBytes = makePng(12, 12, [220, 60, 60, 255])
  const bitmap = await call('gandi_costume', {
    name: DOT,
    base64: pngBytes.toString('base64'),
    dataFormat: 'png'
  })
  console.log('--- bitmap costume ---\n' + bitmap.text + '\n')
  check('a bitmap costume was added', bitmap.text.includes(`added costume "${DOT}"`), bitmap.text)
  check('the sprite lists the new bitmap', new RegExp(`costumes now: .*${DOT}`).test(bitmap.text), bitmap.text)

  const afterArtwork = await call('gandi_inspect', { includeXml: false })
  check('inspect sees the backdrop', new RegExp(`costumes: .*${NIGHT}`).test(afterArtwork.text), afterArtwork.text)
  check('inspect sees the bitmap costume', new RegExp(`costumes: .*${DOT}`).test(afterArtwork.text), afterArtwork.text)

  // ── variables and lists ─────────────────────────────────────────────────
  const VAR2 = `e2e_created_${SUFFIX}`
  const LIST2 = `e2e_list_${SUFFIX}`

  // Values are printed through JSON.stringify so "5" and 5 stay distinguishable,
  // which means a string value shows up quoted. Match either form.
  const showsAssignment = (text, name, value) => new RegExp(`${name}="?${value}"?`).test(text)
  /** The name a variable actually ended up with, read back from the report. */
  const reportedName = (text, prefix) => {
    const line = text.split('\n').find((candidate) => candidate.startsWith('globals:')) ?? ''
    const match = line.match(new RegExp(`(${prefix}[\\w-]*)=`))
    return match === null ? null : match[1]
  }

  const created = await call('gandi_variable', { action: 'create', name: VAR2 })
  check('a global variable was created', new RegExp(`globals: .*${VAR2}=`).test(created.text), created.text)

  const assigned = await call('gandi_variable', { action: 'set', name: VAR2, value: '123' })
  check('the variable holds the assigned value', showsAssignment(assigned.text, VAR2, '123'), assigned.text)

  const listed = await call('gandi_variable', { action: 'create', name: LIST2, type: 'list' })
  check('a list was created', new RegExp(`${LIST2} \\(list\\)=`).test(listed.text), listed.text)

  const renamed = await call('gandi_variable', { action: 'rename', name: VAR2, newName: `${VAR2}_b` })
  const renamedTo = reportedName(renamed.text, VAR2)
  check('the variable was renamed', renamedTo === `${VAR2}_b`, renamed.text)
  check('the value survived the rename', showsAssignment(renamed.text, `${VAR2}_b`, '123'), renamed.text)

  // Delete by the name the editor actually chose: scratch-vm may de-duplicate a
  // requested name, so asserting on the requested spelling would be asserting on
  // an implementation detail of the rename.
  const removed = await call('gandi_variable', { action: 'delete', name: renamedTo ?? `${VAR2}_b` })
  check('the variable was deleted', !new RegExp(`${renamedTo ?? `${VAR2}_b`}=`).test(removed.text), removed.text)
  check('the list survived the deletion', new RegExp(`${LIST2} \\(list\\)=`).test(removed.text), removed.text)

  await call('gandi_variable', { action: 'delete', name: LIST2 })

  // ── custom blocks and comments ───────────────────────────────────────────
  // Written in the compiler's SHORT form: the proccode with names and defaults, but
  // no argument ids and no prototype. The call names its argument by name too. If
  // that expansion is wrong the call cannot resolve its argument, and the only way
  // to catch it is to run it and look at where the sprite ends up.
  const procedureScript = `<xml>
    <block type="procedures_definition" id="e2eDef" x="40" y="600">
      <mutation proccode="nudge %n" argumentnames="amount" argumentdefaults="10"></mutation>
      <next>
        <block type="motion_changexby" id="e2eBody">
          <value name="DX">
            <block type="argument_reporter_string_number" id="e2eReporter">
              <field name="VALUE">amount</field>
            </block>
            <shadow type="math_number"><field name="NUM">10</field></shadow>
          </value>
        </block>
      </next>
    </block>
    <block type="event_whenflagclicked" id="e2eCallHat" x="40" y="420">
      <comment id="e2eNote">calls a custom block with 77</comment>
      <next>
        <block type="procedures_call" id="e2eCall">
          <mutation proccode="nudge %n"></mutation>
          <value name="amount"><shadow type="math_number"><field name="NUM">77</field></shadow></value>
        </block>
      </next>
    </block>
  </xml>`

  await call('gandi_apply', { xml: procedureScript })
  await call('gandi_place', { x: 0, y: 0 })
  const ranProcedure = await call('gandi_run', { seconds: 0.3, screenshot: false })
  check('a custom block call moves the sprite by its argument', spriteX(ranProcedure.text) === 77, ranProcedure.text)

  const readBack = await call('gandi_inspect', {})
  console.log('--- custom block read back ---\n' + readBack.text.slice(0, 700) + '\n')
  check('inspect reports the custom block', /procedures_definition/.test(readBack.text), readBack.text.slice(0, 400))
  check('inspect reports the prototype mutation', /proccode="nudge %n"/.test(readBack.text), readBack.text.slice(0, 400))
  check('inspect reports the resolved argument ids', /argumentids="\[&quot;[^&]+&quot;\]"/.test(readBack.text), readBack.text.slice(0, 400))
  check('inspect reports the argument reporter', /argument_reporter_string_number/.test(readBack.text), readBack.text.slice(0, 400))
  check('inspect reports the comment', /<comment id="e2eNote"[^>]*>calls a custom block with 77<\/comment>/.test(readBack.text), readBack.text.slice(0, 700))

  // A comment is target state and the runtime calls toXML() on every one of them, so
  // a plain object there would break the editor's workspace sync on the next emit.
  // Push another edit through and confirm the editor is still healthy.
  const afterComment = await call('gandi_variable', { action: 'create', name: `e2e_after_note_${SUFFIX}` })
  check('the editor still syncs after a comment was added', /globals: /.test(afterComment.text), afterComment.text)

  // ── replacing a target that has SEVERAL scripts ──────────────────────────
  // getScripts() returns the runtime's own array and deleteBlock shortens it, so the
  // obvious loop deletes only every second script — and a single-script target, which
  // is what every other check here uses, hides that completely.
  const beforeAppend = targetStats((await call('gandi_inspect', {})).text, subject)
  check('the target reports its script count', beforeAppend !== null, String(beforeAppend))

  await call('gandi_apply', {
    mode: 'append',
    xml: `<xml>
      <block type="event_whenkeypressed" id="e2eKeyA" x="600" y="600"><field name="KEY_OPTION">a</field></block>
      <block type="event_whenkeypressed" id="e2eKeyB" x="600" y="700"><field name="KEY_OPTION">b</field></block>
    </xml>`
  })
  const afterAppend = targetStats((await call('gandi_inspect', {})).text, subject)
  check('appending two scripts adds exactly two',
    afterAppend !== null && beforeAppend !== null && afterAppend.scripts === beforeAppend.scripts + 2,
    `${JSON.stringify(beforeAppend)} -> ${JSON.stringify(afterAppend)}`)

  await call('gandi_apply', { xml: '<xml><block type="event_whenflagclicked" id="e2eOnly" x="0" y="0"/></xml>' })
  const afterReplace = targetStats((await call('gandi_inspect', {})).text, subject)
  // The block count matters as much as the script count: a replace that leaves
  // orphaned children behind still looks right in the editor.
  check('replace leaves exactly one script and one block',
    afterReplace !== null && afterReplace.scripts === 1 && afterReplace.blocks === 1,
    JSON.stringify(afterReplace))

  // ── sound ────────────────────────────────────────────────────────────────
  // Synthesized rather than uploaded, so this proves the WAV encoder produces
  // something the editor's own sound loader accepts.
  const sound = await call('gandi_sound', {
    name: `e2e-blip-${SUFFIX}`,
    frequency: 880,
    sweepTo: 1320,
    seconds: 0.15,
    waveform: 'square'
  })
  console.log('--- sound ---\n' + sound.text + '\n')
  check('a synthesized sound was added', sound.text.includes(`added sound "e2e-blip-${SUFFIX}"`), sound.text)
  check('the sound reports its synthesized length', /synthesized \d+ frames at 48000 Hz/.test(sound.text), sound.text)
  check('the sprite lists the new sound', new RegExp(`sounds now: .*e2e-blip-${SUFFIX}`).test(sound.text), sound.text)

  // ── a brand-new empty actor ──────────────────────────────────────────────
  const actorSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">' +
    '<polygon points="24,2 46,44 2,44" fill="#ffab19"/></svg>'
  const actorName = `e2e-actor-${SUFFIX}`
  const actor = await call('gandi_sprite', { action: 'create', name: actorName, svg: actorSvg })
  console.log('--- create sprite ---\n' + actor.text + '\n')
  check('an empty sprite was created', actor.text.includes(`created ${actorName}`), actor.text)

  // Parse the reported costume list rather than pattern-matching the line: the
  // source sprite has picked up extra costumes earlier in this run, so any
  // hard-coded count would be asserting on the test's own history.
  const costumeLine = actor.text.split('\n').find((line) => line.startsWith('costumes:')) ?? ''
  const remainingCostumes = costumeLine
    .replace(/^costumes:\s*/, '')
    .replace(/\s*\(removed.*$/, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  check('the inherited costumes were removed', /removed [1-9]\d* inherited one\(s\)/.test(actor.text), actor.text)
  check('it ends up with exactly one costume', remainingCostumes.length === 1, costumeLine)
  // The NAME is the editor's business (it de-duplicates against names already in
  // the project); what matters is that the survivor is the freshly drawn one and
  // not one inherited from the source sprite.
  check('and the survivors are not the inherited ones',
    !remainingCostumes.some((entry) => entry.includes('e2e-ball') || entry.includes('e2e-dot')),
    costumeLine)

  const actorState = await call('gandi_inspect', { target: actorName })
  check('the new sprite appears in the project', new RegExp(`${actorName} — 0 script\\(s\\), 0 block\\(s\\)`).test(actorState.text), actorState.text)

  // ── a brand-new project is usable straight away ──────────────────────────
  const starterName = `e2e-start-${SUFFIX}`
  const fresh = await call('gandi_new', { sprite: starterName })
  console.log('--- new project ---\n' + fresh.text + '\n')
  check('a new project includes a starter sprite', fresh.text.includes(starterName), fresh.text)

  const freshState = await call('gandi_inspect', {})
  check('the starter sprite is real and empty', new RegExp(`${starterName} — 0 script\\(s\\), 0 block\\(s\\), costumes: costume1`).test(freshState.text), freshState.text)

  // ── restore ──────────────────────────────────────────────────────────────
    if (!keep) {
      await loadProjectBytes(connection, originalArchive)
      const restored = await getProjectJson(connection)
      check('the original project was restored',
        JSON.stringify(restored.targets.map((t) => t.name)) === JSON.stringify(original.targets.map((t) => t.name)),
        restored.targets.map((t) => t.name))
    } else {
      console.log('(keeping the edited project: --keep)')
    }

    console.log(`\n${checks - failures}/${checks} checks passed`)
    if (failures > 0) process.exitCode = 1
  } finally {
    // A lingering CDP socket keeps the event loop alive and would hang the script:
    // close both the plugin's own connection and this script's.
    call?.dispose()
    connection?.close()
    // Gandi keeps a websocket per attached tab, and the bridge re-attaches inside
    // `gandi_status`, so "closed everything I know about" is not the same as "nothing
    // is open". Rather than guess, let pending I/O drain for a moment and then leave:
    // the result has already been printed, and a script that never exits is worse than
    // one that exits deliberately.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  }
}

main().catch((error) => {
  console.error('e2e failed:', error?.stack ?? error)
  process.exitCode = 1
})
