import { expect, mock, test } from 'claude-code/testing'
import { backoffMs, ciOf, ghDue, nextGh, storeKey, GH_IDLE_MS, GH_MAX_MS, GH_MS, GIT_MS } from '../hooks/readers'
import type { RepoRead } from '../hooks/readers'

// ui.find ignores alt: a drawing is found by its description through findAll.
const svgAlt = async (ui: { findAll: (q: { type: string }) => Promise<{ props?: Record<string, unknown> }[]> }, alt: RegExp) =>
  (await ui.findAll({ type: 'Svg' })).find(x => alt.test(String(x.props?.alt ?? '')))

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type World = {
  git?: 'ok' | 'missing' | 'norepo'
  gh?: 'ok' | 'missing' | 'signedout' | 'fail'
  remote?: boolean
  prs?: Record<string, unknown>[]
  upstream?: string
}
const OPEN_PR = { number: 7, state: 'OPEN', url: 'https://github.com/o/r/pull/7', title: 'Add the card', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }

// A fake host: git and gh answer from the world; calls are counted by kind.
function host(on: any, w: World) {
  const calls = { gitStatus: 0, gh: 0, top: 0 }
  on('agent.list', () => ({ value: [] }))
  on('process.run', (_: unknown, e: { argv?: string[] }) => {
    const a = e.argv ?? []
    const ok = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (a[0] === 'git') {
      if (w.git === 'missing') throw new Error('spawn git ENOENT')
      if (a[1] === 'rev-parse' && a[2] === '--show-toplevel') {
        calls.top++
        return w.git === 'norepo' ? ok('', 128, 'fatal: not a git repository') : ok('/repo\n')
      }
      if (a[1] === 'branch') return ok('feature/x\n')
      if (a[1] === 'rev-parse' && a[2] === '@{u}') return ok(`${w.upstream ?? 'u1'}\n`)
      if (a[1] === 'rev-parse') return ok('abc\n')
      if (a[1] === 'merge-base') return ok('abc\n')
      if (a[1] === 'rev-list') return ok(a[3]?.startsWith('HEAD..') ? '2\n' : '3\n')
      if (a[1] === 'diff') return ok(' 4 files changed, 120 insertions(+), 30 deletions(-)\n')
      if (a[1] === 'status') {
        calls.gitStatus++
        return ok('')
      }
      if (a[1] === 'remote') return ok(w.remote === false ? '' : 'origin\n')
      return ok('')
    }
    if (a[0] === 'gh') {
      calls.gh++
      if (w.gh === 'missing') throw new Error('spawn gh ENOENT')
      if (w.gh === 'signedout') return ok('', 4, 'To get started with GitHub CLI, please run:  gh auth login')
      if (w.gh === 'fail') return ok('', 1, 'HTTP 502: Bad Gateway')
      return ok(JSON.stringify(w.prs ?? []))
    }
    return ok('')
  })
  return calls
}

const mountText = async ($: any, re: RegExp) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const found = (await ui.find({ type: 'Text', text: re }))?.text
  await ui.unmount()
  return found as string | undefined
}
// Starts a session on the fake host with a mocked clock and store: the plugin polls at start and every 5 s.
async function boot($: any, on: any, w: World, entries: Record<string, unknown> = {}, now = Date.now()) {
  const clock = mock.clock(on, { now })
  // The plugin's own store, in memory, shared by every session of the test.
  const store = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: store.get(e.key) }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_: unknown, e: { key: string }) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  const calls = host(on, w)
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // The pane is open: git and GitHub are read only while it is.
  on('ui.panes', () => ({ value: [{ id: 'progress', title: 'Progress', isShown: true, isFocused: false, isPlaced: true }] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  return { clock, calls, store, shared: () => store.get(storeKey('/repo')) as RepoRead | undefined }
}
const send = async ($: any, clock: { settle: () => Promise<void> }, args: Record<string, unknown> = {}) => {
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 1, phases: ['Plan', 'Build', 'Test'], ...args } as never)
  await clock.settle()
}


// The poll tick: the plugin polls every 5 s; git and GitHub keep their own, longer turns.
const TICK = 5_000

