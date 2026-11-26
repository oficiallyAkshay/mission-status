import { expect, mock, test } from 'claude-code/testing'
import { accountHash } from '../hooks/onboarding'
import { CONSENT_LINE, DEMO_MS, demoFrame, STILL_SVG, WELCOME_LINE } from '../hooks/onboarding-art'
import { CHECK_EVERY_MS, isNewer, RELEASES_URL, releaseVersion, RELOAD_LIMIT_MS } from '../hooks/update'
import { MANUAL_COMMAND, updateText } from '../hooks/update-line'

// Each block below was one test file. The blocks keep their own helpers and state; one file runs in one child.

// ---- was onboarding.test.tsx
{
const WELCOME = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'mission-status-welcome',
  props: { title: 'Welcome', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BACKDROP = (plugin: string, scene: string) =>
  ({ plugin: 'mission-status', component: 'Backdrop', requestId: 'backdrop', props: { scene, plugin, glass: false } }) as const

type Log = { opened: { id: string; title?: string }[]; closed: string[]; themes: unknown[]; clears: number; commands: string[]; writes: Record<string, unknown[]>; clocks: number[] }

// Stands for the engine beneath the plugin, and records what the onboarding asks of it.
const start = async ($: any, on: any, opts: { surface?: string | null; onboarded?: boolean; surfaces?: string[]; clock?: { at: number } } = {}) => {
  const log: Log = { opened: [], closed: [], themes: [], clears: 0, commands: [], writes: {}, clocks: [] }
  on('tool.register', () => ({ value: {} }))
  on('command.register', (_: unknown, e: { name: string }) => (log.commands.push(e.name), { value: { command: e.name } }))
  on('ui.open', (_: unknown, e: { id: string; title?: string }) => (log.opened.push(e), { value: { isPlaced: true } }))
  on('ui.close', (_: unknown, e: { id: string }) => (log.closed.push(e.id), { value: undefined }))
  on('theme.set', (_: unknown, e: unknown) => (log.themes.push(e), { value: { isDrawn: true, requestId: 'backdrop' } }))
  on('theme.clear', () => (log.clears++, { value: { isDrawn: false, reason: 'cleared' } }))
  // The surfaces the session draws on: the one it started on and any that attach later, as the app reports them.
  const attached: string[] = []
  const startSurface = opts.surface === undefined ? 'desktop' : opts.surface
  on('session.surfaces', () => ({ value: opts.surfaces ?? [...(startSurface === null ? [] : [startSurface]), ...attached] }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', (_: unknown, e: { ms: number }) => (log.clocks.push(e.ms), { value: {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.attach', (_: unknown, e: { clientId: string; surface: string }) => (attached.push(e.surface), { clientId: e.clientId }))
  // Each write passes through to the store; the test keeps a copy.
  on('state.set', { plugin: 'mission-status' }, (_: unknown, e: { key: string; value: unknown }, next: any) => {
    ;(log.writes[e.key] ??= []).push(e.value)
    return next(e)
  })
  // An earlier run that finished the onboarding.
  // The pane clock, set by the test to move the demo.
  if (opts.clock) on('state.get', { plugin: 'mission-status', key: 'now' }, () => ({ value: { value: opts.clock!.at, version: 1 } }))
  if (opts.onboarded) on('state.get', { plugin: 'mission-status', key: 'onboarded' }, () => ({ value: { value: true, version: 1 } }))
  await $.session.start({ cwd: '/', surface: opts.surface === undefined ? 'desktop' : opts.surface, isInteractive: true })
  return log
}
const last = (log: Log, key: string) => log.writes[key]?.at(-1)
// `find` takes no `alt`: read every Svg and match its alt text here.
const svgAlt = async (ui: any, alt: RegExp) => ((await ui.findAll({ type: 'Svg' })) as { props?: { alt?: string } }[]).find(x => alt.test(x.props?.alt ?? ''))
const text = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

test('first run on desktop: the Welcome pane opens and the shader backdrop is set', async ($, on) => {
  const log = await start($, on)
  expect(log.opened.some(o => o.id === 'mission-status-welcome' && o.title === 'Welcome')).toBe(true)
  expect(log.themes).toEqual([{ backdrop: { scene: 'mission-status-onboarding' }, overrideColorScheme: 'dark' }])
  expect(log.commands).toContain('mission-status-welcome')
})

test('after onboarding: no Welcome pane and no backdrop', async ($, on) => {
  const log = await start($, on, { onboarded: true })
  expect(log.opened.some(o => o.id === 'mission-status-welcome')).toBe(false)
  expect(log.themes.length).toBe(0)
})

test('desktop app only: a terminal session gets no onboarding', async ($, on) => {
  const log = await start($, on, { surface: 'terminal' })
  expect(log.opened.some(o => o.id === 'mission-status-welcome')).toBe(false)
  expect(log.themes.length).toBe(0)
})

test('a desktop app that attaches after the start gets the onboarding', async ($, on) => {
  const log = await start($, on, { surface: null })
  expect(log.opened.some(o => o.id === 'mission-status-welcome')).toBe(false)
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  expect(log.opened.some(o => o.id === 'mission-status-welcome')).toBe(true)
  expect(log.themes.length).toBe(1)
})

test('two steps: Welcome with the demo and Next, then Metrics with Back; no step count line', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  expect(await text(ui, /^Welcome$/)).toBe('Welcome')
  expect(await text(ui, new RegExp(`^${WELCOME_LINE.replace(/\./g, '\\.')}$`))).toBe(WELCOME_LINE)
  expect(await svgAlt(ui, /^Stage 1 of 5: Plan$/)).toBeTruthy()
  expect(await text(ui, /^Step \d of \d$/)).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(await text(ui, /^Choices$/)).toBe('Choices')
  expect(await ui.find({ type: 'Button', key: 'next' })).toBeUndefined()
  await ui.press({ key: 'back' })
  expect(await text(ui, /^Welcome$/)).toBe('Welcome')
  await ui.unmount()
})

test('the demo shows the bar, one status line and one helper strip, with no badge row or narration', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  expect(await svgAlt(ui, /^Stage 1 of 5: Plan$/)).toBeTruthy()
  expect(await text(ui, /^Reading the plan$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Helper Scan tests: /)).toBeTruthy()
  expect(await svgAlt(ui, /: in progress$|: not started$/)).toBeUndefined()
  expect(await text(ui, /demo/i)).toBeUndefined()
  await ui.unmount()
})

test('the demo moves with the clock: a 1 s clock starts with the pane and each tick shows a later frame, then it loops', { timeoutMs: 20_000 }, async ($, on) => {
  const clock = { at: Date.now() }
  const log = await start($, on, { clock })
  expect(log.clocks).toContain(1_000)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  expect(await svgAlt(ui, /^Stage 1 of 5: Plan$/)).toBeTruthy()
  clock.at += 4_000
  await ui.redraw()
  expect(await svgAlt(ui, /^Stage 2 of 5: Build$/)).toBeTruthy()
  expect(await text(ui, /^Editing a file$/)).toBeTruthy()
  clock.at += 6_000
  await ui.redraw()
  expect(await svgAlt(ui, /^Stage 4 of 5: Deploy$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Helper Scan tests: done$/)).toBeTruthy()
  clock.at += 4_500
  await ui.redraw()
  expect(await svgAlt(ui, /^All cards are done\.$/)).toBeTruthy()
  clock.at += 1_000
  await ui.redraw()
  expect(await svgAlt(ui, /^Stage 1 of 5: Plan$/)).toBeTruthy()
  await ui.unmount()
})

test('the demo frames: five stages over 15 seconds, then round again', () => {
  expect(DEMO_MS).toBe(15_000)
  expect(demoFrame(0).track.alt).toBe('Stage 1 of 5: Plan')
  expect(demoFrame(4_000).track.alt).toBe('Stage 2 of 5: Build')
  expect(demoFrame(4_000).helper.alt).toBe('Helper Scan tests: running')
  expect(demoFrame(7_000).action).toBe('Running a command')
  expect(demoFrame(10_000).track.alt).toBe('Stage 4 of 5: Deploy')
  expect(demoFrame(14_500).isDone).toBe(true)
  expect(demoFrame(15_000).track.alt).toBe('Stage 1 of 5: Plan')
  expect(demoFrame(4_000).track.source).not.toBe(demoFrame(5_000).track.source)
})

const toMetrics = async ($: any, on: any) => {
  const log = await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  await ui.press({ key: 'next' })
  return { ui, log }
}

test('metrics: one switch, on at first, with the sentence on what is sent and never sent and the field list link', async ($, on) => {
  const { ui } = await toMetrics($, on)
  expect(await svgAlt(ui, /^Share anonymous usage: on$/)).toBeTruthy()
  expect((await ui.find({ type: 'Button', key: 'share' }))?.props?.label).toBe('Share anonymous usage')
  expect(await ui.find({ type: 'Button', key: 'dont-share' })).toBeUndefined()
  expect(await text(ui, /^The pane sends only counts/)).toBe(CONSENT_LINE)
  expect(CONSENT_LINE.split(/[.!?](\s|$)/).filter(s => s.trim() !== '').length).toBe(1)
  expect(CONSENT_LINE).toMatch(/never sends/)
  expect(await ui.find({ type: 'Link' })).toBeTruthy()
  await ui.unmount()
})

test('metrics: showing step 2 writes consent yes and records that the notice was shown', async ($, on) => {
  const log = await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  expect(log.writes.consent).toBeUndefined()
  expect(log.writes.metricsNoticeShown).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(last(log, 'consent')).toBe('yes')
  expect(last(log, 'metricsNoticeShown')).toBe(true)
  await ui.unmount()
})

test('metrics: turning the switch off writes no at once, and on again writes yes', async ($, on) => {
  const { ui, log } = await toMetrics($, on)
  await ui.press({ key: 'share' })
  expect(last(log, 'consent')).toBe('no')
  expect(await svgAlt(ui, /^Share anonymous usage: off$/)).toBeTruthy()
  await ui.press({ key: 'share' })
  expect(last(log, 'consent')).toBe('yes')
  expect(await svgAlt(ui, /^Share anonymous usage: on$/)).toBeTruthy()
  await ui.unmount()
})

test('choices: auto-update is on at first, and the switch turns it off and on again', async ($, on) => {
  const { ui, log } = await toMetrics($, on)
  expect(await svgAlt(ui, /^Update automatically: on$/)).toBeTruthy()
  await ui.press({ key: 'auto' })
  expect(last(log, 'autoUpdate')).toBe(false)
  expect(await svgAlt(ui, /^Update automatically: off$/)).toBeTruthy()
  await ui.press({ key: 'auto' })
  expect(last(log, 'autoUpdate')).toBe(true)
  await ui.unmount()
})

test('metrics: a second visit keeps the person own choice', async ($, on) => {
  const { ui, log } = await toMetrics($, on)
  await ui.press({ key: 'share' })
  await ui.press({ key: 'back' })
  await ui.press({ key: 'next' })
  expect(last(log, 'consent')).toBe('no')
  expect(await svgAlt(ui, /^Share anonymous usage: off$/)).toBeTruthy()
  await ui.unmount()
})

test('metrics: Done ends the onboarding, restores the background and closes the pane', async ($, on) => {
  const { ui, log } = await toMetrics($, on)
  await ui.press({ key: 'done' })
  expect(last(log, 'consent')).toBe('yes')
  expect(last(log, 'onboarded')).toBe(true)
  expect(log.clears).toBe(1)
  expect(log.closed).toContain('mission-status-welcome')
})

test('a theme another mod set after ours is left alone at the end', async ($, on) => {
  const log = await start($, on)
  const other = await $.ui.mount({ ...BACKDROP('some-other-mod', 'lagoon'), surface: 'desktop' } as never)
  await other.unmount()
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'done' })
  expect(last(log, 'onboarded')).toBe(true)
  expect(log.clears).toBe(0)
})

