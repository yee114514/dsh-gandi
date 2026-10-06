import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'
import { starterProject, writeSb3 } from '../src/scratch/sb3.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const outDir = fileURLToPath(new URL('./fixtures', import.meta.url))
mkdirSync(outDir, { recursive: true })

// A blank project, written by the plugin's own offline toolkit — the same bytes
// `scratch_new` would produce.
const project = starterProject({ spriteName: 'probe', stageName: 'Stage' })
const bytes = writeSb3(project.project, project.assets)
const file = join(outDir, 'blank.sb3')
writeFileSync(file, bytes)
console.log('wrote', file, bytes.length, 'bytes')

const before = await listTargets(PORT)
const shell = before.find((t) => t.url.includes('renderer/index.html'))
if (!shell) { console.log('shell not found'); process.exit(1) }

const conn = await CdpConnection.connect(shell.webSocketDebuggerUrl)
const tabId = 'probe' + Date.now().toString(36)
const url = `https://www.ccw.site/gandi?tabId=${tabId}&lang=zh-cn&fromComputer=true`
// Exactly the call the shell makes for "import a local .sb3" (index-De54227Q.js handleImportSB3),
// but with saveToCloud left off: this tab must not push anything to the user's account.
const res = await evaluate(conn, `(async () => {
  try {
    await ViewPreload.addView(${JSON.stringify({ url, tabId, filePath: file, offline: false, lang: 'zh-cn' })})
    return 'ok'
  } catch (e) { return 'ERR ' + e.message }
})()`, { awaitPromise: true })
console.log('addView:', res)
conn.close()

let editor = null
for (let i = 0; i < 40; i++) {
  await sleep(1500)
  const now = await listTargets(PORT)
  editor = now.find((t) => typeof t.url === 'string' && t.url.includes(tabId))
  if (editor && editor.title && editor.title.includes('编辑器')) break
}
console.log('editor target:', editor?.url, '|', editor?.title)
if (!editor) process.exit(1)

const conn2 = await CdpConnection.connect(editor.webSocketDebuggerUrl)
for (let i = 0; i < 30; i++) {
  const state = await evaluate(conn2, `JSON.stringify((() => {
    const root = document.getElementById('root');
    const key = root ? Object.keys(root).find((k) => k.startsWith('__reactContainer')) : null;
    const looksLikeVM = (v) => v && typeof v === 'object' && v.runtime && 'editingTarget' in v && typeof v.greenFlag === 'function';
    let vm = null; const seen = new Set(); let visited = 0;
    const walk = (f, depth) => {
      if (!f || vm || visited > 40000 || depth > 90) return;
      visited++; if (seen.has(f)) return; seen.add(f);
      if (f.memoizedProps && looksLikeVM(f.memoizedProps.vm)) { vm = f.memoizedProps.vm; return }
      walk(f.child, depth + 1); walk(f.sibling, depth);
    };
    if (key) walk(root[key], 0);
    return {
      readyState: document.readyState,
      title: document.title,
      hasVm: !!vm,
      targets: vm ? vm.runtime.targets.map((t) => ({ name: t.getName(), isStage: t.isStage, blocks: Object.keys(t.blocks._blocks || {}).length, costumes: t.getCostumes().length })) : null,
      editingTarget: vm && vm.editingTarget ? vm.editingTarget.getName() : null
    };
  })())`)
  const parsed = JSON.parse(state)
  if (i % 4 === 0 || parsed.hasVm) console.log(i, JSON.stringify(parsed))
  if (parsed.hasVm) break
  await sleep(2000)
}
conn2.close()
