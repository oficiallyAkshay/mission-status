import { expect, test } from 'claude-code/testing'

// Find a drawing by its description: the test engine's find does not filter on alt, so filter here.
const svgAlt = async (ui: { findAll: (q: { type: string }) => Promise<{ props?: Record<string, unknown> }[]> }, alt: RegExp | string) =>
  (await ui.findAll({ type: 'Svg' })).find(x => (typeof alt === 'string' ? x.props?.alt === alt : alt.test(String(x.props?.alt ?? '')))) ?? undefined

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
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The agent sends its states inside a turn: a turn runs, so its work in progress runs too.
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)
const text = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text

test('a pane the agent has not filled says it waits for the agent', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))
  await start($, on)
  for (let k = 0; k < 5; k++) await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /Waiting for the agent/)).toBe('Waiting for the agent')
  await ui.unmount()
})

test('build: each card ends with its exit clause, and its figure follows the clause kind', async ($, on) => {
  await start($, on, [{ id: 'a1', description: 'scan tests', status: 'running', taskStatus: 'running', model: 'haiku', startTime: Date.now() }])
  const base = { project: 'Checkout redesign', goalLine: 'The pane shows the counts.', stage: 'build', phase: 1 }
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
  expect(await text(ui, /^Checkout redesign$/)).toBe('Checkout redesign')
  for (const stage of ['Plan', 'Build', 'Test', 'Deploy', 'Learn']) expect(await text(ui, new RegExp(`^${stage}$`))).toBe(stage)
  // exit clauses read as conditions, met ones checked
  // A done stage folds to one line that names its met gate.
  expect(await text(ui, /^✓ you pick the pane form$/)).toBe('✓ you pick the pane form')
  expect(await svgAlt(ui, 'Gate: you approve the look')).toBeTruthy()
  expect(await svgAlt(ui, 'Gate: the pull request merges')).toBeTruthy()
  // cards show a live MM:SS timer, not a count or a status word
  expect(await text(ui, /^\d+s$/)).toBeTruthy()
  expect(await text(ui, /^Met$/)).toBeUndefined()
  expect(await text(ui, /^11 of 11$/)).toBeUndefined()
  expect(await svgAlt(ui, /Helper scan tests: running/)).toBeTruthy()
  expect(await text(ui, /^✓ Plan$/)).toBeTruthy()
  await ui.unmount()
})

test('the stage bar shows every stage at any width, in order, with no window and no buttons to move it', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Repo setup', 'Build', 'Website', 'Review', 'Fix findings', 'Deploy'], phase: 5 })
  for (const bodyColumns of [30, 40, 140]) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'desktop' })
    // Done stages carry a check, the current one its plain name, the stages ahead their names: all seven, every time.
    for (const name of ['✓ Plan', '✓ Repo setup', '✓ Build', '✓ Website', '✓ Review', 'Deploy']) expect(await text(ui, new RegExp(`^${name}$`))).toBeTruthy()
    expect((await ui.findAll({ type: 'Button' })).some(x => x.key === 'bar-left' || x.key === 'bar-right')).toBe(false)
    await ui.unmount()
  }
})

test('a done stage folds to one line; its + opens the full card again', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, counts: [{ phase: 0, when: 'Plan approved', text: 'Met' }], links: [{ phase: 0, label: 'Spec', href: 'https://example.com/s' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^✓ Plan approved$/)).toBe('✓ Plan approved')
  expect(await svgAlt(ui, /Gate( met)?: Plan approved/)).toBeUndefined()
  expect((await ui.findAll({ type: 'Link' })).some(x => x.props?.href === 'https://example.com/s')).toBe(false)
  await ui.press({ key: 'open-0' })
  expect(await svgAlt(ui, /Gate met: Plan approved/)).toBeTruthy()
  expect((await ui.findAll({ type: 'Link' })).some(x => x.props?.href === 'https://example.com/s')).toBe(true)
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
  // an item in progress carries its runtime after its name
  expect(await text(ui, /^Draw the columns$/)).toBeTruthy()
  // The run time sits on the right, in caption size, apart from the name.
  expect(await text(ui, /^(\d+m )?\d+s$/)).toBeTruthy()
  // a wait draws a line in the badge column between the two badges
  expect(await svgAlt(ui, 'Wait line')).toBeTruthy()
  // The spinners show what runs in parallel; no sentence repeats it.
  expect(await text(ui, /items run in parallel/)).toBeUndefined()
  // a later stage stays closed until pressed
  expect(await text(ui, /^Open the pull request$/)).toBeUndefined()
  await ui.press({ key: 'open-3' })
  expect(await text(ui, /^Open the pull request$/)).toBe('Open the pull request')
  await ui.press({ key: 'open-1' })
  expect(await text(ui, /^Draw the columns/)).toBeUndefined()
  await ui.unmount()
})

