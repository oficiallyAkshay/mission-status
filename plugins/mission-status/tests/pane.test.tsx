import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const start = async ($: any, on: any, agents: unknown[] = [], skipProcess = false) => {
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: agents }))
  on('clock.every', () => ({ value: () => {} }))
  if (!skipProcess) on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)
const text = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

test('build: each card ends with its exit clause, and its figure follows the clause kind', async ($, on) => {
  await start($, on, [{ id: 'a1', description: 'scan tests', status: 'running', taskStatus: 'running', model: 'haiku', startTime: Date.now() }])
  const base = { project: 'Vaani Claude mod', goalLine: 'The pane shows the counts.', stage: 'build', phase: 1 }
  const counts = (n: number) => [
    { phase: 0, label: 'Rounds', when: 'you pick the pane form', text: 'Met' },
    { phase: 1, label: 'Checks passing', when: 'all pane tests pass', n, m: 11 },
    { phase: 2, label: 'Look', when: 'you approve the look', text: 'Waiting' },
    { phase: 3, when: 'the pull request merges' },
    { phase: 4, label: 'Lessons', when: 'the lessons are filed', n: 0 },
  ]
  await send($, { ...base, counts: counts(10) })
  await send($, { ...base, counts: counts(11) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^Project: Vaani Claude mod$/)).toBe('Project: Vaani Claude mod')
  for (const stage of ['Plan', 'Build', 'Test', 'Deploy', 'Learn']) expect(await text(ui, new RegExp(`^${stage}$`))).toBe(stage)
  // exit clauses read as conditions, met ones checked
  expect(await ui.find({ type: 'Svg', alt: /^Done when you pick the pane form\.$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg', alt: /^Done when you approve the look\.$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg', alt: /^Done when the pull request merges\.$/ })).toBeTruthy()
  // cards show a live MM:SS timer, not a count or a status word
  expect(await text(ui, /^00:0\d$/)).toBeTruthy()
  expect(await text(ui, /^Met$/)).toBeUndefined()
  expect(await text(ui, /^11 of 11$/)).toBeUndefined()
  expect(await ui.find({ type: 'Svg', alt: /Helper scan tests: running/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg', alt: /Stage 2 of 5: Build/ })).toBeTruthy()
  await ui.unmount()
})

test('a stage opens to its items; an item that waits is indented, parallel items are counted', async ($, on) => {
  await start($, on)
  await send($, {
    project: 'P',
    stage: 'build',
    phase: 1,
    items: [
      { phase: 1, name: 'draw the ring', status: 'done' },
      { phase: 1, name: 'draw the columns', status: 'now' },
      { phase: 1, name: 'write the tests', status: 'next', after: 'draw the columns' },
      { phase: 1, name: 'expand rows', status: 'now' },
      { phase: 3, name: 'open the pull request', status: 'next' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the current stage opens by itself
  expect(await text(ui, /^Draw the columns$/)).toBe('Draw the columns')
  expect(await ui.find({ type: 'Svg', alt: /^Write the tests waits for Draw the columns\.$/ })).toBeTruthy()
  expect(await text(ui, /^2 items run in parallel\.$/)).toBeTruthy()
  // a later stage stays closed until pressed
  expect(await text(ui, /^Open the pull request$/)).toBeUndefined()
  await ui.press({ key: 'open-3' })
  expect(await text(ui, /^Open the pull request$/)).toBe('Open the pull request')
  await ui.press({ key: 'open-1' })
  expect(await text(ui, /^Draw the columns$/)).toBeUndefined()
  await ui.unmount()
})

test('one stage is in progress at a time, and the current stage shows its time', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [{ phase: 2, name: 'your look review', status: 'now' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg', alt: /^Test: not started$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg', alt: /^Build: in progress$/ })).toBeTruthy()
  expect(await text(ui, /^00:0\d$/)).toBeTruthy()
  await ui.unmount()
})

test('a ticket shows at the top, custom stages replace the preset, the git bar opens', async ($, on) => {
  on('process.run', (_: unknown, e: { argv?: string[] }) => {
    const a = (e as { argv?: string[] }).argv ?? []
    const out = a[1] === 'branch' ? 'feature/x' : a[1] === 'merge-base' ? 'abc' : a[1] === 'rev-list' ? '3' : a[1] === 'diff' ? ' 4 files changed, 120 insertions(+), 30 deletions(-)' : a[0] === 'gh' ? '[]' : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await start($, on, [], true)
  await send($, {
    project: 'P',
    stage: 'build',
    phase: 4,
    phases: ['plan', 'build', 'review', 'deploy', 'monitor', 'iterate'],
    ticket: { ref: 'NIR-1', title: 'Make it general', url: 'https://example.com/NIR-1' },
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Link' }))?.props?.href).toBe('https://example.com/NIR-1')
  expect(await text(ui, /Make it general/)).toBeTruthy()
  expect(await text(ui, /^Monitor$/)).toBe('Monitor')
  expect(await ui.find({ type: 'Svg', alt: /Stage 5 of 6: Monitor/ })).toBeTruthy()
  await ui.unmount()
})

test('cards carry links and items carry a scope note; dependents indent; only running items count as parallel', async ($, on) => {
  await start($, on)
  await send($, {
    project: 'P',
    stage: 'build',
    phase: 1,
    links: [{ phase: 0, label: 'Plan', href: '/tmp/plan.md' }, { item: 'wave 1', label: 'Brief', href: 'https://example.com/b' }],
    items: [
      { phase: 0, name: 'plan', status: 'done' },
      { phase: 1, name: 'wave 1', status: 'now', note: 'schema, metrics, onboarding' },
      { phase: 1, name: 'wave 2', status: 'next', after: 'wave 1' },
      { phase: 1, name: 'split', status: 'done' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-0' })
  expect(await ui.find({ type: 'Link', href: 'file:///tmp/plan.md' })).toBeTruthy()
  expect(await ui.find({ type: 'Link', href: 'https://example.com/b' })).toBeTruthy()
  expect(await text(ui, /^Schema, metrics, onboarding$/)).toBeTruthy()
  expect(await ui.find({ type: 'Svg', alt: /^Wave 2 waits for Wave 1\.$/ })).toBeTruthy()
  expect(await text(ui, /items run in parallel/)).toBeUndefined()
  await ui.unmount()
})

test('stages can run in parallel', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', template: 'product-loop', phase: 1, active: [2] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg', alt: /^Build: in progress$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg', alt: /^Review: in progress$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Svg', alt: /^Deploy: not started$/ })).toBeTruthy()
  await ui.unmount()
})

test('the pane says nothing about the owner and has no age line', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /needs you/i)).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'update' })).toBeTruthy()
  expect(await text(ui, /ago$/)).toBeUndefined()
  await ui.unmount()
})

test('fix: its own stages and the symptom', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'fix', phase: 1, symptom: 'The pane shows no data after a reload.' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg', alt: /Stage 2 of 5: Find cause/ })).toBeTruthy()
  expect(await text(ui, /^The pane shows no data after a reload\.$/)).toBeTruthy()
  await ui.unmount()
})

test('cause: suspected causes with states, the confirmed one named', async ($, on) => {
  await start($, on)
  await send($, {
    project: 'P',
    stage: 'cause',
    phase: 2,
    symptom: 'Time is frozen.',
    hypotheses: [
      { text: 'clock stamp is fixed', state: 'confirmed' },
      { text: 'Timer never fires', state: 'ruled out' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^Ruled out$/)).toBe('Ruled out')
  expect((await ui.find({ type: 'Text', text: /^Clock stamp is fixed$/ }))?.props?.color).toBe('success')
  await ui.unmount()
})

test('done: every stage passed', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'ship', phase: 5 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg', alt: /All stages are done/ })).toBeTruthy()
  await ui.unmount()
})

test('a count with a zero denominator is hidden', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, counts: [{ phase: 1, label: 'Empty', when: 'nothing', n: 0, m: 0 }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^Empty$/)).toBeUndefined()
  await ui.unmount()
})

test('a wait is a full sentence', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'ship', phase: 3, waitingOn: 'The CI gate check' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^Waiting on the CI gate check/)).toBeTruthy()
  await ui.unmount()
})

test('empty: before any update', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^The pane has no progress data yet\.$/)).toBeTruthy()
  await ui.unmount()
})
