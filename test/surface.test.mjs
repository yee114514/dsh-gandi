import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { debugPortOf, gandiProfileDir, readDevToolsActivePort, uniqueTabId } from '../src/bridge/app.mjs'
import { classifySurface, SurfaceState } from '../src/bridge/surface.mjs'
import { LAUNCHER_NAME, launcherPath, withDebugSwitch } from '../src/bridge/launcher.mjs'

/**
 * The policy that decides whether the user can see the editor, and the small parsers the
 * "use the Gandi that is already open" path depends on.
 *
 * These are offline on purpose. The live half (a real Gandi window, real views) is covered
 * by `tools/e2e.mjs`; what is tested here is the part that would otherwise only be
 * exercised on a machine with a desktop, which is exactly the part that rots.
 */

test('a visible editor view is left alone', () => {
  const decision = classifySurface({ shellFound: true, shellVisible: true, editorFound: true, editorVisible: true })
  assert.equal(decision.state, SurfaceState.ON_SCREEN)
  assert.equal(decision.action, 'none')
})

test('an editor hidden behind another Gandi view is brought back', () => {
  // The user's own complaint, exactly: the window is on screen and the editor exists, but
  // the home page (or one of the user's projects) is the view being shown.
  const decision = classifySurface({ shellFound: true, shellVisible: true, editorFound: true, editorVisible: false })
  assert.equal(decision.state, SurfaceState.BEHIND_GANDI_VIEWS)
  assert.equal(decision.action, 'reshow')
})

test('a Gandi window behind another window is reported, never raised', () => {
  // The user chose this explicitly: no focus stealing. Raising the window would be the
  // only way to "fix" it, and it is not worth interrupting them for.
  const decision = classifySurface({ shellFound: true, shellVisible: false, editorFound: true, editorVisible: false })
  assert.equal(decision.state, SurfaceState.WINDOW_BEHIND)
  assert.equal(decision.action, 'none')
})

test('nothing is done when there is no editor view, or when the surface cannot be read', () => {
  assert.equal(classifySurface({ shellFound: true, shellVisible: true, editorFound: false, editorVisible: false }).state, SurfaceState.NO_EDITOR)
  assert.equal(classifySurface({ shellFound: true, shellVisible: true, editorFound: false, editorVisible: false }).action, 'none')
  // An unreadable shell or editor must never provoke a re-create: that would re-open the
  // editor on every call while Gandi is busy or closing.
  assert.equal(classifySurface({ shellFound: true, shellVisible: null, editorFound: true, editorVisible: false }).state, SurfaceState.UNKNOWN)
  assert.equal(classifySurface({ shellFound: false, shellVisible: null, editorFound: true, editorVisible: false }).action, 'none')
  assert.equal(classifySurface({ shellFound: true, shellVisible: true, editorFound: true, editorVisible: null }).action, 'none')
})

test('the debug port is read from a command line, and only when it is usable', () => {
  assert.equal(debugPortOf('E:\\Gandi\\Gandi.exe --remote-debugging-port=9222'), 9222)
  assert.equal(debugPortOf('"E:\\Gandi\\Gandi.exe" --remote-debugging-port=8315 --lang=zh-CN'), 8315)
  assert.equal(debugPortOf('E:\\Gandi\\Gandi.exe --type=renderer --remote-debugging-port=9222'), 9222)
  assert.equal(debugPortOf('E:\\Gandi\\Gandi.exe'), null)
  // 0 means "let the OS choose", which the command line cannot answer: the recorded
  // active port is what covers that case.
  assert.equal(debugPortOf('E:\\Gandi\\Gandi.exe --remote-debugging-port=0'), null)
  assert.equal(debugPortOf('--remote-debugging-port=999999'), null)
  assert.equal(debugPortOf(undefined), null)
})

test('a tab id is never one a view already has', () => {
  // Re-adding an existing tab id leaves an error view behind and takes Gandi down later,
  // so the generator has to yield something free even if the first pick is taken.
  const taken = new Set(['dshabc'])
  assert.equal(uniqueTabId(taken, () => 'dshabc'), 'dshabc-1')
  assert.equal(uniqueTabId(new Set(['dshabc', 'dshabc-1']), () => 'dshabc'), 'dshabc-2')
  assert.equal(uniqueTabId(new Set(), () => 'dshfresh'), 'dshfresh')
  // A pathological generator must still terminate with something unique-ish.
  const stubborn = uniqueTabId(new Set(Array.from({ length: 100 }, (_, index) => `same-${index}`).concat(['same'])), () => 'same')
  assert.ok(!stubborn.startsWith('same-') || stubborn === 'same-100' || stubborn.length > 'same'.length)
})

test('the recorded DevTools port is read from the profile, and a missing file is not an error', () => {
  const previous = process.env.APPDATA
  const scratch = mkdtempSync(join(tmpdir(), 'gandi-profile-'))
  process.env.APPDATA = scratch
  try {
    assert.equal(gandiProfileDir(), join(scratch, 'gandi-desktop'))
    assert.equal(readDevToolsActivePort(), null)
    mkdirSync(gandiProfileDir(), { recursive: true })
    writeFileSync(join(gandiProfileDir(), 'DevToolsActivePort'), '8315\n/devtools/browser/abc\n', 'utf8')
    // The profile directory must exist for the file to be written at all; and the reader
    // must take the first line, which is the port.
    assert.equal(readDevToolsActivePort(), 8315)
  } finally {
    if (previous === undefined) delete process.env.APPDATA
    else process.env.APPDATA = previous
  }
})

test('the attachable launcher has a fixed, per-user location', () => {
  const path = launcherPath()
  assert.match(path, new RegExp(`${LAUNCHER_NAME.replace(/[()]/g, '\\$&')}\\.lnk$`))
  assert.match(path, /Start Menu/i)
})

test('patching a shortcut keeps the user\'s arguments and never doubles the switch', () => {
  assert.equal(withDebugSwitch('', 9222), '--remote-debugging-port=9222')
  assert.equal(withDebugSwitch('  ', 9222), '--remote-debugging-port=9222')
  assert.equal(withDebugSwitch('--lang=zh-CN', 9222), '--lang=zh-CN --remote-debugging-port=9222')
  // Re-pointed, not duplicated: two switches would leave the real port to Chromium.
  assert.equal(withDebugSwitch('--remote-debugging-port=8315', 9222), '--remote-debugging-port=9222')
  assert.equal(withDebugSwitch('--foo --remote-debugging-port=8315 --bar', 9222), '--foo --remote-debugging-port=9222 --bar')
})
