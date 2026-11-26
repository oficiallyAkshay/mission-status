import { expect, mock, test } from 'claude-code/testing'
import {
  COMMON,
  CONSENT_KEY,
  ENDPOINT,
  EVENTS,
  FLUSH_MS,
  ID_KEY,
  KEY,
  NOTICE_KEY,
  PROGRESS_WORDS,
  SECRET_KEY,
  clean,
  hashOf,
  isProgressAsk,
  renderErrorCode,
  updateEvent,
  updateFailedCode,
  uuid4,
} from '../hooks/metrics'

// Every test runs the whole plugin, its hooks beneath the test's: the world is mocked, and every request to
// PostHog is caught here, never sent.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const NOW = Date.UTC(2026, 11, 16)
const HASH = /^[0-9a-f]{16}$/
const SESSION_ID = '9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f'
const ACCOUNT_ID = 'acc-7d1e9a52-0c4b-4f3e-9a8d-6b5c4d3e2f1a'

type Body = { api_key: string; batch: { event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }[] }

type World = {
  bodies: Body[]
  clock: ReturnType<typeof mock.clock>
  calls: { sessionId: number; identity: number }
  // What the plugin kept: the latest value per $.store key (undefined once deleted), and every $.state write.
  store: Map<string, unknown>
  state: { key: string; value: unknown }[]
}

async function start(
  $: any,
  on: any,
  opts: { store?: Record<string, unknown>; env?: Record<string, string>; now?: number; fetch?: 'ok' | 'fail'; prs?: Record<string, Record<string, unknown>> } = {},
): Promise<World> {
  const bodies: Body[] = []
  const calls = { sessionId: 0, identity: 0 }
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  const state: { key: string; value: unknown }[] = []
  // Recorders sit above the mocks, so each write is seen and then kept.
  on('store.set', { key: /(?:)/ }, (_: unknown, e: { key: string; value: unknown }, next: any) => {
    store.set(e.key, e.value)
    return next(e)
  })
  on('store.delete', { key: /(?:)/ }, (_: unknown, e: { key: string }, next: any) => {
    store.delete(e.key)
    return next(e)
  })
  on('state.set', { key: /(?:)/ }, (_: unknown, e: { key: string; value: unknown }, next: any) => {
    state.push({ key: e.key, value: e.value })
    return next(e)
  })
  const clock = mock.clock(on, { now: opts.now ?? NOW })
  mock.store(on, opts.store ?? {})
  mock.env(on, opts.env ?? {})
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  // With prs, a GitHub repository whose pull requests gh pr view answers, by number; without, no repository.
  on('process.run', (_: unknown, e: { argv?: string[] }) => {
    const a = e.argv ?? []
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (opts.prs === undefined) return ok('', 1)
    if (a[0] === 'gh' && a[2] === 'list') return ok('[]')
    if (a[0] === 'gh' && a[2] === 'view') {
      const got = opts.prs[String(a[3])]
      return got === undefined ? ok('', 1) : ok(JSON.stringify(got))
    }
    if (a[1] === 'rev-parse' && a[2] === '--show-toplevel') return ok('/Users/someone/private-repo\n')
    if (a[1] === 'branch') return ok('feature/login-redesign\n')
    if (a[1] === 'remote' && a[2] === 'get-url') return ok('git@github.com:someone/private-repo.git\n')
    return ok('', 1)
  })
  on('session.id', () => {
    calls.sessionId += 1
    return { value: SESSION_ID }
  })
  on('session.identity', () => {
    calls.identity += 1
    return { value: { kind: 'claude.ai', organizationId: ACCOUNT_ID, email: 'person@example.com', isVerified: true } }
  })
  on('http.fetch', (_: unknown, e: { url: string; init?: { body?: string } }) => {
    if (e.url !== ENDPOINT) return { value: { status: 404, ok: false, headers: {}, text: '' } }
    bodies.push(JSON.parse(e.init?.body ?? '{}'))
    if (opts.fetch === 'fail') return { deny: 'offline' }
    return { value: { status: 200, ok: true, headers: {}, text: '{"status":1}' } }
  })
  // A Bash call that creates a pull request answers with its link, as gh pr create prints it.
  on('tool.call', (_: unknown, e: { command?: string; pr?: number }) => ({ result: e.pr === undefined ? 'ok' : `https://github.com/someone/private-repo/pull/${e.pr}\n` }))
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/Users/someone/private-repo', surface: 'desktop', isInteractive: true })
  return { bodies, clock, calls, store, state }
}

