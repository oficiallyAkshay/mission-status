import { expect, test } from 'claude-code/testing'
import { normalize } from '../hooks/model'
import { stepPulseSvg } from '../hooks/bars'

// Sub-steps: stepsParallel, and a sub-step sent as { name, steps } promoted to its own nested item.

const start = async ($: any, on: any) => {
  watch(on)
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)
// The plugin's state as the engine stores it, read the way every reader reads it: through normalize.
let stored: Record<string, any> = {}
const watch = (on: any) => {
  stored = {}
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: any) => {
    const v = e.value as any
    if (e.plugin === 'mission-status') stored[e.key] = v !== null && typeof v === 'object' && 'shape' in v && 'value' in v ? v.value : v
    return next(e)
  })
}
const items = (): any[] => normalize(stored.summary)?.items ?? []
const byId = (id: string) => items().find(x => x.id === id)
const BASE = { project: 'P', phases: ['Build', 'Close out'], phase: 1 }

const REVIEW = { id: 'review', phase: 1, name: 'Review', status: 'now', steps: ['Read', { name: 'Lenses', steps: ['Bugs', 'Speed'] }, 'Curate', 'File'], step: 2 }

test('stepsParallel survives a write and a patch', async ($, on) => {
  await start($, on)
  expect((await send($, { ...BASE, items: [{ id: 'fan', phase: 1, name: 'Fan out', status: 'now', steps: ['A', 'B'], stepsParallel: true }] })).deny).toBeUndefined()
  expect(byId('fan').stepsParallel).toBe(true)
  expect((await send($, { patch: [{ op: 'change', id: 'fan', step: 1 }] })).deny).toBeUndefined()
  expect(byId('fan').stepsParallel).toBe(true)
  expect((await send($, { patch: [{ op: 'change', id: 'fan', stepsParallel: false }] })).deny).toBeUndefined()
  expect(byId('fan').stepsParallel).toBeUndefined()
  expect((await send($, { patch: [{ op: 'add', id: 'two', phase: 1, name: 'Two', status: 'now', steps: ['X', 'Y'], stepsParallel: true }] })).deny).toBeUndefined()
  expect(byId('two').stepsParallel).toBe(true)
  expect(String((await send($, { patch: [{ op: 'change', id: 'two', stepsParallel: 'yes' }] })).deny)).toContain('stepsParallel')
})

test('promotion: a { name, steps } sub-step becomes a child item, leaves the steps line, and step still names the same sub-step', async ($, on) => {
  await start($, on)
  expect((await send($, { ...BASE, items: [REVIEW] })).deny).toBeUndefined()
  const parent = byId('review')
  expect(parent.steps).toEqual(['Read', 'Curate', 'File'])
  expect(parent.step).toBe(1)
  expect(parent.steps[parent.step]).toBe('Curate')
  const child = byId('review-lenses')
  expect(child).toMatchObject({ name: 'Lenses', parent: 'review', phase: 1, status: 'done', promoted: true, steps: ['Bugs', 'Speed'] })
  expect(items().map(x => x.id)).toEqual(['review', 'review-lenses'])
})

test('promotion: status as sent wins; else at step it is now and step goes null; parallel and now makes every one now', async ($, on) => {
  await start($, on)
  await send($, { ...BASE, items: [{ ...REVIEW, step: 1 }] })
  expect(byId('review').step).toBeNull()
  expect(byId('review-lenses').status).toBe('now')
  await send($, { ...BASE, items: [{ ...REVIEW, step: 0 }] })
  expect(byId('review-lenses').status).toBe('next')
  await send($, { ...BASE, items: [{ ...REVIEW, step: 0, steps: ['Read', { name: 'Lenses', steps: ['Bugs'], status: 'failed', note: 'Two lenses' }] }] })
  expect(byId('review-lenses')).toMatchObject({ status: 'failed', note: 'Two lenses' })
  await send($, { ...BASE, items: [{ id: 'fan', phase: 1, name: 'Fan out', status: 'now', stepsParallel: true, steps: [{ name: 'Web', steps: ['Search'] }, { name: 'Code', steps: ['Read', { name: 'Deep', steps: ['Trace'] }] }] }] })
  expect(['fan-web', 'fan-code'].map(id => byId(id).status)).toEqual(['now', 'now'])
  // Its own sub-steps follow the same rule, one level down.
  expect(byId('fan-code').steps).toEqual(['Read'])
  expect(byId('fan-code-deep')).toMatchObject({ parent: 'fan-code', phase: 1, promoted: true, steps: ['Trace'] })
})