test('the current stage runs and shows its time; a stage with nothing started is not started; a running item runs its stage', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [{ phase: 1, name: 'your look review', status: 'now' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await svgAlt(ui, /^Test: not started$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Build: in progress$/)).toBeTruthy()
  expect(await text(ui, /^\d+s$/)).toBeTruthy()
  // An item that runs in a later stage makes that stage run too: a running child always has a running parent.
  await send($, { items: [{ phase: 2, name: 'Early test', status: 'now' }] })
  expect(await svgAlt(ui, /^Test: in progress$/)).toBeTruthy()
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
    ticket: { ref: 'ABC-1', title: 'Make it general', url: 'https://example.com/ABC-1' },
  })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 }, surface: 'desktop' })
  expect((await ui.find({ type: 'Link' }))?.props?.href).toBe('https://example.com/ABC-1')
  expect(await text(ui, /Make it general/)).toBeTruthy()
  expect(await text(ui, /^Monitor$/)).toBe('Monitor')
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
      { phase: 0, name: 'write the plan', status: 'done' },
      { phase: 1, name: 'wave 1', status: 'now', note: 'schema, metrics, onboarding' },
      { phase: 1, name: 'wave 2', status: 'next', after: 'wave 1' },
      { phase: 1, name: 'split', status: 'done' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-0' })
  // a local Markdown file is a button that opens the document pane, not a dead file link
  expect((await ui.findAll({ type: 'Link' })).some(x => String(x.props?.href ?? '').startsWith('file:'))).toBe(false)
  expect((await ui.findAll({ type: 'Button' })).some(x => String(x.props?.label ?? '') === '↗ Plan')).toBe(true)
  expect((await ui.findAll({ type: 'Link' })).some(x => x.props?.href === 'https://example.com/b')).toBe(true)
  expect(await text(ui, /^Schema, metrics, onboarding$/)).toBeTruthy()
  expect(await svgAlt(ui, 'Wait line')).toBeTruthy()
  expect(await text(ui, /items run in parallel/)).toBeUndefined()
  await ui.unmount()
})

test('each item in progress shows its runtime', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [{ phase: 1, name: 'a', status: 'now' }, { phase: 1, name: 'b', status: 'next' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^A$/)).toBeTruthy()
  expect(await text(ui, /^\d+s$/)).toBeTruthy()
  await ui.unmount()
})

test('a passed stage with an unfinished item is not done', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [{ phase: 0, name: 'write the brief', status: 'done' }, { phase: 0, name: 'brand', status: 'now' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await svgAlt(ui, /^Plan: in progress$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Plan: done$/)).toBeUndefined()
  await ui.unmount()
})

test('a state the agent left stale shows May be out of date; a fresh one does not', async ($, on) => {
  let stale = true
  on('state.get', (async (_: unknown, e: { plugin: string; key: string }, next: (e: unknown) => unknown) => {
    const got = (await next(e)) as { value?: { value?: { shape?: string; value?: Record<string, unknown> } } } | undefined
    // A shaped value is stored as { shape, value }: set the flag on the summary inside it.
    const inner = got?.value?.value
    if (e.plugin === 'mission-status' && e.key === 'summary' && inner?.value && typeof inner.value === 'object')
      return { ...got, value: { ...got?.value, value: { ...inner, value: { ...inner.value, mayBeOutOfDate: stale } } } }
    return got
  }) as never)
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^May be out of date$/)).toBe('May be out of date')
  await ui.unmount()
  stale = false
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui2, /^May be out of date$/)).toBeUndefined()
  await ui2.unmount()
})

