import { expect, test } from 'claude-code/testing'
import { CONSENT_LINE, DEMO_MS, DONE_LINE, SESSION_TYPES, STILL_SVG, WELCOME_LINE, demoFrame } from '../hooks/onboarding-art'

const WELCOME = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'mission-status-welcome',
  props: { title: 'Welcome', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const BACKDROP = (plugin: string, scene: string) =>
  ({ plugin: 'mission-status', component: 'Backdrop', requestId: 'backdrop', props: { scene, plugin, glass: false } }) as const

type Log = { opened: { id: string; title?: string }[]; closed: string[]; themes: unknown[]; clears: number; commands: string[]; writes: Record<string, unknown[]> }

// Stands for the engine beneath the plugin, and records what the onboarding asks of it.
const start = async ($: any, on: any, opts: { surface?: string | null; onboarded?: boolean; surfaces?: string[] } = {}) => {
  const log: Log = { opened: [], closed: [], themes: [], clears: 0, commands: [], writes: {} }
  on('tool.register', () => ({ value: {} }))
  on('command.register', (_: unknown, e: { name: string }) => (log.commands.push(e.name), { value: { command: e.name } }))
  on('ui.open', (_: unknown, e: { id: string; title?: string }) => (log.opened.push(e), { value: { isPlaced: true } }))
  on('ui.close', (_: unknown, e: { id: string }) => (log.closed.push(e.id), { value: undefined }))
  on('theme.set', (_: unknown, e: unknown) => (log.themes.push(e), { value: { isDrawn: true, requestId: 'backdrop' } }))
  on('theme.clear', () => (log.clears++, { value: { isDrawn: false, reason: 'cleared' } }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? [] }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('session.attach', (_: unknown, e: { clientId: string }) => ({ clientId: e.clientId }))
  // Each write passes through to the store; the test keeps a copy.
  on('state.set', { plugin: 'mission-status' }, (_: unknown, e: { key: string; value: unknown }, next: any) => {
    ;(log.writes[e.key] ??= []).push(e.value)
    return next(e)
  })
  // An earlier run that finished the onboarding.
  if (opts.onboarded) on('state.get', { plugin: 'mission-status', key: 'onboarded' }, () => ({ value: { value: true, version: 1 } }))
  await $.session.start({ cwd: '/', surface: opts.surface === undefined ? 'desktop' : opts.surface, isInteractive: true })
  return log
}
const last = (log: Log, key: string) => log.writes[key]?.at(-1)
const svgAlt = (ui: any, alt: RegExp) => ui.find({ type: 'Svg', alt } as never)
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

test('Next and Back walk the five steps: Welcome, Demo, Session types, Metrics, Done', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  expect(await text(ui, /^Step 1 of 5$/)).toBeTruthy()
  expect(await text(ui, new RegExp(`^${WELCOME_LINE.replace(/\./g, '\\.')}$`))).toBe(WELCOME_LINE)
  expect(await ui.find({ type: 'Button', key: 'back' })).toBeUndefined()
  await ui.press({ key: 'next' })
  expect(await text(ui, /^Demo$/)).toBe('Demo')
  await ui.press({ key: 'next' })
  expect(await text(ui, /^Session types$/)).toBe('Session types')
  await ui.press({ key: 'back' })
  expect(await text(ui, /^Demo$/)).toBe('Demo')
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect(await text(ui, /^Metrics$/)).toBe('Metrics')
  await ui.unmount()
})

test('the demo draws with the pane own drawings and runs through all stages in 15 seconds', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  await ui.press({ key: 'next' })
  expect(await svgAlt(ui, /^Stage 1 of 5: Plan$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Helper Scan tests: /)).toBeTruthy()
  expect(await svgAlt(ui, /^Tests passing: \d+ of 12$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Plan: in progress$/)).toBeTruthy()
  expect(await text(ui, /^Reading the plan$/)).toBeTruthy()
  await ui.unmount()
  expect(DEMO_MS).toBe(15_000)
  expect(demoFrame(0).track.alt).toBe('Stage 1 of 5: Plan')
  expect(demoFrame(4_000).track.alt).toBe('Stage 2 of 5: Build')
  expect(demoFrame(4_000).helper.alt).toBe('Helper Scan tests: running')
  expect(demoFrame(9_000).tests.n).toBe(12)
  expect(demoFrame(10_000).track.alt).toBe('Stage 4 of 5: Deploy')
  expect(demoFrame(14_500).isDone).toBe(true)
  expect(demoFrame(14_500).track.alt).toBe('All stages are done.')
  // the demo loops: 15 s is the start again
  expect(demoFrame(15_000).track.alt).toBe('Stage 1 of 5: Plan')
  expect(demoFrame(4_000).track.source).toContain('<svg')
})

