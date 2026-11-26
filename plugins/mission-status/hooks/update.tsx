import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import { UPDATED_SHOWN_MS } from './update-line'

// Auto-update: the mod keeps itself current (product plan, v1 scope item 9).
// The approach (read the install from installed_plugins.json, compare with the newest release, then run
// `claude plugin marketplace update` and `claude plugin update`, then reload the plugins) comes from plan-progress,
// MIT licence, https://github.com/zycck/claude-mods (plugins/plan-progress/hooks/register.tsx: readInstall,
// fetchNewest, autoCheck, updateVersion).

// The public repository's latest release: one request, no account or session data. A placeholder until the
// repository is public. MISSION_STATUS_RELEASES_URL points the check at a local stand-in for a live test.
export const RELEASES_URL = 'https://api.github.com/repos/oficiallyAkshay/mission-status/releases/latest'
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
export const MAX_FAILURES = 3
export const RELOAD_LIMIT_MS = 2 * 60_000
const PLUGIN = 'mission-status'
const CLI_TIMEOUT_MS = 180_000
// Across sessions: when any session last asked GitHub, and what it found, so sessions share one request per 6 hours.
const CHECKED_AT = 'updateCheckedAt'
const FOUND = 'updateFound'

// phase: idle, folder (a development copy), available (auto-update is off and a newer release waits), pending (a newer release waits for the turn to end), updating (the CLI
// runs), reloading (installed, the plugins reload), updated (shown for a minute), failed (3 failures or more).
export type UpdateState = { phase: string; version: string | null; failures: number; at: number } | null
const updateState = atom({ plugin: 'mission-status', key: 'updateState' } as const, null as UpdateState)
// The person's choice, asked in the onboarding: on unless they turned it off. Kept across sessions in AUTO_KEY.
const autoUpdate = atom({ plugin: 'mission-status', key: 'autoUpdate' } as const, null as boolean | null)
export const AUTO_KEY = 'autoUpdate'

export async function isAutoUpdateOn($: EngineInterface): Promise<boolean> {
  const v = await read($, autoUpdate)
  if (v !== null) return v
  return (await fromStore($, AUTO_KEY)) !== false
}

// Turns auto-update on or off; on, the check runs at once.
export async function setAutoUpdate($: EngineInterface, isOn: boolean): Promise<void> {
  await update($, autoUpdate, () => isOn)
  await Promise.resolve()
    .then(() => $.store.set(AUTO_KEY, isOn))
    .catch(() => undefined)
  if (isOn) await autoCheck($).catch(() => undefined)
}

// The person presses Update now on a release that waits: it installs once, as an auto-update would.
export async function updateNow($: EngineInterface): Promise<void> {
  const s = await read($, updateState)
  if (s?.phase !== 'available' || s.version === null) return
  await set($, x => ({ ...base(x), phase: 'pending' }))
  isDue = true
  await installUpdate($)
}

type Install = { version: string; market: string | null }
let install: Promise<Install> | null = null
// True while a main-loop turn runs. An update never installs or reloads inside a turn.
let isInTurn = false
let isRunning = false
// True when a check found a newer release that has not been tried yet. A failure waits for the next check.
let isDue = false
// The 6 h check timer; a new session.start cancels it before it registers again.
let checkTimer: { cancel: () => void } | null = null

const samePath = (a: string, b: string) => {
  const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '')
  return norm(a) === norm(b)
}