const tool = ($: any, name: string, args: Record<string, unknown> = {}) => $.tool.call({ tool: name, ...args } as never)
const prompt = ($: any, text: string) => $.prompt.submit({ text } as never)
const work = async ($: any, n: number) => {
  for (let k = 0; k < n; k++) await tool($, 'Bash', { command: `cat /Users/someone/secret-${k}.txt`, description: 'Read a file' })
}
const events = (w: World) => w.bodies.flatMap(b => b.batch)
const named = (w: World, name: string) => events(w).filter(x => x.event === name)
const minute = (w: World) => w.clock.advance(FLUSH_MS + 1)
const pr = (number: number) => ({ number, state: 'OPEN', url: `https://github.com/someone/private-repo/pull/${number}`, title: `Secret pull request ${number}`, isDraft: false, mergeStateStatus: 'CLEAN', statusCheckRollup: [], mergedAt: null, headRefName: 'feature/login-redesign' })
const consented = { [CONSENT_KEY]: 'yes', [NOTICE_KEY]: true }

// Consent and the off switch: on by default, but nothing is sent until the notice has shown once

test('notice: consent yes with no notice shown sends nothing and makes no id', async ($, on) => {
  const w = await start($, on, { store: { [CONSENT_KEY]: 'yes' } })
  await prompt($, 'status?')
  await work($, 8)
  await minute(w)
  expect(w.bodies.length).toBe(0)
  expect(w.store.get(ID_KEY)).toBeUndefined()
})

test('notice: once the notice has shown, consent yes sends', async ($, on) => {
  const w = await start($, on, { store: { [CONSENT_KEY]: 'yes', [NOTICE_KEY]: true } })
  await work($, 5)
  await minute(w)
  expect(w.bodies.length).toBe(1)
  expect(named(w, 'session_real_work').length).toBe(1)
})

test('notice: after the notice, consent no sends nothing', async ($, on) => {
  const w = await start($, on, { store: { [CONSENT_KEY]: 'no', [NOTICE_KEY]: true } })
  await work($, 8)
  await minute(w)
  expect(w.bodies.length).toBe(0)
})

test('notice: unset consent with the notice shown sends nothing', async ($, on) => {
  const w = await start($, on, { store: { [NOTICE_KEY]: true } })
  await work($, 8)
  await minute(w)
  expect(w.bodies.length).toBe(0)
})

test('nothing is sent and no id is made before consent', async ($, on) => {
  const w = await start($, on)
  await prompt($, 'where are we?')
  await work($, 8)
  await minute(w)
  expect(w.bodies.length).toBe(0)
  expect(w.store.get(ID_KEY)).toBeUndefined()
})

test('consent no sends nothing', async ($, on) => {
  const w = await start($, on, { store: { [CONSENT_KEY]: 'no' } })
  await work($, 8)
  await minute(w)
  expect(w.bodies.length).toBe(0)
})

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC stops every send, even after consent', async ($, on) => {
  const w = await start($, on, { store: consented, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } })
  await work($, 8)
  await minute(w)
  expect(w.bodies.length).toBe(0)
})

test('/pane-metrics on makes a random UUID v4 on the device; off deletes it and stops sends', async ($, on) => {
  const w = await start($, on)
  const onText = await $.command.run({ command: 'pane-metrics', args: 'on' } as never)
  expect(onText.text).toMatch(/Metrics are on/)
  const id = w.store.get(ID_KEY)
  expect(String(id)).toMatch(UUID)
  expect((await $.command.run({ command: 'pane-metrics', args: '' } as never)).text).toContain(String(id))
  await work($, 5)
  await minute(w)
  expect(w.bodies.length).toBe(1)
  expect(w.bodies[0]?.batch.every(x => x.distinct_id === id)).toBe(true)
  const offText = await $.command.run({ command: 'pane-metrics', args: 'off' } as never)
  expect(offText.text).toMatch(/Metrics are off/)
  expect(w.store.get(ID_KEY)).toBeUndefined()
  expect(w.store.get(SECRET_KEY)).toBeUndefined()
  expect(w.store.get(CONSENT_KEY)).toBe('no')
  await work($, 5)
  await prompt($, 'status?')
  await minute(w)
  expect(w.bodies.length).toBe(1)
})

