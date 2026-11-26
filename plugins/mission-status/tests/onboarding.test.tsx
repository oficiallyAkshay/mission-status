import { expect, mock, test } from 'claude-code/testing'
import { accountHash } from '../hooks/onboarding'
import { CONSENT_LINE, DEMO_MS, STILL_SVG, WELCOME_LINE, demoFrame } from '../hooks/onboarding-art'

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
