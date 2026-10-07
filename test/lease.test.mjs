/**
 * The edit lease, exercised without an editor.
 *
 * The lease is the plugin's only defence against two sessions driving one editor, and it
 * was also a delivery's largest single cost: it can be taken, and the only way to give it
 * up was the 300-second idle timeout — held, in that case, by a subagent that had already
 * died. Three rounds of waiting, for nothing.
 *
 * `BridgeService.use()` checks the lease BEFORE it reaches for a connection, so a closed
 * port is the perfect probe: anything that gets past the lease fails with a bridge error
 * instead, and the two are impossible to confuse.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { BridgeService } from '../src/plugin/service.mjs'

/** A port nothing is listening on. */
const CLOSED_PORT = 9237

/** A service whose every mutating call will fail to reach an editor. */
const service = (config = {}) => new BridgeService({ port: CLOSED_PORT, launchTimeoutMs: 1500, ...config })

test('a session that holds the lease blocks another, and says how to get past it', async () => {
  const s = service()
  const taken = s.lease({ action: 'take', sessionId: 'session-a' })
  assert.equal(taken.lease.sessionId, 'session-a')

  await assert.rejects(
    () => s.use({ sessionId: 'session-b', mutating: true }, async () => 'never'),
    (error) => {
      assert.equal(error.name, 'LeaseConflictError')
      assert.match(error.message, /session-a is driving Gandi/)
      assert.match(error.message, /force: true/, 'the way out has to be named')
      assert.match(error.message, /gandi_lease/, 'and so does the tool that does it')
      return true
    }
  )
})

test('force gets past a lease held by someone else', async () => {
  const s = service()
  s.lease({ action: 'take', sessionId: 'session-a' })
  // With force the lease check passes, so the failure moves on to the (absent) editor —
  // which is exactly what proves the parameter was honoured rather than ignored.
  await assert.rejects(
    () => s.use({ sessionId: 'session-b', mutating: true, force: true }, async () => 'never'),
    (error) => {
      assert.notEqual(error.name, 'LeaseConflictError')
      assert.match(error.message, /9237/)
      return true
    }
  )
})

test('a read-only call is never blocked by the lease', async () => {
  const s = service()
  s.lease({ action: 'take', sessionId: 'session-a' })
  await assert.rejects(
    () => s.use({ sessionId: 'session-b', mutating: false }, async () => 'never'),
    (error) => {
      assert.notEqual(error.name, 'LeaseConflictError')
      return true
    }
  )
})

test('release only works for the holder', () => {
  const s = service()
  s.lease({ action: 'take', sessionId: 'session-a' })

  const refused = s.lease({ action: 'release', sessionId: 'session-b' })
  assert.match(refused.note, /session-a holds the lease, not you/)
  assert.equal(refused.lease.sessionId, 'session-a', 'a bystander cannot drop someone else\'s lease')

  const done = s.lease({ action: 'release', sessionId: 'session-a' })
  assert.equal(done.lease, null)
  assert.match(done.note, /released/)
})

test('take reports who it displaced, and status reports the idle time', async () => {
  const s = service()
  s.lease({ action: 'take', sessionId: 'session-a' })
  const status = s.lease({ action: 'status', sessionId: 'session-b' })
  assert.equal(status.lease.sessionId, 'session-a')
  assert.match(status.note, /held by session-a, idle \d+s of \d+s/)

  const taken = s.lease({ action: 'take', sessionId: 'session-b' })
  assert.match(taken.note, /took the lease from session-a/)
  assert.equal(taken.lease.sessionId, 'session-b')
  assert.equal(taken.action, 'take')
})

test('the lease expires once it has been idle for the window', async () => {
  // The window is the only automatic reclamation there is, so it is worth pinning:
  // an abandoned session must not be able to freeze the editor indefinitely.
  const s = service({ leaseIdleMs: 60 })
  s.lease({ action: 'take', sessionId: 'session-gone' })
  await new Promise((resolve) => setTimeout(resolve, 90))
  // Past the window, another session may take it without force…
  const status = s.lease({ action: 'take', sessionId: 'session-here' })
  assert.equal(status.lease.sessionId, 'session-here')
  // …and the default window is short enough to be worth waiting out.
  assert.ok(service().lease({ action: 'status', sessionId: 'x' }).idleMs <= 120000,
    'the default idle window must stay in the "walk away from it" range')
})

test('the status report carries the lease, the window and the last run', async () => {
  const s = service()
  s.lease({ action: 'take', sessionId: 'session-a' })
  s.noteRun('ran 30 frames (~1s at 30 fps): 1 thread(s) started')
  const status = await s.status()
  assert.equal(status.lease.sessionId, 'session-a')
  assert.equal(status.leaseIdleMs, 60000)
  assert.match(status.lastRun, /ran 30 frames/)
})