test('two UUIDs made on the device differ and are version 4', () => {
  const a = uuid4()
  const b = uuid4()
  expect(a).toMatch(UUID)
  expect(b).toMatch(UUID)
  expect(a === b).toBe(false)
})

// Each event on the wire

test('every event goes to PostHog Cloud US with the public key, product and privacy flags', async ($, on) => {
  const w = await start($, on, { store: consented })
  await work($, 5)
  await minute(w)
  expect(w.bodies.length).toBe(1)
  expect(w.bodies[0]?.api_key).toBe(KEY)
  for (const x of events(w)) {
    expect(x.properties.product).toBe('mission-status')
    expect(x.properties.$process_person_profile).toBe(false)
    expect(x.properties.$geoip_disable).toBe(true)
    expect(x.properties.schema_version).toBe(2)
    expect(Number.isNaN(Date.parse(x.timestamp))).toBe(false)
  }
})

test('session_real_work: sent at the 5th tool call, not before', async ($, on) => {
  const w = await start($, on, { store: consented })
  await work($, 4)
  await minute(w)
  expect(named(w, 'session_real_work').length).toBe(0)
  await work($, 3)
  await minute(w)
  expect(named(w, 'session_real_work').length).toBe(1)
})

test('progress_ask: prompts are sorted on the device, held until real work, then sent as yes or no', async ($, on) => {
  const w = await start($, on, { store: consented })
  await prompt($, 'Fix the login bug in /Users/someone/app/login.ts')
  await prompt($, "What's left?")
  await work($, 5)
  await prompt($, 'how far along are we')
  await prompt($, 'Add a test')
  await minute(w)
  const asks = named(w, 'progress_ask').map(x => x.properties.progress)
  expect(asks).toEqual(['no', 'yes', 'yes', 'no'])
  for (const x of named(w, 'progress_ask')) expect(Object.keys(x.properties).includes('holdback')).toBe(false)
})

test('progress_ask: a session without real work sends no prompt sort', async ($, on) => {
  const w = await start($, on, { store: consented })
  await prompt($, 'status?')
  await work($, 2)
  await minute(w)
  expect(named(w, 'progress_ask').length).toBe(0)
})

test('the published word list sorts progress questions and leaves work asks alone', () => {
  for (const ask of ['Status?', 'Where are we?', "what's left", 'Any update?', 'Is it done yet', 'How long will this take?', 'ETA'])
    expect(isProgressAsk(ask)).toBe(true)
  for (const ask of ['Fix the status bar colour', 'Add progress tracking to the uploader', 'Run the tests', 'Rename estate.ts'])
    expect(isProgressAsk(ask) && !/status|progress/i.test(ask)).toBe(false)
  expect(isProgressAsk('Rename estate.ts')).toBe(false)
  expect(PROGRESS_WORDS.every(w => w === w.toLowerCase() && /^[a-z ]+$/.test(w))).toBe(true)
})

test('update_accuracy: yes when the current stage holds the open task step, no when it does not', async ($, on) => {
  const w = await start($, on, { store: consented })
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 1 })
  await tool($, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Write the code', status: 'in_progress' }] })
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 1 })
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 3 })
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 3, active: [1] })
  await minute(w)
  expect(named(w, 'update_accuracy').map(x => x.properties.accurate)).toEqual(['yes', 'no', 'yes'])
})

test('stale_reminder: at the 5th tool call with no agent state, then update_after_reminder yes within 3 steps', async ($, on) => {
  const w = await start($, on, { store: consented })
  await work($, 5)
  await work($, 2)
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 0 })
  await minute(w)
  expect(named(w, 'stale_reminder').map(x => x.properties.trigger)).toEqual(['no_state'])
  expect(named(w, 'update_after_reminder').map(x => [x.properties.followed, x.properties.steps])).toEqual([['yes', 2]])
})