test('a repeated write makes no duplicate; a patch keeps the child; dropping the entry drops the child', async ($, on) => {
  await start($, on)
  await send($, { ...BASE, items: [REVIEW] })
  await send($, { ...BASE, items: [REVIEW] })
  expect(items().filter(x => x.id === 'review-lenses')).toHaveLength(1)
  // A patch of step alone counts places in the list as sent: 3 is File.
  expect((await send($, { patch: [{ op: 'change', id: 'review', step: 3 }] })).deny).toBeUndefined()
  expect(items().filter(x => x.id === 'review-lenses')).toHaveLength(1)
  expect(byId('review').steps[byId('review').step]).toBe('File')
  expect(normalize(normalize(stored.summary))?.items.map(x => x.id)).toEqual(['review', 'review-lenses'])
  // A patch that sends the steps without the entry drops the promoted child.
  expect((await send($, { patch: [{ op: 'change', id: 'review', steps: ['Read', 'Curate'] }] })).deny).toBeUndefined()
  expect(byId('review-lenses')).toBeUndefined()
  // A full write without it does the same; an item the agent sent itself stays.
  await send($, { ...BASE, items: [REVIEW] })
  expect(byId('review-lenses')).toBeDefined()
  await send($, { ...BASE, items: [{ ...REVIEW, steps: ['Read'] }, { id: 'mine', phase: 1, name: 'Mine', status: 'next' }] })
  expect(items().map(x => x.id)).toEqual(['review', 'mine'])
})

test('a plain string entry, and an object with no steps, stay on the line as names', async ($, on) => {
  await start($, on)
  await send($, { ...BASE, items: [{ id: 'plain', phase: 1, name: 'Plain', status: 'now', steps: ['One', { name: 'two' }, 'Three'], step: 2 }] })
  expect(byId('plain')).toMatchObject({ steps: ['One', 'Two', 'Three'], step: 2 })
  expect(byId('plain').stepsSent).toBeUndefined()
  expect(items()).toHaveLength(1)
})

test('stepPulseSvg animates only while running, and its begin offset grows with k', () => {
  const still = stepPulseSvg('Bugs', 2, false)
  expect(still).not.toContain('<animate')
  expect(still).toContain('>Bugs<')
  expect(still).toContain('height="16"')
  expect(still).toContain('rgba(128,128,128,.75)')
  expect(still).toContain('prefers-color-scheme:light')
  const begins = [0, 1, 2].map(k => Number(/begin="([\d.]+)s"/.exec(stepPulseSvg('Bugs', k, true))?.[1]))
  expect(begins).toEqual([0, 0.25, 0.5])
  expect(stepPulseSvg('Bugs', 1, true)).toContain('values="1;.35;1" dur="1.6s"')
  expect(stepPulseSvg('A & B', 0, true)).toContain('A &amp; B')
})

test('pane: parallel sub-sub-steps each pulse while their sub-step runs, offset from each other; in-order ones stay one line', async ($, on) => {
  await start($, on)
  await send($, { ...BASE, items: [
    { id: 'lenses', phase: 1, name: 'Lenses', status: 'now', steps: ['Bugs', 'Speed', 'Docs'], stepsParallel: true },
    { id: 'file', phase: 1, name: 'File', status: 'next', steps: ['Draft', 'Send'], step: 0 },
  ] })
  const ui = await $.ui.mount({ plugin: 'mission-status', component: 'Pane', requestId: 'progress', surface: 'desktop', props: { title: 'P', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as never)
  const svgs = (await ui.findAll({ type: 'Svg' })) as any[]
  const pulses = ['Bugs', 'Speed', 'Docs'].map(n => svgs.find(x => x.props?.alt === n))
  expect(pulses.every(x => /<animate /.test(String(x?.props?.source)))).toBe(true)
  const begins = pulses.map(x => Number(/begin="([\d.]+)s"/.exec(String(x?.props?.source))?.[1]))
  expect(begins[0]! < begins[1]! && begins[1]! < begins[2]!).toBe(true)
  // In-order sub-sub-steps draw as the dot-separated caption line, not as pulses.
  expect(svgs.some(x => x.props?.alt === 'Draft')).toBe(false)
  expect((await ui.find({ type: 'Text', text: /Draft · Send/ })) !== undefined).toBe(true)
  await ui.unmount()
})