test('in-progress cards open by themselves and completed cards close; a press holds until the state changes', async ($, on) => {
  await start($, on)
  const items = (aDone: boolean) => [
    { id: 'a', phase: 0, name: 'old work', status: aDone ? 'done' : 'now' },
    { id: 'b', phase: 1, name: 'new work', status: 'now' },
  ]
  await send($, { project: 'P', stage: 'build', phase: 1, items: items(true) })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^Old work( |$)/)).toBeUndefined()
  expect(await text(ui, /^New work/)).toBeTruthy()
  await ui.press({ key: 'open-0' })
  // A done item carries the time it was done.
  expect(await text(ui, /^Old work( |$)/)).toBeTruthy()
  await ui.unmount()
  await send($, { project: 'P', stage: 'build', phase: 1, items: items(false) })
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // stage 0 is now in progress again: it opens by the rule
  expect(await text(ui2, /^Old work/)).toBeTruthy()
  await ui2.unmount()
})

test('stages can run in parallel', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', template: 'product-loop', phase: 1, active: [2] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await svgAlt(ui, /^Build: in progress$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Review: in progress$/)).toBeTruthy()
  expect(await svgAlt(ui, /^Deploy: not started$/)).toBeTruthy()
  await ui.unmount()
})

test('the pane says nothing about the owner, and shows no update age', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 0 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /needs you/i)).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).some(x => x.key === 'update')).toBe(false)
  expect(await text(ui, /^Updated /)).toBeUndefined()
  await ui.unmount()
})

test('fix: its own stages and the symptom', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'fix', phase: 1, symptom: 'The pane shows no data after a reload.' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 120 }, surface: 'desktop' })
  expect(await text(ui, /^Find cause$/)).toBeTruthy()
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
  expect(await text(ui, /cards are done/)).toBeUndefined()
  expect(await text(ui, /^✓ /)).toBeTruthy()
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

test('a wait is a quiet subtitle, and keeps an acronym as written', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'ship', phase: 3, waitingOn: 'CI on PR 5' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const line = (await ui.findAll({ type: 'Text' })).find(x => /^Waiting on CI on PR 5/.test(String(x.text ?? '')))
  expect(line).toBeTruthy()
  expect(line?.props?.color).not.toBe('warning')
  await ui.unmount()
})

test('empty: before any update', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^No progress yet\. The agent sends the first state/)).toBeTruthy()
  await ui.unmount()
})

test('runbooks: one runbook is a Runbook tab beside Progress; each step carries its own wait', async ($, on) => {
  await start($, on)
  const runbook = {
    id: 'release',
    title: 'Release',
    href: 'https://example.com/runbook',
    steps: [
      { name: 'Fix the findings', status: 'done' },
      { name: 'Rewrite the history', status: 'now', waitsOn: 'your yes' },
      { name: 'Make the repository public', status: 'next' },
    ],
  }
  expect((await send($, { project: 'P', stage: 'build', phase: 1, runbooks: [runbook] })).deny).toBeUndefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const buttons = await ui.findAll({ type: 'Button' })
  // The open tab is a chip, not a button: Progress is open, so only the other tabs are buttons.
  expect(buttons.some(x => x.key === 'tab-progress')).toBe(false)
  expect(buttons.some(x => x.key === 'tab-release' && x.props?.label === '☰  Runbook')).toBe(true)
  expect(await text(ui, /^P$/)).toBe('P')
  await ui.press({ key: 'tab-release' })
  expect(await text(ui, /^1 of 3 done  ·  1 need you  ·  now: Rewrite the history$/)).toBeTruthy()
  // No separate Needs you card: each wait sits under its own step.
  expect(await text(ui, /^Needs you( |$)/)).toBeUndefined()
  expect(await text(ui, /^2  Rewrite the history$/)).toBe('2  Rewrite the history')
  expect(await text(ui, /^Needs your yes$/)).toBe('Needs your yes')
  expect(await text(ui, /^P$/)).toBeUndefined()
  await ui.press({ key: 'tab-progress' })
  expect(await text(ui, /^P$/)).toBe('P')
  await ui.unmount()
  // A runbook with no steps is refused; remove drops one.
  expect(String((await send($, { runbooks: [{ id: 'x', title: 'X', steps: [] }] })).deny)).toContain('1 to 60 steps')
  expect((await send($, { runbooks: [{ id: 'release', remove: true }] })).deny).toBeUndefined()
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.findAll({ type: 'Button' })).some(x => x.key === 'tab-release')).toBe(false)
  await after.unmount()
})