test('the backdrop is a Shader over a finished still Svg, and settles at the Metrics step', async ($, on) => {
  await start($, on)
  const back = await $.ui.mount({ ...BACKDROP('mission-status', 'mission-status-onboarding'), surface: 'desktop' } as never)
  const shader = await back.find({ type: 'Shader' })
  expect(shader?.props?.module).toMatch(/shader\.ts$/)
  expect(shader?.props?.values?.settle).toBe(0)
  expect((await back.find({ type: 'Svg' }))?.props?.source).toBe(STILL_SVG)
  const pane = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  await pane.press({ key: 'next' })
  await back.redraw()
  expect((await back.find({ type: 'Shader' }))?.props?.values?.settle).toBe(0.6)
  await pane.unmount()
  await back.unmount()
})

test('the still Svg is pure vector with no motion: it stands for Reduce Motion and a failed shader', () => {
  expect(STILL_SVG).toMatch(/viewBox="0 0 1600 1000"/)
  expect(STILL_SVG).toMatch(/preserveAspectRatio="xMidYMid slice"/)
  expect(STILL_SVG).toMatch(/#8B7CF6/)
  expect(STILL_SVG).toMatch(/#7462E8/)
  expect(STILL_SVG).not.toMatch(/<image|href|data:|<animate|@keyframes|<style|<!--/)
  expect(STILL_SVG.length).toBeLessThan(131_072)
})

test('/mission-status-welcome shows the onboarding again after it ended', async ($, on) => {
  const log = await start($, on, { onboarded: true })
  const r = await $.command.run({ command: 'mission-status-welcome', args: '' } as never)
  expect((r as { text?: string }).text).toBe('The welcome pane is open.')
  expect(log.opened.some(o => o.id === 'mission-status-welcome')).toBe(true)
  expect(log.themes.length).toBe(1)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  expect(await text(ui, /^Welcome$/)).toBe('Welcome')
  await ui.unmount()
})

// Once for each account: the store keeps a hash of the signed-in account, so another account sees the onboarding.
const asAccount = async ($: any, on: any, email: string, kept: Record<string, unknown>) => {
  const opened: string[] = []
  mock.store(on, kept)
  on('session.identity', () => ({ value: { kind: 'claude.ai', organizationId: 'org-1', email, isVerified: true } }))
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', (_: unknown, e: { id: string }) => (opened.push(e.id), { value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('theme.set', () => ({ value: { isDrawn: true, requestId: 'b' } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  return opened
}

test('onboarding: once for each account, not for each session', async ($, on) => {
  const key = `onboarded:${accountHash('claude.ai|org-1|a@example.com')}`
  const opened = await asAccount($, on, 'a@example.com', { [key]: true })
  expect(opened).not.toContain('mission-status-welcome')
})

test('onboarding: another account on the same machine sees it', async ($, on) => {
  const key = `onboarded:${accountHash('claude.ai|org-1|a@example.com')}`
  const opened = await asAccount($, on, 'b@example.com', { [key]: true })
  expect(opened).toContain('mission-status-welcome')
})
}

// ---- was update.test.ts
{
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

test('a second session start leaves one 6 h check timer, not two', { timeoutMs: 20_000 }, async ($, on) => {
  let ticks = 0
  on('clock.every', { ms: CHECK_EVERY_MS }, (_: unknown, e: unknown, next: any) => {
    ticks += 1
    return next(e)
  })
  const { clock, start } = await setup($, on, { release: 'v1.1.0' })
  await start()
  ticks = 0
  await clock.advance(3 * CHECK_EVERY_MS)
  expect(ticks <= 4).toBe(true)
})
}

// ---- headless session
{
test('a headless session gets no rule, no reminder, no model call and no metrics', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/u' })
  mock.store(on)
  let model = 0
  let fetched = 0
  const stored: Record<string, unknown> = {}
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: (e: unknown) => unknown) => {
    const v = e.value as { shape?: unknown; value?: unknown } | null
    if (e.plugin === 'mission-status') stored[e.key] = v !== null && typeof v === 'object' && 'shape' in v && 'value' in v ? v.value : v
    return next(e)
  })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', () => {
    model++
    return { value: { isAnswered: false, reason: 'aborted' } }
  })
  on('http.fetch', () => {
    fetched++
    return { value: { status: 200, text: '' } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: false })
  expect(stored['headless']).toBe(true)
  const composed = (await $.prompt.compose({} as never)) as { sections: { id: string }[] }
  expect(composed.sections.some(s => s.id === 'mission-status:progress')).toBe(false)
  const contexts: string[] = []
  for (let k = 0; k < 8; k++) {
    const r = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { additionalContext?: string[] }
    contexts.push(...(r.additionalContext ?? []))
    await clock.advance(6_000)
  }
  await $.turn.complete({ text: '' } as never)
  await clock.advance(600_000)
  expect(contexts.some(x => x.includes('Mission status pane'))).toBe(false)
  expect(model).toBe(0)
  expect(fetched).toBe(0)
})
}
