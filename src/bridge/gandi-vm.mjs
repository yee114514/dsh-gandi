/**
 * How the bridge reaches Gandi's virtual machine.
 *
 * TurboWarp publishes `window.vm`, so a page-side operation there can start with
 * `window.vm`. Gandi does not: it deliberately blanks the global after an extension
 * finishes loading (`src/extension-support/extension-load-helper.js` sets
 * `global.Scratch.vm = null` and keeps it that way), and the VM itself only ever
 * exists as a value inside the editor's React tree and its Redux store.
 *
 * So every page-side operation starts by resolving the VM. Three routes are tried,
 * cheapest first, and the answer is memoised on the page for the rest of the session:
 *
 *   1. `window.Scratch.vm` — non-null only in the moment an extension is loading, but
 *      free to check and correct when it is available.
 *   2. The Redux store: the plugins wrapper is wired with
 *      `vm: e.scratchGui.vm`, so `store.getState().scratchGui.vm` is a documented
 *      slice rather than an implementation detail. The store is found on the React
 *      root's `Provider` (its `memoizedProps.store`/`stateNode.store`).
 *   3. A component that was handed `vm` as a prop — the same value, reached without
 *      the store. Kept as a fallback for the day the store shape changes.
 *
 * The memo is revalidated on every call: a stale entry is dropped rather than used,
 * because the editor can tear its VM down and build a new one (opening another tab's
 * project, a hard reload of the page). A cached-but-dead VM would make every later
 * operation fail in a way that looks like "the project is empty".
 *
 * The VM is recognised by shape, not by `instanceof`: the editor's bundle has no
 * exported class to compare against, and the VM is the object that has a runtime, an
 * editing target and a green flag.
 *
 * @module bridge/gandi-vm
 */

/**
 * The shape test plus the three resolution routes, as page-side JavaScript.
 *
 * Deliberately a single expression so it can be dropped into any page script:
 * `const vm = <this>`.
 *
 * NOTE: this string is spliced into page source. It must not contain a backtick —
 * one would close the template literal it is embedded in, and the syntax error
 * surfaces dozens of lines away.
 *
 * @returns {string} a page-side expression evaluating to the VM, or null
 */
export const vmResolverSource = () => `(() => {
  const looksLikeVm = (v) => v !== null && typeof v === 'object' &&
    typeof v.greenFlag === 'function' && v.runtime !== null &&
    typeof v.runtime === 'object' && 'editingTarget' in v;
  if (globalThis.__dshGandiVm !== undefined && looksLikeVm(globalThis.__dshGandiVm)) {
    return globalThis.__dshGandiVm;
  }
  delete globalThis.__dshGandiVm;

  const scratch = globalThis.Scratch;
  if (scratch !== undefined && looksLikeVm(scratch.vm)) {
    globalThis.__dshGandiVm = scratch.vm;
    return scratch.vm;
  }

  const root = document.getElementById('root');
  const entry = root === null
    ? undefined
    : Object.keys(root).find((key) => key.startsWith('__reactContainer'));
  if (entry === undefined) return null;

  const seen = new Set();
  let byProp = null;
  const stores = [];
  const walk = (fiber, depth) => {
    if (fiber === null || depth > 100 || (byProp !== null && stores.length > 0)) return;
    if (seen.has(fiber)) return;
    seen.add(fiber);
    const props = fiber.memoizedProps;
    const node = fiber.stateNode;
    for (const candidate of [props === null ? undefined : props.store,
      node === null ? undefined : node.store,
      node === null || node.props === undefined ? undefined : node.props.store]) {
      if (candidate !== undefined && candidate !== null &&
        typeof candidate.getState === 'function' && stores.length < 4) {
        stores.push(candidate);
      }
    }
    if (byProp === null && props !== null && props !== undefined && looksLikeVm(props.vm)) {
      byProp = props.vm;
    }
    walk(fiber.child, depth + 1);
    walk(fiber.sibling, depth);
  };
  walk(root[entry], 0);

  for (const store of stores) {
    try {
      const state = store.getState();
      const candidate = state === undefined || state.scratchGui === undefined
        ? undefined
        : state.scratchGui.vm;
      if (looksLikeVm(candidate)) {
        globalThis.__dshGandiVm = candidate;
        globalThis.__dshGandiStore = store;
        return candidate;
      }
    } catch (error) {
      // A store that cannot be read is not the store we want.
    }
  }
  if (byProp !== null) {
    globalThis.__dshGandiVm = byProp;
    return byProp;
  }
  return null;
})()`

/**
 * The same resolution, exposed as a page-side statement block that binds `vm`.
 *
 * Page scripts are written with the bootstrap first and then use `vm` directly. The
 * trailing newline is load-bearing: callers are written as
 * `` `(async () => {\n${vmBootstrapSource()}await vm.loadProject(…)\n})()` ``, so
 * without it the closing `})()` of the bootstrap ends up glued to whatever the caller
 * opens with — `})()await` and `const vm = (…)();vm.stopAll()` are both syntax errors,
 * and both were produced by the first version of this file.
 *
 * @returns {string} page-side source declaring a `const vm`
 */
export const vmBootstrapSource = () => `const vm = ${vmResolverSource()};\nif (vm === null) {\n  throw new Error('Gandi editor is not reachable: no virtual machine was found in this page. Open (or let gandi_launch open) an editor tab first.');\n}\n`

/**
 * The editor's Blockly workspace, or null.
 *
 * TurboWarp exposes `window.ScratchBlocks`; Gandi exposes plain `window.Blockly` and
 * its own `getMainWorkspace()` accessor. Both are checked so the same page code runs
 * on either, which keeps this plugin's page sources honest about which editor they
 * are talking to.
 *
 * @returns {string} a page-side expression
 */
export const workspaceSource = () => `(() => {
  const blocks = globalThis.ScratchBlocks ?? globalThis.Blockly;
  if (blocks === undefined || typeof blocks.getMainWorkspace !== 'function') return null;
  try {
    return blocks.getMainWorkspace() ?? null;
  } catch (error) {
    return null;
  }
})()`