test('merge card: hidden when git is missing', async ($, on) => {
  const { clock, calls } = await boot($, on, { git: 'missing', gh: 'ok', prs: [OPEN_PR] })
  await send($, clock)
  expect(calls.gh).toBe(0)
  expect(await mountText($, /^Merge$/)).toBeUndefined()
})

test('merge card: hidden when the folder is not a git repository', async ($, on) => {
  const { clock, calls } = await boot($, on, { git: 'norepo', gh: 'ok', prs: [OPEN_PR] })
  await send($, clock)
  expect(calls.top).toBeGreaterThan(0)
  expect(calls.gh).toBe(0)
  expect(await mountText($, /^Merge$/)).toBeUndefined()
})

test('merge card: GitHub CLI missing shows the git facts and one line', async ($, on) => {
  const { clock } = await boot($, on, { gh: 'missing' })
  await send($, clock)
  expect(await mountText($, /^Merge$/)).toBe('Merge')
  expect(await mountText($, /^2 behind main$/)).toBe('2 behind main')
  expect(await mountText($, /^Pull request state needs the GitHub CLI\.$/)).toBeTruthy()
})

test('merge card: GitHub CLI not signed in shows the same line', async ($, on) => {
  const { clock, shared } = await boot($, on, { gh: 'signedout' })
  await send($, clock)
  expect(shared()?.gh).toBe('missing')
  expect(await mountText($, /^Pull request state needs the GitHub CLI\.$/)).toBeTruthy()
})

test('merge card: no GitHub remote means no GitHub read and no line', async ($, on) => {
  const { clock, calls } = await boot($, on, { remote: false, gh: 'ok' })
  await send($, clock)
  expect(calls.gh).toBe(0)
  expect(await mountText($, /^Merge$/)).toBe('Merge')
  expect(await mountText($, /Pull request/)).toBeUndefined()
})

test('merge card: an open pull request shows its state, CI and review', async ($, on) => {
  const { clock } = await boot($, on, { gh: 'ok', prs: [OPEN_PR] })
  await send($, clock)
  expect(await mountText($, /^CI passing$/)).toBe('CI passing')
  expect(await mountText($, /^Review needed$/)).toBe('Review needed')
})

test('poll timing: git every 15 s while the pane is open, GitHub every 60 s while a pull request is open', async ($, on) => {
  const { clock, calls, shared } = await boot($, on, { gh: 'ok', prs: [OPEN_PR] })
  const git0 = calls.gitStatus
  for (let k = 0; k < 12; k++) await clock.advance(TICK)
  // 12 polls 5 s apart, 60 s in all: a git read every 15 s, 4 more; GitHub at 0 and 60 s.
  expect(git0).toBe(1)
  expect(calls.gitStatus).toBe(5)
  expect(calls.gh).toBe(2)
  expect(shared()?.prs[0]?.number).toBe(7)
})

test('poll timing: with no open pull request GitHub waits 5 minutes, or reads when the upstream moves', async ($, on) => {
  const w: World = { gh: 'ok', prs: [] }
  const { clock, calls, shared } = await boot($, on, w)
  expect(calls.gh).toBe(1)
  for (let k = 0; k < 12; k++) await clock.advance(TICK)
  expect(calls.gh).toBe(1)
  // A push moves the upstream: a pull request may exist now.
  w.upstream = 'u2'
  w.prs = [OPEN_PR]
  await clock.advance(TICK)
  expect(calls.gh).toBe(2)
  expect(shared()?.prs[0]?.number).toBe(7)
})

test('poll timing: with no pull request and no change, GitHub reads again after 5 minutes', async ($, on) => {
  const { clock, calls } = await boot($, on, { gh: 'ok', prs: [] })
  for (let k = 0; k < 59; k++) await clock.advance(TICK)
  expect(calls.gh).toBe(1)
  await clock.advance(TICK)
  expect(calls.gh).toBe(2)
})