test('a stage card lists its items in the order the agent sent them, whatever their status', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [
    { phase: 1, name: 'Later', status: 'next' },
    { phase: 1, name: 'Running', status: 'now' },
    { phase: 1, name: 'Finished', status: 'done' },
  ] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const names = (await ui.findAll({ type: 'Text' })).map(x => String(x.text ?? '').split(' ')[0]).filter(t => ['Later', 'Running', 'Finished'].includes(t))
  expect(names).toEqual(['Later', 'Running', 'Finished'])
  await ui.unmount()
})

test('done items show the time they were done, at every level of nesting', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [
    { phase: 1, name: 'Parent', status: 'now' },
    { phase: 1, name: 'Child', status: 'next', parent: 'Parent' },
  ] })
  await send($, { patch: [{ op: 'change', id: 'child', status: 'done' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The parent is in progress, so it opens by itself.
  expect(await text(ui, /^Child$/)).toBeTruthy()
  // The time it was done sits on the right of its row, in caption size.
  expect(await text(ui, /^\d{1,2}:\d{2} (AM|PM)$/)).toBeTruthy()
  await ui.unmount()
})

test('an item whose pull request merged shows done at the merge time, with no agent update', async ($, on) => {
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    // The pull request merges after the agent's last update named the item.
    const out = e.argv[0] === 'gh' && e.argv[1] === 'pr' && e.argv[2] === 'view' ? JSON.stringify({ statusCheckRollup: [], mergedAt: new Date(Date.now() + 1000).toISOString() }) : ''
    return { value: { exitCode: out === '' ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await start($, on, [], true)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [{ phase: 1, name: 'Ship it', status: 'now', pr: 7 }] })
  await new Promise(r => setTimeout(r, 50))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Its only item is done, so the stage is done and folds: open it.
  await ui.press({ key: 'open-1' })
  expect(await svgAlt(ui, /^Ship it: done$/)).toBeTruthy()
  expect(await text(ui, /^Ship it$/)).toBeTruthy()
  expect(await text(ui, /^\d{1,2}:\d{2} (AM|PM)$/)).toBeTruthy()
  await ui.unmount()
})

test('an item the agent names in progress after its pull request merged stays in progress: the work went on', async ($, on) => {
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const out = e.argv[0] === 'gh' && e.argv[1] === 'pr' && e.argv[2] === 'view' ? JSON.stringify({ statusCheckRollup: [], mergedAt: new Date(Date.now() - 60_000).toISOString() }) : ''
    return { value: { exitCode: out === '' ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await start($, on, [], true)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [{ phase: 1, name: 'Ship it', status: 'now', pr: 7 }] })
  await new Promise(r => setTimeout(r, 50))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await svgAlt(ui, /^Ship it: in progress$/)).toBeTruthy()
  await ui.unmount()
})

test('PRs tab: a pull request the session makes is listed with its state, and its card opens to its facts', async ($, on) => {
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const isView = e.argv[0] === 'gh' && e.argv[1] === 'pr' && e.argv[2] === 'view'
    const out = isView ? JSON.stringify({ number: 9, title: 'Add the tab', url: 'https://github.com/acme/app/pull/9', state: 'MERGED', isDraft: false, mergeable: 'UNKNOWN', statusCheckRollup: [], mergedAt: '2026-11-25T02:00:00Z', headRefName: 'tabs' }) : ''
    return { value: { exitCode: out === '' ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'https://github.com/acme/app/pull/9\n' }))
  await start($, on, [], true)
  await send($, { project: 'P', stage: 'build', phase: 1 })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
  await new Promise(r => setTimeout(r, 50))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.findAll({ type: 'Button' })).some(x => x.key === 'tab-prs')).toBe(true)
  await ui.press({ key: 'tab-prs' })
  expect(await text(ui, /^Add the tab$/)).toBe('Add the tab')
  expect(await svgAlt(ui, /^Merged$/)).toBeTruthy()
  await ui.press({ key: 'open-pr-acme/app#9' })
  // An open card shows two tabs, Commits first; no Details tab.
  expect(await text(ui, /^●  Commits \d+$/)).toBeTruthy()
  expect((await ui.findAll({ type: 'Button' })).some(x => String(x.key).endsWith('-b-details'))).toBe(false)
  await ui.unmount()
})

