/**
 * Making the user's OWN Gandi launch attachable.
 *
 * This module exists because of one measured fact: a Gandi started without
 * `--remote-debugging-port` can never be attached to afterwards — Chromium creates its
 * DevTools server during browser-process start-up and nothing turns it on later. So
 * "use the Gandi I already have open" is only possible if the user's own way of opening
 * Gandi carries the switch.
 *
 * Two mechanisms, both explicit and both reported:
 *
 *   - `createLauncher` writes a shortcut of OURS (per-user Start Menu) that launches
 *     Gandi with the switch. Nothing of the user's is touched; the shortcut can be
 *     deleted at any time.
 *   - `patchShortcuts` rewrites the ARGUMENTS of the shortcuts that already exist
 *     (desktop, Start Menu, taskbar pin). It is the one that makes the user's habit
 *     work, so it is reported in full — every path, with its previous arguments, so the
 *     change can be undone by hand.
 *
 * Nothing here runs unless a tool call asked for it. Creating a shortcut and editing
 * somebody's launcher are both user-visible changes to their machine, and silently
 * making them is not the bridge's business.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Raised when a shortcut could not be written. */
export class LauncherError extends Error {
  constructor (message, options) {
    super(message, options)
    this.name = 'LauncherError'
  }
}

/** The name of the shortcut this plugin owns. */
export const LAUNCHER_NAME = 'Gandi (DSH attachable)'

/**
 * Where the shortcut this plugin owns lives.
 *
 * The per-user Start Menu on purpose: it needs no administrator, it is searched by name
 * like any other app, and deleting it restores the machine exactly.
 *
 * @returns {string} absolute path of the .lnk
 */