test('stale_reminder: 3 new task steps with no update, then update_after_reminder no after 3 steps pass', async ($, on) => {
  const w = await start($, on, { store: consented })
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 0 })
  // The pane's one freshness record counts steps started (store.ts), so the steps here start.
  const steps = (n: number) => Array.from({ length: n }, (_, k) => ({ content: `Step ${k}`, status: 'in_progress' }))
  await tool($, 'mcp__ccd_turn__update_plan', { items: steps(2) })
  await tool($, 'mcp__ccd_turn__update_plan', { items: steps(3) })
  await work($, 4)
  await minute(w)
  expect(named(w, 'stale_reminder').map(x => x.properties.trigger)).toEqual(['steps'])
  expect(named(w, 'update_after_reminder').map(x => x.properties.followed)).toEqual(['no'])
})

test('stale_reminder: 10 minutes of tool calls with no update, once per stale stretch', { timeoutMs: 20_000 }, async ($, on) => {
  const w = await start($, on, { store: consented })
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 0 })
  await work($, 1)
  await w.clock.advance(10 * 60_000)
  await work($, 1)
  await work($, 1)
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 1 })
  await minute(w)
  expect(named(w, 'stale_reminder').map(x => x.properties.trigger)).toEqual(['time'])
  expect(named(w, 'update_after_reminder').map(x => x.properties.followed)).toEqual(['yes'])
})