test('an item with a pull request shows its CI time on its own line, after the item time', async ($, on) => {
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const isView = e.argv[0] === 'gh' && e.argv[1] === 'pr' && e.argv[2] === 'view'
    const out = isView ? JSON.stringify({ statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '', startedAt: new Date(Date.now() - 65_000).toISOString(), completedAt: '0001-01-01T00:00:00Z' }], mergedAt: null }) : ''
    return { value: { exitCode: out === '' ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await start($, on, [], true)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [{ phase: 1, name: 'Ship it', status: 'now', pr: 7 }] })
  await new Promise(r => setTimeout(r, 50))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^Ship it$/)).toBeTruthy()
  expect(await text(ui, /^CI 1m 0\ds$/)).toBeTruthy()
  // The item that made the pull request carries its chip: the state icon and the number.
  expect(await svgAlt(ui, /^Pull request 7: /)).toBeTruthy()
  expect(await text(ui, /^#7$/)).toBeTruthy()
  await ui.unmount()
})

test('a Claude artifact chip opens the artifact in the app through the Artifact tool', async ($, on) => {
  const opened: string[] = []
  on('tool.call', { tool: 'Artifact' }, (_: unknown, e: { action?: string; url?: string }) => {
    if (e.action === 'open' && typeof e.url === 'string') opened.push(e.url)
    return { result: 'opened' }
  })
  await start($, on)
  const url = 'https://claude.ai/artifact/XQ8eu3nXjMst5azMTe9Y9Q'
  await send($, { project: 'P', stage: 'build', phase: 1, links: [{ phase: 1, label: 'Review', href: url }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const chip = (await ui.findAll({ type: 'Button' })).find(x => x.props?.label === '↗ Review')
  expect(chip).toBeTruthy()
  await ui.press({ key: String(chip?.key ?? '') })
  expect(opened).toEqual([url])
  await ui.unmount()
})

test('the PRs tab finds every pull request in the transcript, past the 4 MiB read limit', async ($, on) => {
  const lines = (n: number, url: string) => [
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_P${n}","name":"Bash","input":{"command":"gh pr create --fill"}}]}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_P${n}","content":"${url}"}]}}`,
  ]
  const pad = '{"type":"x","pad":"' + 'a'.repeat(1024 * 1024) + '"}'
  let transcript = [...lines(1, 'https://github.com/acme/app/pull/1'), pad, pad, pad, pad, pad, ...lines(2, 'https://github.com/acme/app/pull/2')].join('\n') + '\n'
  // ASCII only, so a byte offset is a character offset.
  const bytes = () => transcript.length
  on('session.info', () => ({ value: { transcriptPath: '/t.jsonl' } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: bytes(), mtimeMs: 0, isLink: false } }))
  on('fs.read', (_: unknown, e: { path: string; offset?: number; length?: number }) => {
    const at = e.offset ?? 0
    return { value: transcript.slice(at, at + (e.length ?? transcript.length)) }
  })
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const ref = e.argv[0] === 'gh' && e.argv[2] === 'view' ? e.argv[3] : null
    const out = ref ? JSON.stringify({ number: Number(ref), title: `PR ${ref}`, url: `https://github.com/acme/app/pull/${ref}`, state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [], mergedAt: null, headRefName: 'b' }) : ''
    return { value: { exitCode: out === '' ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await start($, on, [], true)
  await send($, { project: 'P', stage: 'build', phase: 1 })
  await new Promise(r => setTimeout(r, 100))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-prs' })
  expect(await text(ui, /^PR 1$/)).toBeTruthy()
  expect(await text(ui, /^PR 2$/)).toBeTruthy()
  await ui.unmount()
})

test('a refused Artifact open asks the agent to open the artifact', async ($, on) => {
  const asked: string[] = []
  on('tool.call', { tool: 'Artifact' }, () => ({ deny: 'not for plugins' }))
  on('prompt.submit', (_: unknown, e: { text: string }) => (asked.push(e.text), { text: e.text }))
  await start($, on)
  const url = 'https://claude.ai/artifact/XQ8eu3nXjMst5azMTe9Y9Q'
  await send($, { project: 'P', stage: 'build', phase: 1, links: [{ phase: 1, label: 'Review', href: url }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const chip = (await ui.findAll({ type: 'Button' })).find(x => x.props?.label === '↗ Review')
  await ui.press({ key: String(chip?.key ?? '') })
  expect(asked.some(t => t.includes(url))).toBe(true)
  await ui.unmount()
})

test('PRs tab: a pull request whose checks run shows CI with its time so far on its row', async ($, on) => {
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const isView = e.argv[0] === 'gh' && e.argv[1] === 'pr' && e.argv[2] === 'view'
    const out = isView ? JSON.stringify({ number: 9, title: 'Add the tab', url: 'https://github.com/acme/app/pull/9', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '', startedAt: new Date(Date.now() - 125_000).toISOString(), completedAt: '0001-01-01T00:00:00Z' }], mergedAt: null, headRefName: 'tabs' }) : ''
    return { value: { exitCode: out === '' ? 1 : 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'https://github.com/acme/app/pull/9\n' }))
  await start($, on, [], true)
  await send($, { project: 'P', stage: 'build', phase: 1 })
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
  await new Promise(r => setTimeout(r, 50))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-prs' })
  expect(await text(ui, /^CI 2m 0\ds$/)).toBeTruthy()
  await ui.unmount()
})

test('running helpers show under the item in progress, as its children', async ($, on) => {
  await start($, on, [{ id: 'h1', description: 'reader taste', status: 'running', taskStatus: 'running', model: 'haiku', startTime: Date.now() }])
  await send($, { project: 'P', phases: ['Plan', 'Close out'], phase: 1, items: [{ phase: 1, name: 'Deep review', status: 'now' }, { phase: 1, name: 'Merge wait', status: 'next' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const order = (await ui.findAll({ type: 'Svg' })).map(x => String((x as any).props?.alt ?? '')).filter(a => /^(Deep review|Merge wait): |^Helper /.test(a))
  expect(order).toEqual(['Deep review: in progress', 'Helper reader taste: running', 'Merge wait: not started'])
  await ui.unmount()
})

test('badges and trunk lines draw at a fixed 16 px width, so a column never stretches them', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [{ phase: 1, name: 'One', status: 'done' }, { phase: 1, name: 'Two', status: 'now' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const badges = (await ui.findAll({ type: 'Svg' })).filter(x => /^(One|Two): /.test(String((x as any).props?.alt ?? '')))
  expect(badges.length).toBe(2)
  for (const b of badges) expect((b as any).props?.width).toBe(16)
  await ui.unmount()
})

test('only an item in progress marks its running sub-phase bold; a done item shows every sub-phase faint', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1, items: [
    { phase: 1, name: 'Review', status: 'done', steps: ['Read', 'Note'], step: 0 },
    { phase: 1, name: 'Polish', status: 'now', steps: ['Draft', 'Edit'], step: 1 },
  ] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const bold = (await ui.findAll({ type: 'Text' })).filter((x: any) => x.props?.weight === 'bold').map((x: any) => x.text)
  expect(bold).toContain('Edit')
  expect(bold).not.toContain('Read')
  await ui.unmount()
})

test('a running spinner keeps one drawing and one key through sibling adds, removes, reorders and other changes', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build'], phase: 1, items: [{ id: 'run', phase: 1, name: 'Run', status: 'now' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const seen = async () => {
    const x = await svgAlt(ui, /^Run: in progress$/)
    return `${String(x?.key)}|${String(x?.props?.source)}`
  }
  const first = await seen()
  expect(first.includes('<animateTransform')).toBe(true)
  const states = [
    [{ id: 'a', phase: 1, name: 'Before', status: 'done' }, { id: 'run', phase: 1, name: 'Run', status: 'now' }],
    [{ id: 'run', phase: 1, name: 'Run', status: 'now' }, { id: 'b', phase: 1, name: 'After', status: 'next' }, { id: 'c', phase: 1, name: 'Later', status: 'next' }],
    [{ id: 'c', phase: 1, name: 'Later', status: 'done' }, { id: 'run', phase: 1, name: 'Run', status: 'now' }],
    [{ id: 'run', phase: 1, name: 'Run', status: 'now', note: 'A note' }],
  ]
  for (const items of states) {
    await send($, { items })
    expect(await seen()).toBe(first)
  }
  await ui.unmount()
})

test('the header says Live while a turn runs, and after it ends the age of the newest event, not of the agent\'s last write', async ($, on) => {
  await start($, on)
  await send($, { project: 'P', stage: 'build', phase: 1 })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /^Live$/)).toBe('Live')
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 'turn-1' } as never)
  expect(await text(ui, /^Live$/)).toBeUndefined()
  expect(await text(ui, /^\d+s ago$/)).toBeTruthy()
  await ui.unmount()
})
