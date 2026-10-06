import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const editor = (await listTargets(PORT)).find((t) => typeof t.url === 'string' && t.url.includes('/gandi'))
if (!editor) { console.log('editor not open'); process.exit(1) }
const conn = await CdpConnection.connect(editor.webSocketDebuggerUrl)

const probe = `JSON.stringify((() => {
  const out = {};
  const S = window.Scratch;
  out.scratchType = typeof S;
  if (S) out.scratchKeys = Object.keys(S).slice(0, 80);
  if (S?.vm) {
    const vm = S.vm;
    out.vmKeys = Object.keys(vm).slice(0, 80);
    out.runtime = !!vm.runtime;
    if (vm.runtime) {
      out.targets = (vm.runtime.targets || []).map((t) => ({ name: t.getName?.(), isStage: t.isStage, blocks: Object.keys(t.blocks?._blocks || {}).length }));
      out.assetTypes = Object.keys(vm.runtime.storage?.AssetType || {});
    }
  }
  if (window.GandiPlugins) {
    out.gandiPluginsType = typeof window.GandiPlugins;
    out.gandiPluginsKeys = Array.isArray(window.GandiPlugins) ? 'array:' + window.GandiPlugins.length : Object.keys(window.GandiPlugins).slice(0, 40);
  }
  if (window.Blockly) {
    out.blocklyKeys = Object.keys(window.Blockly).slice(0, 40);
    out.workspaceCount = window.Blockly.Workspace?.WorkspaceDB_ ? Object.keys(window.Blockly.Workspace.WorkspaceDB_).length : null;
  }
  out.scratchAnything = Object.keys(window).filter((k) => /scratch/i.test(k));
  return out;
})())`

console.log(JSON.stringify(JSON.parse(await evaluate(conn, probe)), null, 1))
conn.close()