test('backoff: a failed GitHub read waits 60 s, then 120 s, up to 10 minutes, and keeps the last pull requests', async ($, on) => {
  expect([1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([60_000, 120_000, 240_000, 480_000, GH_MAX_MS, GH_MAX_MS])
  const w: World = { gh: 'ok', prs: [OPEN_PR] }
  const { clock, calls, shared } = await boot($, on, w)
  w.gh = 'fail'
  for (let k = 0; k < 12; k++) await clock.advance(TICK)
  expect(calls.gh).toBe(2)
  // 55 s later: still inside the 60 s wait.
  for (let k = 0; k < 11; k++) await clock.advance(TICK)
  expect(calls.gh).toBe(2)
  await clock.advance(TICK)
  expect(calls.gh).toBe(3)
  const r = await shared($)
  expect(r?.failures).toBe(2)
  expect(r?.nextGhAt).toBe(clock.now() + 120_000)
  expect(r?.prs[0]?.number).toBe(7)
  // A good read clears the backoff.
  w.gh = 'ok'
  for (let k = 0; k < 24; k++) await clock.advance(TICK)
  expect(shared()?.failures).toBe(0)
})

test('failed source read: the card keeps the last pull request and says when it tries again', async ($, on) => {
  const w: World = { gh: 'ok', prs: [OPEN_PR] }
  const { clock } = await boot($, on, w)
  await send($, clock)
  w.gh = 'fail'
  for (let k = 0; k < 12; k++) await clock.advance(GIT_MS)
  expect(await mountText($, /^Pull request read failed; this shows the last good read\. Next try in (under 1|1|2) min\.$/)).toBeTruthy()
  expect(await mountText($, /^CI passing$/)).toBe('CI passing')
})

test('one poller per repository: a fresh shared read is used, not read again', async ($, on) => {
  const t = Date.now()
  const entry: RepoRead = {
    repo: '/repo', gitAt: t - 2_000, sig: 'feature/x@u1', ghAt: t - 10_000, gh: 'ok', failures: 0, nextGhAt: t + 20_000, lease: 0,
    git: { branch: 'feature/x', ahead: 9, behind: 0, files: 1, added: 5, removed: 1, dirty: 0 },
    prs: [{ number: 42, state: 'OPEN', url: 'u', title: 'Shared', ci: 'running' }],
  }
  const { clock, calls, shared } = await boot($, on, { gh: 'ok', prs: [OPEN_PR] }, { [storeKey('/repo')]: entry }, t)
  // Another session read 2 s ago: no git read and no GitHub read here; the pane shows the shared facts.
  expect(calls.gitStatus).toBe(0)
  expect(calls.gh).toBe(0)
  await send($, clock)
  expect(await mountText($, /^\+5 −1$/)).toBe('+5 −1')
  expect(await mountText($, /^CI running$/)).toBe('CI running')
  // 5 s on, the git read is due here; GitHub still serves from the shared read until its 60 s are up.
  await clock.advance(GIT_MS)
  expect(calls.gitStatus).toBeGreaterThan(0)
  expect(calls.gh).toBe(0)
  // This session's read goes back to the store for the others.
  expect(shared()?.gitAt).toBeGreaterThanOrEqual(t + GIT_MS)
})

test('one poller per repository: a session waits while another holds the GitHub read', async ($, on) => {
  const t = Date.now()
  const { calls } = await boot($, on, { gh: 'ok', prs: [OPEN_PR] }, {
    [storeKey('/repo')]: { repo: '/repo', gitAt: t, sig: 'feature/x@u1', ghAt: t - 60_000, gh: 'ok', failures: 0, nextGhAt: t - 1, lease: t + 10_000, git: null, prs: [] },
  }, t)
  expect(calls.gh).toBe(0)
})

test('one poller per repository: shared reads unused for 7 days are deleted', async ($, on) => {
  const t = Date.now()
  const { store } = await boot($, on, { gh: 'ok' }, { 'repo:/old': { repo: '/old', gitAt: t - 8 * 24 * 3600_000 }, 'other-key': 1 }, t)
  expect(store.has('repo:/old')).toBe(false)
  expect(store.get('other-key')).toBe(1)
  expect(store.has(storeKey('/repo'))).toBe(true)
})

test('ghDue and nextGh: the schedule rules', () => {
  const base: RepoRead = { repo: '/r', gitAt: 0, git: null, sig: 'b@1', ghAt: 0, gh: 'ok', prs: [], failures: 0, nextGhAt: 100, lease: 0 }
  expect(ghDue({ ...base, gh: 'idle' }, 'b@1', 0)).toBe(true)
  expect(ghDue(base, 'b@1', 99)).toBe(false)
  expect(ghDue(base, 'b@1', 100)).toBe(true)
  expect(ghDue(base, 'b@2', 0)).toBe(true)
  // A moved upstream does not cut a failure backoff short.
  expect(ghDue({ ...base, gh: 'failed' }, 'b@2', 0)).toBe(false)
  expect(ghDue({ ...base, lease: 50 }, 'b@1', 200)).toBe(true)
  expect(ghDue({ ...base, lease: 500 }, 'b@1', 200)).toBe(false)
  expect(nextGh('ok', [{ number: 1, state: 'OPEN', url: '', title: '' }], 0, 0)).toBe(GH_MS)
  expect(nextGh('ok', [{ number: 1, state: 'MERGED', url: '', title: '' }], 0, 0)).toBe(GH_IDLE_MS)
  expect(nextGh('missing', [], 0, 0)).toBe(GH_MAX_MS)
  expect(nextGh('failed', [], 1, 0)).toBe(60_000)
})

test('state: stale after 15 minutes with no update shows the age in amber', async ($, on) => {
  const { clock } = await boot($, on, { git: 'norepo' })
  await send($, clock)
  await clock.advance(23 * 60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /^No update from the agent for 2[23] min\./ })
  expect(line?.props?.color).toBe('warning')
  await ui.unmount()
})

test('state: fresh within 15 minutes shows no stale line', async ($, on) => {
  const { clock } = await boot($, on, { git: 'norepo' })
  await send($, clock)
  await clock.advance(14 * 60_000)
  expect(await mountText($, /^No update from the agent/)).toBeUndefined()
})

test('state: all done shows one green line, and no stale line', { timeoutMs: 20_000 }, async ($, on) => {
  const { clock } = await boot($, on, { git: 'norepo' })
  await send($, clock, { phase: 0 })
  await send($, clock, { phase: 3 })
  await clock.advance(60 * 60_000)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const line = await ui.find({ type: 'Text', text: /^All 3 stages are done\./ })
  expect(line?.props?.color).toBe('success')
  expect(await svgAlt(ui, /^All stages are done\.$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Stage \d of 3/)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^No update from the agent/ })).toBeFalsy()
  await ui.unmount()
})