// How this copy is installed: from a marketplace (market set), or from a folder (market null: a development copy,
// which never updates itself).
export async function readInstall($: EngineInterface): Promise<Install> {
  const root = $.plugin.root
  const manifest = await $.fs.read(`${root}/.claude-plugin/plugin.json`).catch(() => '{}')
  let version = ''
  try {
    version = String((JSON.parse(manifest) as { version?: unknown }).version ?? '')
  } catch {}
  try {
    const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
    const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${home}/.claude`
    const list = JSON.parse(await $.fs.read(`${dir}/plugins/installed_plugins.json`)) as { plugins?: Record<string, { installPath?: string }[]> }
    for (const [id, rows] of Object.entries(list.plugins ?? {}))
      for (const row of rows)
        if (id.startsWith(`${PLUGIN}@`) && row.installPath && samePath(row.installPath, root)) return { version, market: id.slice(PLUGIN.length + 1) }
  } catch {}
  return { version, market: null }
}

// 1.10.0 is newer than 1.9.2; a part that is not a number counts as 0.
export const isNewer = (a: string, b: string) => {
  const pa = a.split('.').map(n => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map(n => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

// The version of a release: tag v1.2.0, 1.2.0 or mission-status-v1.2.0; null for a draft, a pre-release or no version.
export const releaseVersion = (r: unknown): string | null => {
  const o = (r ?? {}) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
  if (o.draft === true || o.prerelease === true || typeof o.tag_name !== 'string') return null
  const m = /^(?:mission-status-)?v?(\d+(?:\.\d+)*)$/.exec(o.tag_name)
  return m?.[1] ?? null
}

// One request to the GitHub releases API. No headers but the API's own; no account or session data.
async function fetchNewest($: EngineInterface): Promise<string | null> {
  // The stand-in address is honoured only on this machine, so the variable cannot send the check elsewhere.
  const local = (await $.env.get('MISSION_STATUS_RELEASES_URL')) ?? ''
  const url = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(local) ? local : RELEASES_URL
  const r = await $.http.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': PLUGIN } })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const newest = releaseVersion(JSON.parse(r.text))
  await Promise.resolve()
    .then(async () => {
      await $.store.set(CHECKED_AT, await $.clock.now())
      await $.store.set(FOUND, newest)
    })
    .catch(() => {})
  return newest
}

function fromStore($: EngineInterface, key: string): Promise<unknown> {
  return Promise.resolve()
    .then(() => $.store.get(key))
    .catch(() => undefined)
}

function set($: EngineInterface, fn: (s: UpdateState) => UpdateState) {
  return update($, updateState, fn)
}
function base(s: UpdateState) {
  return s ?? { phase: 'idle', version: null, failures: 0, at: 0 }
}

// The check: at session start and every 6 hours. A newer release installs at once when no turn runs, else when the
// turn ends. A failed check is quiet and counts as no failure.
export async function autoCheck($: EngineInterface): Promise<void> {
  if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return
  const me = await (install ??= readInstall($))
  if (!me.market) return void (await set($, s => ({ ...base(s), phase: 'folder' })))
  const checkedAt = await fromStore($, CHECKED_AT)
  let found = (await fromStore($, FOUND)) as string | null | undefined
  if (typeof checkedAt !== 'number' || (await $.clock.now()) - checkedAt >= CHECK_EVERY_MS) {
    try {
      found = await fetchNewest($)
    } catch {
      return
    }
  }
  if (typeof found !== 'string' || !isNewer(found, me.version)) return
  const s = await read($, updateState)
  if (s?.phase === 'updating' || s?.phase === 'reloading') return
  // A failure waits a full check period before the next try. This also stops a loop where a reload that brings back
  // the old code starts the check, and the check installs and reloads again.
  if (s && s.failures > 0 && (await $.clock.now()) - s.at < CHECK_EVERY_MS) return
  const version = found
  // Auto-update off: the pane says a release waits and offers Update now.
  // A new target version starts its failure count again.
  const fresh = (x: UpdateState) => (x?.version === version ? base(x) : { ...base(x), phase: 'idle', failures: 0 })
  if (!(await isAutoUpdateOn($))) return void (await set($, x => ({ ...fresh(x), phase: fresh(x).phase === 'failed' ? 'failed' : 'available', version })))
  await set($, x => ({ ...fresh(x), phase: fresh(x).phase === 'failed' ? 'failed' : 'pending', version }))
  isDue = true
  if (!isInTurn) await installUpdate($)
}

// The last line of the CLI's --json answer that parses.
const lastJson = (text: string) => {
  for (const line of text.trim().split('\n').reverse())
    try {
      return JSON.parse(line) as { outcome?: string; updateOutcome?: string; newVersion?: string; message?: string }
    } catch {}
  return null
}

// The claude binary of this session where the host names it (the desktop's is off PATH), else the one on PATH.
async function claudeCli($: EngineInterface) {
  const own = (await $.env.get('CLAUDE_CODE_EXECPATH')) ?? ''
  return /(^|[\\/])claude(\.exe)?$/i.test(own) ? own : 'claude'
}

// A failure keeps the running version and waits for the next check; the 3rd shows "Update failed".
async function fail($: EngineInterface, version: string | null) {
  const at = await $.clock.now()
  await set($, s => {
    const failures = base(s).failures + 1
    return { phase: failures >= MAX_FAILURES ? 'failed' : 'idle', version, failures, at }
  })
}

// Installs the pending release: the marketplace first (without it `plugin update` finds nothing new), then the plugin.
export async function installUpdate($: EngineInterface): Promise<void> {
  if (isInTurn || isRunning || !isDue) return
  const s = await read($, updateState)
  if (!s?.version || (s.phase !== 'pending' && s.phase !== 'failed')) return
  const me = await (install ??= readInstall($))
  if (!me.market) return
  isRunning = true
  isDue = false
  const target = s.version
  try {
    await set($, x => ({ ...base(x), phase: 'updating', version: target }))
    const cli = await claudeCli($)
    const pulled = await $.process.run([cli, 'plugin', 'marketplace', 'update', me.market], { timeoutMs: CLI_TIMEOUT_MS })
    if (pulled.exitCode !== 0) throw new Error('marketplace')
    const ran = await $.process.run([cli, 'plugin', 'update', `${PLUGIN}@${me.market}`, '--json'], { timeoutMs: CLI_TIMEOUT_MS })
    const res = lastJson(ran.stdout)
    if (ran.exitCode !== 0 || res?.outcome !== 'ok') throw new Error('update')
    // Already there counts when it is newer than this copy: an update whose reload did not take.
    if (res.updateOutcome !== 'updated' && !(res.newVersion && isNewer(res.newVersion, me.version))) throw new Error('nothing new')
    const version = res.newVersion ?? target
    await set($, x => ({ ...base(x), phase: 'reloading', version, at: 0 }))
    if (!isInTurn) await reloadPlugins($)
  } catch {
    await fail($, target)
  } finally {
    isRunning = false
  }
}

// The reload loads the new code in place. The command waits for the session to be idle.
async function reloadPlugins($: EngineInterface) {
  const isRun = await Promise.resolve()
    .then(() => $.command.run({ command: 'reload-plugins', args: '' }))
    .then(
      () => true,
      () => false,
    )
  const s = await read($, updateState)
  if (!isRun) return void (await fail($, s?.version ?? null))
  // The reload ends this module and its timers: this timer firing means the old code still runs.
  // The reload command waits for an idle session, so the limit allows a person typing for a while.
  $.clock.after(RELOAD_LIMIT_MS, () =>
    void (async () => {
      const x = await read($, updateState)
      if (x?.phase === 'reloading' && x.version === s?.version) await fail($, x.version)
    })().catch(() => {}),
  )
}

// After a load: a reload that brought the new version shows "Updated to"; one that brought the old version back is a
// failure; a step the old code left half done starts over.
export async function settle($: EngineInterface): Promise<void> {
  const me = await (install ??= readInstall($))
  const now = await $.clock.now()
  const s = await read($, updateState)
  if (!s) return
  if (s.phase === 'reloading' && s.version) {
    if (s.version === me.version) {
      await set($, () => ({ phase: 'updated', version: me.version, failures: 0, at: now }))
      $.clock.after(UPDATED_SHOWN_MS, () => void set($, x => (x?.phase === 'updated' && x.at === now ? { ...x, phase: 'idle' } : x)).catch(() => {}))
    } else await fail($, s.version)
  } else if (s.phase === 'updating') await set($, x => ({ ...base(x), phase: 'pending' }))
  else if (s.phase === 'updated' && now - s.at >= UPDATED_SHOWN_MS) await set($, x => ({ ...base(x), phase: 'idle' }))
}

// Starts the release checks of a session a person sees.
async function startChecks($: EngineInterface): Promise<void> {
  // Read the install again: a reload or a new start may run another version.
  install = null
  await settle($).catch(() => {})
  void autoCheck($).catch(() => {})
  checkTimer?.cancel()
  checkTimer = $.clock.every(CHECK_EVERY_MS, () => void autoCheck($).catch(() => {}))
}

export function registerUpdate(on: On): void {
  install = null
  isInTurn = false
  isRunning = false
  isDue = false
  checkTimer?.cancel()
  checkTimer = null
  // Sessions a person sees only: a headless run (claude -p, an SDK host) never installs anything. The matcher also keeps
  // the start hook apart from register.tsx's own session.start hook.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const r = await next(e)
    await startChecks($)
    return r
  })
  // The desktop app starts its sessions as an SDK host does (not interactive), then attaches: start the checks then.
  on('session.attach', { surface: 'desktop', clientId: /(?:)/ }, async ($, e, next) => {
    const r = await next(e)
    if (checkTimer === null) await startChecks($)
    return r
  })
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) isInTurn = true
    return next(e)
  })
  // Every end reason: the matcher keeps this hook apart from register.tsx's own turn.complete hook.
  on('turn.complete', { reason: ['answer', 'aborted', 'refusal', 'error'] }, async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      if (e.agentId === undefined) {
        isInTurn = false
        // After the turn ends, never during it: the install and the reload start once this dispatch resolves.
        $.clock.after(0, () => void afterTurn($).catch(() => {}))
      }
    }
  })
}

async function afterTurn($: EngineInterface) {
  if (isInTurn) return
  const s = await read($, updateState)
  if (isDue) await installUpdate($)
  else if (s?.phase === 'reloading') await reloadPlugins($)
}