test('the nine session types show as small labelled tiles', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  await ui.press({ key: 'next' })
  await ui.press({ key: 'next' })
  expect(SESSION_TYPES.length).toBe(9)
  for (const t of SESSION_TYPES) {
    expect(await text(ui, new RegExp(`^${t.name}$`))).toBe(t.name)
    expect(await svgAlt(ui, new RegExp(`^${t.name}: \\d stages$`))).toBeTruthy()
  }
  await ui.unmount()
})

const toMetrics = async ($: any, on: any) => {
  const log = await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  for (let k = 0; k < 3; k++) await ui.press({ key: 'next' })
  return { ui, log }
}

test('metrics: two buttons and one sentence on what is sent and what is never sent; Next waits for a choice', async ($, on) => {
  const { ui, log } = await toMetrics($, on)
  expect((await ui.find({ type: 'Button', key: 'share' }))?.props?.label).toBe('Share anonymous usage')
  expect((await ui.find({ type: 'Button', key: 'dont-share' }))?.props?.label).toBe("Don't share")
  expect(await text(ui, /^The pane sends only counts/)).toBe(CONSENT_LINE)
  expect(CONSENT_LINE.split(/[.!?](\s|$)/).filter(s => s.trim() !== '').length).toBe(1)
  expect(CONSENT_LINE).toMatch(/never sends/)
  expect(await ui.find({ type: 'Button', key: 'next' })).toBeUndefined()
  expect(log.writes.consent).toBeUndefined()
  await ui.unmount()
})

test('metrics: Share anonymous usage writes consent yes and moves to Done', async ($, on) => {
  const { ui, log } = await toMetrics($, on)
  await ui.press({ key: 'share' })
  expect(last(log, 'consent')).toBe('yes')
  expect(await text(ui, /^Done$/)).toBe('Done')
  await ui.unmount()
})

test("metrics: Don't share writes consent no and moves to Done", async ($, on) => {
  const { ui, log } = await toMetrics($, on)
  await ui.press({ key: 'dont-share' })
  expect(last(log, 'consent')).toBe('no')
  expect(await text(ui, /^Done$/)).toBe('Done')
  await ui.unmount()
})

test('Done: Finish marks onboarded, restores the background and closes the pane', async ($, on) => {
  const log = await start($, on)
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  for (let k = 0; k < 3; k++) await ui.press({ key: 'next' })
  await ui.press({ key: 'dont-share' })
  expect(await text(ui, new RegExp(`^${DONE_LINE.replace(/\./g, '\\.')}$`))).toBe(DONE_LINE)
  await ui.press({ key: 'finish' })
  expect(last(log, 'onboarded')).toBe(true)
  expect(log.clears).toBe(1)
  expect(log.closed).toContain('mission-status-welcome')
})

test('a theme another mod set after ours is left alone at the end', async ($, on) => {
  const log = await start($, on)
  const other = await $.ui.mount({ ...BACKDROP('some-other-mod', 'lagoon'), surface: 'desktop' } as never)
  await other.unmount()
  const ui = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  for (let k = 0; k < 3; k++) await ui.press({ key: 'next' })
  await ui.press({ key: 'share' })
  await ui.press({ key: 'finish' })
  expect(last(log, 'onboarded')).toBe(true)
  expect(log.clears).toBe(0)
})

test('the backdrop is a Shader over a finished still Svg, and settles as the steps advance', async ($, on) => {
  await start($, on)
  const back = await $.ui.mount({ ...BACKDROP('mission-status', 'mission-status-onboarding'), surface: 'desktop' } as never)
  const shader = await back.find({ type: 'Shader' })
  expect(shader?.props?.module).toMatch(/shader\.ts$/)
  expect(shader?.props?.values?.settle).toBe(0)
  expect((await back.find({ type: 'Svg' }))?.props?.source).toBe(STILL_SVG)
  const pane = await $.ui.mount({ ...WELCOME, surface: 'desktop' })
  await pane.press({ key: 'next' })
  await pane.press({ key: 'next' })
  await back.redraw()
  expect((await back.find({ type: 'Shader' }))?.props?.values?.settle).toBe(0.5)
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
  expect(await text(ui, /^Step 1 of 5$/)).toBeTruthy()
  await ui.unmount()
})