test('state: empty before any update offers the Update button', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^No progress yet\./ })).toBeTruthy()
  expect(await ui.find({ key: 'update-empty' })).toBeTruthy()
  await ui.unmount()
})

test('light theme: accent text uses the theme key, not a fixed colour', async ($, on) => {
  const { clock } = await boot($, on, { git: 'norepo' })
  await send($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The current stage's timer is accent text.
  const timer = await ui.find({ type: 'Text', text: /^00:0\d$/ })
  expect(timer?.props?.color).toBe('merged')
  await ui.unmount()
})

test('item CI: the checks of an item pull request give its state and run time', () => {
  const t0 = '2026-11-25T05:00:00Z'
  expect(ciOf([])).toEqual({ state: 'none', start: null, end: null })
  const done = ciOf([
    { status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: t0, completedAt: '2026-11-25T05:03:10Z' },
    { status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-25T05:00:30Z', completedAt: '2026-11-25T05:04:05Z' },
  ])
  expect(done.state).toBe('passing')
  expect((done.end ?? 0) - (done.start ?? 0)).toBe(245_000)
  const running = ciOf([{ status: 'IN_PROGRESS', conclusion: '', startedAt: t0, completedAt: '0001-01-01T00:00:00Z' }])
  expect(running.state).toBe('running')
  expect(running.end).toBe(null)
  expect(ciOf([{ status: 'COMPLETED', conclusion: 'FAILURE', startedAt: t0, completedAt: t0 }]).state).toBe('failing')
})

test('poll timing: an agent update reads GitHub at once, before its 60 s turn', async ($, on) => {
  const { clock, calls } = await boot($, on, { gh: 'ok', prs: [OPEN_PR] })
  const before = calls.gh
  for (let k = 0; k < 3; k++) await clock.advance(GIT_MS)
  expect(calls.gh).toBe(before)
  await send($, clock)
  expect(calls.gh).toBe(before + 1)
})

test('background cut: with the pane closed, git and GitHub are not read', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  const calls = host(on, { gh: 'ok', prs: [OPEN_PR] })
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let k = 0; k < 12; k++) await clock.advance(TICK)
  expect(calls.gitStatus).toBe(0)
  expect(calls.gh).toBe(0)
})
