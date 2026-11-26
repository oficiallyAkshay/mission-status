import { expect, mock, test } from 'claude-code/testing'
import { MANUAL_COMMAND, updateText } from '../hooks/update-line'
import { RELEASES_URL, RELOAD_LIMIT_MS, isNewer, releaseVersion } from '../hooks/update'

// Auto-update tests. The network (http.fetch), the CLI (process.run), the reload (command.run), files, environment,
// store and clock are all stubs: nothing leaves the machine.

const HOUR = 60 * 60 * 1000
const HOME = '/home/u'
const INSTALLED = `${HOME}/.claude/plugins/installed_plugins.json`

type World = {
  version: string
  market: string | null
  release: string | 'error'
  updateExit: number
  newVersion: string
  env: Record<string, string>
  interactive: boolean
  http: { url: string; init?: unknown }[]
  runs: string[][]
  commands: string[]
  store: Record<string, unknown>
}

const setup = async ($: any, on: any, w: Partial<World> = {}) => {
  const world: World = {
    version: '1.1.0',
    market: 'pub',
    release: 'v1.2.0',
    updateExit: 0,
    newVersion: '1.2.0',
    env: {},
    interactive: true,
    http: [],
    runs: [],
    commands: [],
    ...w,
  }
  let root = ''
  // The pane's own 1 s and 5 s timers do nothing here, so the clock can move hours at once.
  on('clock.every', { ms: [1000, 5000] }, () => ({ deny: 'off in this test' }))
  const clock = mock.clock(on, { now: 100 * HOUR })
  mock.store(on, w.store ?? {})
  mock.env(on, { HOME, ...world.env })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('/.claude-plugin/plugin.json')) {
      root = e.path.slice(0, -'/.claude-plugin/plugin.json'.length)
      return { value: JSON.stringify({ name: 'mission-status', version: world.version }) }
    }
    if (e.path === INSTALLED && world.market)
      return { value: JSON.stringify({ plugins: { [`mission-status@${world.market}`]: [{ installPath: root }], 'other@pub': [{ installPath: '/x' }] } }) }
    return { deny: 'ENOENT' }
  })
  on('http.fetch', (_: unknown, e: { url: string; init?: unknown }) => {
    world.http.push(e)
    if (world.release === 'error') return { value: { ok: false, status: 500, headers: {}, text: '' } }
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ tag_name: world.release, draft: false, prerelease: false }) } }
  })
  const done = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const argv = [...e.argv]
    if (argv[1] !== 'plugin') return done(1)
    world.runs.push(argv)
    if (argv[2] === 'marketplace') return done(0)
    const isOk = world.updateExit === 0
    return done(world.updateExit, JSON.stringify(isOk ? { outcome: 'ok', updateOutcome: 'updated', newVersion: world.newVersion } : { outcome: 'error', message: 'boom' }))
  })
  on('command.run', (_: unknown, e: { command: string }) => {
    world.commands.push(e.command)
    return { text: '' }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  // The last value the mod wrote to its update state.
  let last: unknown = null
  on('state.set', { plugin: 'mission-status', key: 'updateState' }, async (_: unknown, e: { value: unknown }, next: any) => {
    last = e.value
    return next(e)
  })
  const start = async () => {
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: world.interactive })
    await clock.settle()
  }
  await start()
  const state = async () => last as { phase: string; version: string | null; failures: number; at: number } | null
  return { world, clock, start, state }
}

const turnStart = ($: any, agentId?: string) => $.turn.start({ text: 'go', turnId: 't1', ...(agentId ? { agentId } : {}) })
const turnEnd = ($: any, agentId?: string) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...(agentId ? { agentId } : {}) })

test('a newer release installs by itself, reloads, and shows "Updated to" for one minute', async ($, on) => {
  const { world, clock, start, state } = await setup($, on)
  // One request to the releases API, with no account or session data.
  expect(world.http.length).toBe(1)
  expect(world.http[0]?.url).toBe(RELEASES_URL)
  expect(JSON.stringify(world.http[0]?.init ?? {})).not.toMatch(/authorization|session|token/i)
  expect(world.runs.map(a => a.slice(1).join(' '))).toEqual(['plugin marketplace update pub', 'plugin update mission-status@pub --json'])
  expect(world.commands).toEqual(['reload-plugins'])
  expect((await state())?.phase).toBe('reloading')
  // The reload loads the new copy.
  world.version = '1.2.0'
  await start()
  const s = await state()
  expect(s?.phase).toBe('updated')
  expect(updateText(s, clock.now())).toBe('Updated to 1.2.0')
  await clock.advance(59_000)
  expect(updateText(await state(), clock.now())).toBe('Updated to 1.2.0')
  await clock.advance(2_000)
  expect(updateText(await state(), clock.now())).toBeNull()
})

test('auto-update off: a newer release waits, installs nothing and says it is available', async ($, on) => {
  const { world, state } = await setup($, on, { store: { autoUpdate: false } })
  expect(world.http.length).toBe(1)
  expect(world.runs).toEqual([])
  expect(world.commands).toEqual([])
  const s = await state()
  expect(s?.phase).toBe('available')
  expect(updateText(s, 0)).toBe('Version 1.2.0 is available.')
})

test('the same release installs nothing', async ($, on) => {
  const { world, state } = await setup($, on, { release: 'v1.1.0' })
  expect(world.http.length).toBe(1)
  expect(world.runs).toEqual([])
  expect(world.commands).toEqual([])
  expect(updateText(await state(), 0)).toBeNull()
})

test('an older release installs nothing', async ($, on) => {
  const { world } = await setup($, on, { release: 'v1.0.9' })
  expect(world.http.length).toBe(1)
  expect(world.runs).toEqual([])
})