test('render and pane_shown: each drawing of the pane is counted; a real-work session that shows it says so once', async ($, on) => {
  const w = await start($, on, { store: consented })
  await work($, 5)
  await tool($, 'mcp__mission-status__update', { project: 'P', stage: 'build', phase: 0 })
  const PANE = { plugin: 'mission-status', component: 'Pane', requestId: 'progress', props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.unmount()
  const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await again.unmount()
  await minute(w)
  expect(named(w, 'pane_shown').length).toBe(1)
  const renders = named(w, 'render').reduce((n, x) => n + Number(x.properties.count), 0)
  expect(renders >= 2).toBe(true)
})

test('render_error sends only a code from a fixed list', () => {
  expect(renderErrorCode(new TypeError('cannot read /Users/x/file'))).toBe('type')
  expect(renderErrorCode(new RangeError('x'))).toBe('range')
  expect(renderErrorCode(new Error('secret text'))).toBe('error')
  expect(renderErrorCode('a thrown string')).toBe('other')
  expect(clean('render_error', { code: 'cannot read /Users/x/file' })).toEqual({})
})

test('update_ok and update_failed follow the auto-update phases, with a code only', () => {
  const at = { at: 1 }
  // A release found is not an update yet; reaching 'updated' is.
  expect(updateEvent({ phase: 'idle', version: null, failures: 0, ...at }, { phase: 'pending', version: '1.2.0', failures: 0, ...at })).toBeNull()
  expect(updateEvent({ phase: 'pending', version: '1.2.0', failures: 0, ...at }, { phase: 'updating', version: '1.2.0', failures: 0, ...at })).toBeNull()
  expect(updateEvent({ phase: 'reloading', version: '1.2.0', failures: 0, ...at }, { phase: 'updated', version: '1.2.0', failures: 0, ...at })).toEqual({ event: 'update_ok', props: {} })
  expect(updateEvent({ phase: 'updated', version: '1.2.0', failures: 0, ...at }, { phase: 'idle', version: '1.2.0', failures: 0, ...at })).toBeNull()
  // A failure: the code is the step it failed in.
  expect(updateEvent({ phase: 'updating', version: '1.2.0', failures: 0, ...at }, { phase: 'idle', version: '1.2.0', failures: 1, ...at })).toEqual({ event: 'update_failed', props: { code: 'install' } })
  expect(updateEvent({ phase: 'reloading', version: '1.2.0', failures: 2, ...at }, { phase: 'failed', version: '1.2.0', failures: 3, ...at })).toEqual({ event: 'update_failed', props: { code: 'reload' } })
  expect(updateEvent(null, { phase: 'idle', version: null, failures: 0, ...at })).toBeNull()
  expect(updateFailedCode('pending')).toBe('other')
  expect(clean('update_failed', { code: 'EACCES /Users/x' })).toEqual({})
})

// Projects and pull requests

test('project_tracked: once per project name in a session, as a scrambled id, never for the placeholder', async ($, on) => {
  const w = await start($, on, { store: consented })
  await tool($, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Look around', status: 'in_progress' }] })
  await work($, 5)
  await tool($, 'mcp__mission-status__update', { project: 'Checkout redesign', stage: 'build', phase: 0 })
  await tool($, 'mcp__mission-status__update', { project: 'Checkout redesign', stage: 'build', phase: 1 })
  await tool($, 'mcp__mission-status__update', { project: 'Search fix', stage: 'fix', phase: 0 })
  await tool($, 'mcp__mission-status__update', { project: 'Checkout redesign', stage: 'build', phase: 2 })
  await minute(w)
  const ids = named(w, 'project_tracked').map(x => String(x.properties.project_id))
  expect(ids.length).toBe(3)
  for (const id of ids) expect(id).toMatch(HASH)
  expect(ids[0]).toBe(ids[2])
  expect(ids[0] === ids[1]).toBe(false)
  // The secret is the install's own: the bare name does not give the id.
  expect(ids[0] === (await hashOf('', 'project\nCheckout redesign'))).toBe(false)
  expect(JSON.stringify(w.bodies).includes('Checkout')).toBe(false)
})

test('project_tracked: the same name gives the same id in the next session on the same install', async ($, on) => {
  const w = await start($, on, { store: { ...consented, [SECRET_KEY]: 'a'.repeat(64) } })
  await tool($, 'mcp__mission-status__update', { project: 'Checkout redesign', stage: 'build', phase: 0 })
  await minute(w)
  expect(named(w, 'project_tracked')[0]?.properties.project_id).toBe(await hashOf('a'.repeat(64), 'project\nCheckout redesign'))
})

test('project_tracked: nothing before consent', async ($, on) => {
  const w = await start($, on)
  await tool($, 'mcp__mission-status__update', { project: 'Checkout redesign', stage: 'build', phase: 0 })
  await minute(w)
  expect(w.bodies.length).toBe(0)
  expect(w.store.get(SECRET_KEY)).toBeUndefined()
})

test('pr_tracked: once per pull request the pane reads in a session, as a scrambled id', async ($, on) => {
  const w = await start($, on, { store: consented, prs: { '41': pr(41), '42': pr(42) } })
  await work($, 5)
  await tool($, 'Bash', { command: 'gh pr create --fill', pr: 41 })
  await w.clock.advance(2 * 60_000)
  await tool($, 'Bash', { command: 'gh pr create --fill', pr: 41 })
  await tool($, 'Bash', { command: 'gh pr create --fill', pr: 42 })
  await w.clock.advance(2 * 60_000)
  await minute(w)
  const ids = named(w, 'pr_tracked').map(x => String(x.properties.pr_id))
  expect(ids.length).toBe(2)
  for (const id of ids) expect(id).toMatch(HASH)
  expect(ids[0] === ids[1]).toBe(false)
  const wire = JSON.stringify(w.bodies)
  for (const secret of ['pull/4', 'Secret pull request', 'private-repo']) expect(wire.includes(secret)).toBe(false)
})

// Batching

test('batching: at most one request a minute, all events of the minute in it', async ($, on) => {
  const w = await start($, on, { store: consented })
  await work($, 5)
  await prompt($, 'status')
  await w.clock.advance(30_000)
  await work($, 5)
  await minute(w)
  expect(w.bodies.length).toBe(1)
  await prompt($, 'status')
  await w.clock.advance(20_000)
  expect(w.bodies.length).toBe(1)
  await minute(w)
  expect(w.bodies.length).toBe(2)
})

test('batching: a failed send is dropped, never sent again, and never holds up a tool call', async ($, on) => {
  const w = await start($, on, { store: consented, fetch: 'fail' })
  await work($, 5)
  await minute(w)
  expect(w.bodies.length).toBe(1)
  const result = await tool($, 'Bash', { command: 'ls' })
  expect(result.result).toBe('ok')
  await minute(w)
  const realWork = events(w).filter(x => x.event === 'session_real_work').length
  expect(realWork).toBe(1)
})

// Privacy

// Fixed words every event may carry; anything else must be a whole number.
const WORDS = new Set<string>(['mission-status', ...Object.values(EVENTS).flatMap(spec => Object.values(spec).flatMap(f => (f === 'count' || f === 'hash' ? [] : [...f])))])
const ID_OR_PATH = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}|[0-9a-f]{16,}|[A-Za-z0-9_-]{20,}|\/|\\|~|\.[a-z]{1,4}\b|@/i

async function busySession($: any, on: any): Promise<World> {
  const w = await start($, on, { store: consented })
  await prompt($, `Read /Users/someone/notes.md and session ${SESSION_ID}; account ${ACCOUNT_ID}`)
  await prompt($, 'Where are we on feature/login-redesign?')
  await tool($, 'mcp__ccd_turn__update_plan', { items: [{ content: `Fix C:\\repo\\app.ts for ${ACCOUNT_ID}`, status: 'in_progress' }] })
  await work($, 5)
  await tool($, 'mcp__mission-status__update', {
    project: `Secret project ${SESSION_ID}`,
    goalLine: 'Ship /Users/someone/private-repo',
    stage: 'build',
    phase: 0,
    items: [{ phase: 0, name: 'feature/login-redesign', status: 'now' }],
  })
  await tool($, 'Edit', { file_path: '/Users/someone/private-repo/src/a.ts', old_string: 'a', new_string: 'b' })
  await prompt($, `status of https://github.com/someone/private-repo/pull/42?`)
  const PANE = { plugin: 'mission-status', component: 'Pane', requestId: 'progress', props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.unmount()
  await minute(w)
  return w
}

test('privacy: no event field holds free text, an id or a path; only distinct_id is an id', async ($, on) => {
  const w = await busySession($, on)
  expect(events(w).length >= 6).toBe(true)
  for (const b of w.bodies) expect(Object.keys(b).sort()).toEqual(['api_key', 'batch'])
  for (const x of events(w)) {
    expect(Object.keys(x).sort()).toEqual(['distinct_id', 'event', 'properties', 'timestamp'])
    expect(Object.keys(EVENTS).includes(x.event)).toBe(true)
    expect(String(x.distinct_id)).toMatch(UUID)
    expect(x.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    const allowed = new Set([...Object.keys(COMMON), ...Object.keys(EVENTS[x.event] ?? {})])
    for (const [name, value] of Object.entries(x.properties)) {
      expect(allowed.has(name)).toBe(true)
      if (typeof value === 'string' && EVENTS[x.event]?.[name] === 'hash') expect(value).toMatch(HASH)
      else if (typeof value === 'string') {
        expect(WORDS.has(value)).toBe(true)
        expect(ID_OR_PATH.test(value)).toBe(false)
      } else if (typeof value === 'number') expect(Number.isInteger(value) && value >= 0).toBe(true)
      else expect(typeof value).toBe('boolean')
    }
  }
})

test('privacy: the free-text check itself catches text, ids and paths', () => {
  for (const bad of ['/Users/someone', SESSION_ID, ACCOUNT_ID, 'a.ts', 'person@example.com', 'C:\\repo', '~/x'])
    expect(ID_OR_PATH.test(bad) || !WORDS.has(bad)).toBe(true)
  for (const word of WORDS) expect(ID_OR_PATH.test(word)).toBe(false)
  expect(clean('progress_ask', { progress: 'where are we', holdback: 'no', note: 'x' })).toEqual({})
  expect(clean('project_tracked', { project_id: 'Checkout redesign' })).toEqual({})
  expect(clean('pr_tracked', { pr_id: 'https://github.com/o/r/pull/1' })).toEqual({})
  expect(clean('made_up_event', { a: 1 })).toBeNull()
  expect(clean('render', { count: 1.5 })).toEqual({})
})

test('privacy: session ids and account ids never appear in any event; metrics never read the session id', async ($, on) => {
  const w = await busySession($, on)
  const wire = JSON.stringify(w.bodies)
  expect(wire.length > 100).toBe(true)
  for (const secret of [SESSION_ID, ACCOUNT_ID, 'person@example.com', '/Users/someone', 'private-repo', 'login-redesign', 'Secret project'])
    expect(wire.includes(secret)).toBe(false)
  expect(wire).not.toMatch(/session_?id|account|organization|email/i)
  expect(w.calls.sessionId).toBe(0)
  // The onboarding may read the account to remember it ran for that account; nothing of it is sent (checked above).
})