export const launcherPath = () => {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${LAUNCHER_NAME}.lnk`)
}

/**
 * Run PowerShell and return stdout, tolerating absence.
 * @param {string} script PowerShell source (no backticks: template-literal safety)
 * @param {{timeoutMs?: number}} [options] how long to wait
 * @returns {Promise<{ok: boolean, stdout: string, error: string|null}>} the outcome
 */
const powershell = async (script, options = {}) => {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', error: error?.message ?? String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // already gone
      }
      resolve({ ok: false, stdout, error: `PowerShell timed out after ${options.timeoutMs ?? 15000}ms` })
    }, options.timeoutMs ?? 15000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, error: error?.message ?? String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout: stdout.trim(), error: code === 0 ? null : (stderr.trim() || `PowerShell exited with ${code}`) })
    })
  })
}

/** Quote a value as a PowerShell single-quoted literal. */
const psLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`

/**
 * Create (or refresh) the attachable Gandi shortcut.
 *
 * Idempotent: calling it again rewrites the same file with the current executable and
 * port, so a moved install or a new port is one call away.
 *
 * @param {{appPath: string, port: number, fallbackToScript?: boolean}} options what to point at
 * @returns {Promise<{path: string, kind: 'shortcut'|'script', note: string}>} where it went
 * @throws {LauncherError} when nothing could be written
 */
export const createLauncher = async (options) => {
  const appPath = options.appPath
  const port = options.port
  if (typeof appPath !== 'string' || appPath.length === 0) throw new LauncherError('no Gandi executable is known, so no launcher can be made')
  if (!existsSync(appPath)) throw new LauncherError(`the known Gandi executable does not exist: ${appPath}`)

  const path = launcherPath()
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut(${psLiteral(path)})`,
    `$sc.TargetPath = ${psLiteral(appPath)}`,
    `$sc.Arguments = ${psLiteral(`--remote-debugging-port=${port}`)}`,
    `$sc.WorkingDirectory = ${psLiteral(dirname(appPath))}`,
    `$sc.IconLocation = ${psLiteral(`${appPath},0`)}`,
    `$sc.Description = ${psLiteral('Gandi Desktop started with a debug port, so a DSH session can attach to it')}`,
    '$sc.Save()',
    'Write-Output "saved"'
  ].join('; ')

  const result = await powershell(script)
  if (result.ok && /saved/.test(result.stdout)) {
    return {
      path,
      kind: 'shortcut',
      note: `created ${path} — opening Gandi from it makes that window attachable, so the next session reuses it instead of starting its own`
    }
  }

  if (options.fallbackToScript === false) {
    throw new LauncherError(`could not write the shortcut: ${result.error ?? 'unknown reason'}`)
  }

  // Fallback: a .cmd needs nothing but a text file. It flashes a console window, which
  // is why it is second choice — but "no launcher at all" is worse than a flash.
  const scriptPath = path.replace(/\.lnk$/i, '.cmd')
  const banner = [
    '@echo off',
    'rem Written by the dsh-gandi plugin: launches Gandi Desktop so a DSH session can attach.',
    `start "" "${appPath}" --remote-debugging-port=${port}`,
    ''
  ].join('\r\n')
  try {
    mkdirSync(dirname(scriptPath), { recursive: true })
    writeFileSync(scriptPath, banner, 'utf8')
  } catch (error) {
    throw new LauncherError(`could not write a shortcut (${result.error ?? 'unknown reason'}) nor a launcher script (${error?.message ?? error})`)
  }
  return {
    path: scriptPath,
    kind: 'script',
    note: `could not create a .lnk (${result.error ?? 'unknown reason'}), so a script was written instead: ${scriptPath}`
  }
}

/**
 * Every shortcut on this machine that launches Gandi.
 *
 * The standard locations only — desktop (user and public), both Start Menus, and the
 * taskbar pin folder. Reading `.lnk` targets needs COM, hence PowerShell.
 *
 * @returns {Promise<{path: string, target: string, args: string, workdir: string}[]>} the shortcuts found
 */
export const listGandiShortcuts = async () => {
  // Built with Join-Path and += on purpose: in PowerShell the comma binds TIGHTER than +,
  // so `@($a + '\Desktop', $b + '\Desktop')` silently produces ONE concatenated string —
  // which made this function report "no Gandi shortcut found" on a machine that has two.
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    '$dirs = @()',
    "$dirs += Join-Path $env:USERPROFILE 'Desktop'",
    "$dirs += Join-Path $env:PUBLIC 'Desktop'",
    "$dirs += Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'",
    "$dirs += Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs'",
    "$dirs += Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'",
    '$out = @()',
    'foreach ($d in $dirs) { if (Test-Path $d) { Get-ChildItem -Path $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { try { $sc = $ws.CreateShortcut($_.FullName); if ($sc.TargetPath -like "*Gandi*") { $out += [pscustomobject]@{ Path = $_.FullName; TargetPath = $sc.TargetPath; Arguments = [string]$sc.Arguments; WorkingDirectory = [string]$sc.WorkingDirectory } } } catch { } } } }',
    'ConvertTo-Json -InputObject @($out) -Compress'
  ].join('; ')

  const result = await powershell(script, { timeoutMs: 20000 })
  if (!result.ok) return []
  let parsed
  try {
    parsed = JSON.parse(result.stdout.length > 0 ? result.stdout : '[]')
  } catch {
    return []
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  return entries
    .filter((entry) => typeof entry?.Path === 'string' && entry.Path.length > 0)
    .map((entry) => ({
      path: entry.Path,
      target: typeof entry.TargetPath === 'string' ? entry.TargetPath : '',
      args: typeof entry.Arguments === 'string' ? entry.Arguments : '',
      workdir: typeof entry.WorkingDirectory === 'string' ? entry.WorkingDirectory : ''
    }))
}

/**
 * The arguments a shortcut should carry, with the debug switch in it.
 *
 * Pure, and tested: an already-present switch is re-pointed rather than duplicated (two
 * `--remote-debugging-port` switches would leave the real port to Chromium's argument
 * parsing), and the user's own arguments are preserved around it.
 *
 * @param {string} args the current arguments string
 * @param {number} port the port to use
 * @returns {string} the arguments string to write
 */
export const withDebugSwitch = (args, port) => {
  const before = typeof args === 'string' ? args : ''
  if (/--remote-debugging-port=\d+/.test(before)) return before.replace(/--remote-debugging-port=\d+/, `--remote-debugging-port=${port}`)
  const kept = before.trim()
  return kept.length > 0 ? `${kept} --remote-debugging-port=${port}` : `--remote-debugging-port=${port}`
}

/**
 * Put the debug switch into an existing shortcut's arguments.
 *
 * @param {{path: string, args: string, port: number}} request which shortcut, and the port
 * @returns {Promise<{ok: boolean, before: string, after: string, error: string|null}>} the outcome
 */
export const patchShortcut = async (request) => {
  const before = request.args ?? ''
  const after = withDebugSwitch(before, request.port)
  if (after === before) return { ok: true, before, after, error: null }

  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$sc = $ws.CreateShortcut(${psLiteral(request.path)})`,
    `$sc.Arguments = ${psLiteral(after)}`,
    '$sc.Save()',
    'Write-Output "saved"'
  ].join('; ')
  const result = await powershell(script)
  if (result.ok && /saved/.test(result.stdout)) return { ok: true, before, after, error: null }
  return { ok: false, before, after, error: result.error ?? 'unknown reason' }
}

/**
 * Patch every Gandi shortcut that does not already carry the switch.
 * @param {{port: number}} options the port to write
 * @returns {Promise<{changed: any[], unchanged: any[], failed: any[]}>} a report to hand to the user
 */
export const patchGandiShortcuts = async (options) => {
  const shortcuts = await listGandiShortcuts()
  const changed = []
  const unchanged = []
  const failed = []
  for (const shortcut of shortcuts) {
    if (new RegExp(`--remote-debugging-port=${options.port}\\b`).test(shortcut.args)) {
      unchanged.push(shortcut)
      continue
    }
    const outcome = await patchShortcut({ path: shortcut.path, args: shortcut.args, port: options.port })
    if (outcome.ok) changed.push({ ...shortcut, args: outcome.after, previousArgs: outcome.before })
    else failed.push({ ...shortcut, error: outcome.error })
  }
  return { changed, unchanged, failed }
}

/**
 * Whether the plugin's own launcher is already there.
 * @returns {boolean} true when the .lnk exists
 */
export const launcherExists = () => existsSync(launcherPath())

/** Directory names searched for Gandi shortcuts; exported for tests and diagnostics. */
export const shortcutDirectories = () => {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const programData = process.env.ProgramData ?? 'C:\\ProgramData'
  const home = process.env.USERPROFILE ?? homedir()
  return [
    join(home, 'Desktop'),
    join(process.env.PUBLIC ?? 'C:\\Users\\Public', 'Desktop'),
    join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar')
  ]
}