test('a copy installed from a folder never checks or updates itself', { timeoutMs: 20_000 }, async ($, on) => {
  const { world, clock, state } = await setup($, on, { market: null })
  await clock.advance(7 * HOUR)
  expect(world.http).toEqual([])
  expect(world.runs).toEqual([])
  expect((await state())?.phase).toBe('folder')
})

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC stops the check', async ($, on) => {
  const { world, clock } = await setup($, on, { env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  await clock.advance(7 * HOUR)
  expect(world.http).toEqual([])
  expect(world.runs).toEqual([])
})

test('a headless session never checks', async ($, on) => {
  const { world } = await setup($, on, { interactive: false })
  expect(world.http).toEqual([])
})

test('the check runs again every 6 hours, one request each time', async ($, on) => {
  const { world, clock } = await setup($, on, { release: 'v1.1.0' })
  await clock.advance(6 * HOUR)
  expect(world.http.length).toBe(2)
  await clock.advance(6 * HOUR)
  expect(world.http.length).toBe(3)
})

test('a failed check is quiet and counts as no failure', async ($, on) => {
  const { world, state } = await setup($, on, { release: 'error' })
  expect(world.http.length).toBe(1)
  expect(world.runs).toEqual([])
  expect((await state())?.failures ?? 0).toBe(0)
})

test('a failed update keeps the version, retries at the next check, and shows "Update failed" after 3 failures', async ($, on) => {
  const { world, clock, state } = await setup($, on, { updateExit: 1 })
  let s = await state()
  expect(s?.failures).toBe(1)
  expect(updateText(s, clock.now())).toBeNull()
  expect(world.commands).toEqual([])
  // No retry before the next check.
  await clock.advance(HOUR)
  expect(world.runs.length).toBe(2)
  await clock.advance(5 * HOUR)
  expect((await state())?.failures).toBe(2)
  expect(updateText(await state(), clock.now())).toBeNull()
  await clock.advance(6 * HOUR)
  s = await state()
  expect(s?.failures).toBe(3)
  expect(s?.phase).toBe('failed')
  expect(updateText(s, clock.now())).toBe(`Update failed. Run: ${MANUAL_COMMAND}`)
  // The running version stays: no reload ran.
  expect(world.commands).toEqual([])
  // A later success clears it.
  world.updateExit = 0
  await clock.advance(6 * HOUR)
  expect((await state())?.phase).toBe('reloading')
  expect(world.commands).toEqual(['reload-plugins'])
})

test('a newer target version starts its failure count again', async ($, on) => {
  const { world, clock, state } = await setup($, on, { updateExit: 1 })
  expect((await state())?.failures).toBe(1)
  // The next check finds a newer release: its first failure is its own first.
  world.release = 'v1.3.0'
  await clock.advance(6 * HOUR)
  const s = await state()
  expect(s?.version).toBe('1.3.0')
  expect(s?.failures).toBe(1)
})

test('a reload that brings back the old version counts as a failure, with no new try at once', async ($, on) => {
  const { world, start, state } = await setup($, on)
  expect((await state())?.phase).toBe('reloading')
  await start()
  const s = await state()
  expect(s?.phase).toBe('idle')
  expect(s?.failures).toBe(1)
  // No new try at once: the next one waits for the 6-hour check.
  expect(world.runs.length).toBe(2)
})

test('never during a turn: a release found mid-turn installs only after the turn ends', async ($, on) => {
  const { world, clock, state } = await setup($, on, { release: 'v1.1.0' })
  await turnStart($)
  world.release = 'v1.2.0'
  await clock.advance(6 * HOUR)
  expect(world.http.length).toBe(2)
  expect((await state())?.phase).toBe('pending')
  expect(world.runs).toEqual([])
  // A subagent's turn ending is not the main turn ending.
  await turnStart($, 'a1')
  await turnEnd($, 'a1')
  await clock.settle()
  expect(world.runs).toEqual([])
  await turnEnd($)
  await clock.settle()
  expect(world.runs.length).toBe(2)
  expect(world.commands).toEqual(['reload-plugins'])
})

test('release tags: v1.2.0, 1.2.0 and mission-status-v1.2.0 count; drafts, pre-releases and other tags do not', () => {
  expect(releaseVersion({ tag_name: 'v1.2.0' })).toBe('1.2.0')
  expect(releaseVersion({ tag_name: '1.2.0' })).toBe('1.2.0')
  expect(releaseVersion({ tag_name: 'mission-status-v1.2.0' })).toBe('1.2.0')
  expect(releaseVersion({ tag_name: 'v1.3.0', draft: true })).toBeNull()
  expect(releaseVersion({ tag_name: 'v1.3.0', prerelease: true })).toBeNull()
  expect(releaseVersion({ tag_name: 'nightly' })).toBeNull()
  expect(releaseVersion(null)).toBeNull()
  expect(isNewer('1.10.0', '1.9.2')).toBe(true)
  expect(isNewer('1.2.0', '1.2.0')).toBe(false)
  expect(isNewer('1.2', '1.2.1')).toBe(false)
})

test('a reload that does not take within the limit counts as a failure, and a short wait does not', async ($, on) => {
  const { world, clock, state } = await setup($, on)
  expect(world.commands).toEqual(['reload-plugins'])
  // The reload waits for an idle session: a few seconds of typing is no failure.
  await clock.advance(5_000)
  expect((await state())?.failures ?? 0).toBe(0)
  // The old module's timer still fires: the old code still runs.
  await clock.advance(RELOAD_LIMIT_MS)
  const s = await state()
  expect(s?.phase).toBe('idle')
  expect(s?.failures).toBe(1)
})
