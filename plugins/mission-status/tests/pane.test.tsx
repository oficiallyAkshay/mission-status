import { expect, mock, test } from 'claude-code/testing'
import { badgeSvg, exitSvg, LIGHT, needsBadgeSvg, pulseWidth, stepPulseSvg, stripSvg, textWidth, trackSvg, waitsLineSvg } from '../hooks/bars'
import { brokenRules, derive, type Facts, mergeItems, NO_FACTS } from '../hooks/machine'
import { age, applyPlan, cap, normalize } from '../hooks/model'
import { prRecordOf } from '../hooks/readers'
import { agoOf, timeOfDay } from '../hooks/view'
import { type Item, type Summary } from '../types'

// Each block below was one test file. The blocks keep their own helpers and state; one file runs in one child.

// ---- was pane.test.tsx
{
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
  on('session.surfaces', () => ({ value: ['desktop'] }))
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
  expect((await ui.find({ type: 'Text', text: /^Clock stamp is fixed$/ }))?.props?.color).toBeUndefined()
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
    // The begin time follows the wall clock, so it is left out: the drawing and its key must not change.
    return `${String(x?.key)}|${String(x?.props?.source).replace(/begin="[^"]*"/, '')}`
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

test('no surface attached: the pane never asks to open, so the app prints no "no surface" line', async ($, on) => {
  const asked: string[] = []
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', (_: unknown, e: { id: string }) => (asked.push(e.id), { value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: [] }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  // The 5th tool call would open the pane by itself; the agent's first update would too.
  for (let k = 0; k < 6; k++) await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await send($, { project: 'P', phases: ['Plan', 'Build'], phase: 0 })
  const out = (await $.command.run({ command: 'mission-status', args: '' } as never)) as { text?: string }
  expect(asked).toEqual([])
  expect(out?.text ?? '').toMatch(/no app window is attached/)
})
}

// ---- was layout.test.tsx
{
// The layout contract of the pane's building blocks (hooks/blocks.tsx): every row has the same badge and control
// columns, every time sits in a row's meta column, and every time ends on one right edge, whatever region holds it.

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const start = async ($: any, on: any) => {
  const clock = mock.clock(on, { now: Date.now() })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  return clock
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)

type Node = { type: string; key?: string; props: Record<string, any>; children: unknown[] }
const asNode = (x: unknown): Node | null => {
  if (x === null || typeof x !== 'object' || typeof (x as any).type !== 'string') return null
  const props = ((x as any).props ?? {}) as Record<string, any>
  const raw = (x as any).children ?? props.children ?? []
  const children = (Array.isArray(raw) ? raw : [raw]).flat(Infinity)
  return { type: (x as any).type, key: props.key ?? (x as any).key, props, children }
}
// Each drawn element becomes one Node, made once, so a parent's children are the same objects a path holds.
const made = new WeakMap<object, Node>()
const nodeOf = (x: unknown): Node | null => {
  if (x === null || typeof x !== 'object') return null
  const hit = made.get(x)
  if (hit !== undefined) return hit
  const n = asNode(x)
  if (n !== null) made.set(x, n)
  return n
}
const kidsOf = (n: Node) => n.children.map(nodeOf).filter((x): x is Node => x !== null)
const textOf = (n: Node): string => n.children.map(c => (typeof c === 'string' ? c : nodeOf(c) ? textOf(nodeOf(c) as Node) : '')).join('')
// Every element with the path from the root to it.
const walk = (n: Node, path: Node[] = [], out: { node: Node; path: Node[] }[] = []) => {
  out.push({ node: n, path: [...path, n] })
  for (const k of kidsOf(n)) walk(k, [...path, n], out)
  return out
}
const cells = (v: unknown) => (typeof v === 'number' ? v : v === undefined ? 0 : 1)
// How far an element's right edge sits from the pane's right edge, in cells: the borders and right padding of every
// box around it, and in each row the fixed widths and gaps of the columns after it. NaN when that cannot be known:
// a column after it with no fixed width, or a row that does not push it to the right.
const rightInset = (path: Node[]): number => {
  let sum = 0
  for (let i = path.length - 2; i >= 0; i--) {
    const box = path[i] as Node
    const child = path[i + 1] as Node
    const p = box.props
    // The desktop draws a border as a hairline inside the box's edge, so only padding moves a row in.
    sum += cells(p.paddingRight ?? p.paddingX ?? p.padding)
    // In a column, a child reaches the right edge only when it stretches: its width is 100%, or the column says so.
    if (p.flexDirection !== 'row' && child.type === 'Box' && child.props.width !== '100%' && p.alignItems !== 'stretch') return NaN
    if (p.flexDirection === 'row') {
      const kids = kidsOf(box)
      const at = kids.indexOf(child)
      const later = kids.slice(at + 1)
      const pushed = p.justifyContent === 'flex-end' || p.justifyContent === 'space-between' || kids.slice(0, at + 1).some(k => (k.props.flexGrow ?? 0) > 0)
      if (!pushed && later.length > 0) return NaN
      if (!pushed && later.length === 0 && at > 0 && !kids.slice(0, at).some(k => (k.props.flexGrow ?? 0) > 0)) return NaN
      for (const k of later) {
        if (typeof k.props.width !== 'number') return NaN
        sum += k.props.width + cells(p.columnGap ?? p.gap)
      }
    }
  }
  return sum
}
const TIME = /^(CI (failed |passed )?)?(\d+:\d{2} [AP]M|(\d+h )?(\d+m )?\d+[sm])$/

test('layout: every row has one badge and one control width, and every time sits in the meta column on one right edge', async ($, on) => {
  const clock = await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build', 'Test'], phase: 0, items: [{ id: 'p1', phase: 0, name: 'Read the code', status: 'now' }] })
  await clock.advance(65_000)
  await send($, { phase: 1, patch: [{ op: 'change', id: 'p1', status: 'done' }] })
  await send($, { patch: [
    { op: 'add', id: 'a', phase: 1, name: 'Write the blocks', status: 'done' },
    { op: 'add', id: 'b', phase: 1, name: 'Rebuild the view from the blocks', status: 'now', note: 'every region' },
    { op: 'add', id: 'c', phase: 1, name: 'Stage cards', status: 'now', parent: 'b' },
  ] })
  await clock.advance(12_000)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = walk(nodeOf(await ui.drawn()) as Node)

  // Every time on the pane sits in a meta column and ends on one right edge.
  const times = all.filter(x => x.node.type === 'Text' && TIME.test(textOf(x.node).trim()))
  expect(times.length >= 3).toBe(true)
  const insets = times.map(x => rightInset(x.path))
  expect(insets.every(v => Number.isFinite(v))).toBe(true)
  expect(new Set(insets).size).toBe(1)
  for (const x of times) expect(x.path.some(n => String(n.key ?? '').startsWith('col:meta:'))).toBe(true)

  // Every row: badge, title, meta, control, with one badge width and one control width on the whole pane.
  const rows = all.filter(x => x.node.type === 'Box' && String(x.node.key ?? '').startsWith('row:')).map(x => x.node)
  expect(rows.length >= 5).toBe(true)
  const col = (row: Node, name: string) => walk(row).find(x => x.node.key === `col:${name}:${String(row.key).slice(4)}`)?.node
  for (const r of rows) for (const name of ['badge', 'title', 'meta', 'ctl']) expect(col(r, name) !== undefined).toBe(true)
  expect(new Set(rows.map(r => col(r, 'badge')?.props.width)).size).toBe(1)
  expect(new Set(rows.map(r => col(r, 'ctl')?.props.width)).size).toBe(1)
  await ui.unmount()
})
}

// ---- was substeps.test.tsx
{
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

test('stepPulseSvg shimmers left to right only while running, and its begin offset grows with k', () => {
  const still = stepPulseSvg('Bugs', 2, false)
  expect(still).not.toContain('<animate')
  expect(still).toContain('>Bugs<')
  expect(still).toContain('height="16"')
  expect(still).toContain('rgba(128,128,128,.75)')
  expect(still).toContain('prefers-color-scheme:light')
  // At wall-clock time 0, each later name stands a quarter second behind the one before it in the 1.6 s sweep.
  const begins = [0, 1, 2].map(k => Number(/begin="(-?[\d.]+)s"/.exec(stepPulseSvg('Bugs', k, true, 0))?.[1]))
  expect(begins).toEqual([-0, -1.35, -1.1])
  expect(stepPulseSvg('Bugs', 1, true)).toContain('attributeName="gradientTransform" type="translate"')
  expect(stepPulseSvg('Bugs', 1, true)).toContain('dur="1.6s"')
  // Each name is sized to its letters: wide enough for "Gamma", with no wide gap after "Beta".
  expect(pulseWidth('Gamma')).toBeGreaterThan(textWidth('Gamma', 12) + 2)
  expect(pulseWidth('Beta')).toBeLessThan(textWidth('Beta', 12) + 6)
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
  expect(pulses.every(x => /<animateTransform /.test(String(x?.props?.source)))).toBe(true)
  // Each later name stands a quarter second behind the one before it in the 1.6 s pulse.
  const begins = pulses.map(x => Number(/begin="(-?[\d.]+)s"/.exec(String(x?.props?.source))?.[1]))
  const gap = (a: number, b: number) => Math.round((((b - a) % 1.6) + 1.6) % 1.6 * 1000) / 1000
  expect([gap(begins[0]!, begins[1]!), gap(begins[1]!, begins[2]!)]).toEqual([0.25, 0.25])
  // In-order sub-sub-steps draw as the dot-separated caption line, not as pulses.
  expect(svgs.some(x => x.props?.alt === 'Draft')).toBe(false)
  expect((await ui.find({ type: 'Text', text: /Draft · Send/ })) !== undefined).toBe(true)
  await ui.unmount()
})
}

// ---- was needs.test.tsx
{
// The "needs" item status: an item the agent leaves waiting on the person (an approval, a sign-off, an answer).

let registered = ''
let stored: Record<string, any> = {}
const start = async ($: any, on: any) => {
  registered = ''
  stored = {}
  on('tool.register', (_: unknown, e: unknown) => {
    registered += JSON.stringify(e)
    return { value: {} }
  })
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: any) => {
    // A shaped value is stored as { shape, value }.
    const v = e.value as any
    if (e.plugin === 'mission-status') stored[e.key] = v !== null && typeof v === 'object' && 'shape' in v && 'value' in v ? v.value : v
    return next(e)
  })
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: 'ok' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)
const BASE = { project: 'P', stage: 'build', phase: 1 }

const mk = (id: string, status: string, phase = 1, parent: string | null = null) => ({ id, phase, name: id, status, parent, after: null, when: null, since: null, touchedAt: 0 }) as Item
const summaryOf = (items: Item[], phase = 1) =>
  ({ project: 'P', ticket: null, links: [], goalLine: null, stage: 'build', phases: ['Plan', 'Build', 'Test'], phase, symptom: null, hypotheses: [], waitingOn: null, waitingSince: 0, counts: [], items, active: [], template: null, starts: [], ends: [], change: null, at: 0 }) as unknown as NonNullable<Summary>
const LIVE: Facts = { ...NO_FACTS, turnOpen: true }
const run = (items: Item[], facts: Facts = LIVE, phase = 1) => {
  const s = summaryOf(items, phase)
  const merged = mergeItems(s, [], facts)
  const d = derive(s, merged, facts)
  expect(brokenRules(s, merged, facts, d)).toEqual([])
  return { d, merged }
}

test('the tool schema offers needs for items and patches, says what it means, and the tool keeps it through a send and a patch', async ($, on) => {
  await start($, on)
  expect(registered).toMatch(/"needs"/)
  expect(registered).toMatch(/needs = the item waits on the person \(an approval, a sign-off, an answer\)/)
  const r = await send($, { ...BASE, items: [{ id: 'sign', phase: 1, name: 'Sign-off', status: 'needs' }, { id: 'code', phase: 1, name: 'Code', status: 'now' }] })
  expect(r.deny).toBeUndefined()
  expect(stored.summary.items.map((x: Item) => x.status)).toEqual(['needs', 'now'])
  const p = await send($, { patch: [{ op: 'change', id: 'code', status: 'needs' }, { op: 'change', id: 'sign', status: 'done' }] })
  expect(p.deny).toBeUndefined()
  expect(stored.summary.items.map((x: Item) => x.status)).toEqual(['done', 'needs'])
  const bad = await send($, { ...BASE, items: [{ phase: 1, name: 'Bad', status: 'sleeping' }] })
  expect(bad.deny).toMatch(/status must be one of done, now, next, failed, needs/)
})

test('an item that needs the person is needs, and so is its stage while nothing else runs; it never runs, even in a live turn', () => {
  const { d, merged } = run([mk('approve', 'needs'), mk('draft', 'done')])
  expect(d.item(merged[0] as Item)).toBe('needs')
  expect(d.stage(1)).toBe('needs')
  // In a stage already passed, too.
  const later = run([mk('approve', 'needs')], LIVE, 2)
  expect(later.d.stage(1)).toBe('needs')
  // Holding the running helpers does not make it run either.
  const hosted = run([mk('approve', 'needs')], { ...LIVE, helpersRunning: true, hostKey: 'item-1-approve' })
  expect(hosted.d.item(hosted.merged[0] as Item)).toBe('needs')
})

test('a done mark and a failed item still win over needs on the item; on the stage, needs comes first', () => {
  const failed = run([mk('approve', 'needs'), mk('build', 'failed')])
  expect(failed.d.item(failed.merged[0] as Item)).toBe('needs')
  expect(failed.d.item(failed.merged[1] as Item)).toBe('failed')
  // The stage rule: an item that needs the person outranks a failed one, so the wait on the person is seen first.
  expect(failed.d.stage(1)).toBe('needs')
  const marked = summaryOf([mk('approve', 'needs')])
  const facts: Facts = { ...LIVE, marks: { approve: { status: 'done', at: 5 } } }
  const merged = mergeItems(marked, [], facts)
  expect(derive(marked, merged, facts).item(merged[0] as Item)).toBe('done')
})

test('a running sibling makes the stage running', () => {
  // Parallel: work after an item that waits on the person runs only when the agent says it may run beside it.
  const { d, merged } = run([mk('approve', 'needs'), { ...mk('code', 'now'), parallel: true } as Item])
  expect(d.item(merged[0] as Item)).toBe('needs')
  expect(d.item(merged[1] as Item)).toBe('running')
  expect(d.stage(1)).toBe('running')
})

test('allDone is false while an item needs the person', () => {
  const items = [mk('plan', 'done', 0), mk('approve', 'needs', 1), mk('ship', 'done', 2)]
  expect(run(items, NO_FACTS, 3).d.allDone).toBe(false)
  expect(run(items.map(x => ({ ...x, status: 'done' }) as Item), NO_FACTS, 3).d.allDone).toBe(true)
})

test('needsBadgeSvg draws an amber ring with a light-theme override', () => {
  const svg = needsBadgeSvg()
  expect(svg).toMatch(/^<svg [^>]*width="16" height="16"/)
  expect(svg).toMatch(/<circle/)
  expect(svg).toMatch(/#E5A23D/)
  expect(svg).toMatch(/@media \(prefers-color-scheme:light\)\{[^}]*#A8650A/)
  expect(needsBadgeSvg(20)).toMatch(/width="20" height="20"/)
})
}

// ---- was theme.test.ts
{
// WCAG relative luminance and contrast ratio of two six-digit hex colours.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}
// The light pages the drawings sit on: white and the app's light page.
const PAGES = ['#FFFFFF', LIGHT.page]

const drawings: [string, string][] = [
  ['stage bar', trackSvg({ total: 5, done: 2, current: 'Test', isDone: false, names: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'] })],
  ['stage bar, all done', trackSvg({ total: 3, done: 3, current: null, isDone: true, names: ['Plan', 'Build', 'Test'] })],
  ['helper strip', stripSvg({ title: 'Scan tests', detail: 'haiku', state: 'running', time: '2 min' })],
  ['badge ahead', badgeSvg('next', 0)],
  ['badge current', badgeSvg('now', 0)],
  ['wait line', waitsLineSvg()],
  ['exit clause', exitSvg('all tests pass', false)],
]

test('light theme: every drawing with text or thin lines has a light rule', () => {
  for (const [name, svg] of drawings) expect(`${name}: ${svg.includes('@media (prefers-color-scheme:light)')}`).toBe(`${name}: true`)
})

test('light theme: light text colours reach 4.5:1 and line colours 3:1 on a light page', () => {
  for (const page of PAGES) {
    for (const ink of [LIGHT.accent, LIGHT.green, LIGHT.amber, LIGHT.grey, LIGHT.ink]) expect(contrast(ink, page)).toBeGreaterThanOrEqual(4.5)
  }
})

test('light theme: the dark look keeps its colours', () => {
  const track = trackSvg({ total: 5, done: 2, current: 'Test', isDone: false, names: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'] })
  expect(track).toContain('.np{fill:#fff;fill-opacity:.78}.nf{fill:#A8A69E;fill-opacity:.85}.dv{fill:#fff;fill-opacity:.12}')
  expect(track).toContain('fill="#7462E8"')
  const exit = exitSvg('all tests pass', true)
  expect(exit).toContain('fill:#1F1E1D;stroke:#8B8A85;stroke-opacity:.7}.el{stroke:#8B8A85;stroke-opacity:.6}')
  expect(badgeSvg('now', 0)).toContain('stroke="#8B7CF6"')
  expect(badgeSvg('next', 0)).toContain('.bn{stroke:#A8A69E;stroke-opacity:.55}')
  expect(waitsLineSvg()).toContain('.wa{stroke:#8B8A85}')
})

test('a spinner starts at the wall clock\'s place in its turn, so a rebuilt drawing picks up where it was', () => {
  expect(badgeSvg('now', 1_700_000_000_250, 16)).toContain('begin="-0.250s"')
  expect(stripSvg({ title: 'Scan', detail: null, state: 'running', now: 12_600 })).toContain('begin="-0.600s"')
  expect(pulseWidth('Gamma')).toBeGreaterThan(textWidth('Gamma', 12) + 2)
  expect(stripSvg({ title: 'Scan', detail: null, state: 'running', time: '1 min' })).toBe(stripSvg({ title: 'Scan', detail: null, state: 'running', time: '1 min' }))
})
}

// ---- was age.test.ts
{
test('ages read as plain words', () => {
  expect(age(0, 30_000)).toBe('now')
  expect(age(0, 4 * 60_000)).toBe('4 min')
  expect(age(0, 75 * 60_000)).toBe('1 h 15 min')
})

test('sentence case keeps the rest as written', () => {
  expect(cap('ship to GitHub')).toBe('Ship to GitHub')
})

test('the same input draws the same source, so an unchanged bar does not flicker; different input, different ids', () => {
  const ids = (svg: string) => [...svg.matchAll(/id="([^"]+)"/g)].map(m => m[1])
  const one = trackSvg({ total: 5, done: 2, current: 'Test', isDone: false })
  expect(trackSvg({ total: 5, done: 2, current: 'Test', isDone: false })).toBe(one)
  const other = ids(trackSvg({ total: 5, done: 3, current: 'Deploy', isDone: false }))
  expect(ids(one).filter(x => other.includes(x))).toEqual([])
})

test('task-list steps slot into the stage in progress when they first appear, and keep it', () => {
  const one = applyPlan([], { items: [{ content: 'Read the API', status: 'in_progress' }, { content: 'Build it', status: 'pending' }] }, 1)
  expect(one.map(x => [x.name, x.status, x.phase])).toEqual([['Read the API', 'now', 1], ['Build it', 'next', 1]])
  const two = applyPlan(one, { advance: true }, 2)
  expect(two.map(x => [x.status, x.phase])).toEqual([['done', 1], ['now', 2]])
})

test('a state stored by an earlier version keeps its data and gains the new fields', () => {
  const kept = normalize({ project: 'P', stage: 'build', phases: ['A', 'B'], phase: 1, counts: [], items: [{ phase: 1, name: 'X', status: 'now' }] } as never)
  expect(kept?.project).toBe('P')
  expect(kept?.active).toEqual([])
  expect(kept?.items[0]?.after).toBeNull()
})

test('a small badge stays small', () => {
  expect(badgeSvg('done', 0, 16)).toContain('width="16"')
})

test('a pull request reads its CI as one word', () => {
  const pr = prRecordOf('o/r#7', { number: 7, state: 'OPEN', url: 'u', title: 't', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }] }, 0)
  expect(pr.ci).toBe('running')
})

test('the header age reads seconds, then minutes, then hours', () => {
  expect(agoOf(0)).toBe('0s ago')
  expect(agoOf(42_000)).toBe('42s ago')
  expect(agoOf(5 * 60_000)).toBe('5m ago')
  expect(agoOf(2 * 3_600_000)).toBe('2h ago')
})

test('a done time reads as a clock time with AM or PM', () => {
  const at = new Date(2026, 10, 25, 21, 5).getTime()
  expect(timeOfDay(at)).toBe('9:05 PM')
  expect(timeOfDay(new Date(2026, 10, 25, 0, 30).getTime())).toBe('12:30 AM')
})

test('a clock time is local time and names no time zone', () => {
  expect(timeOfDay(new Date(2026, 10, 25, 21, 5).getTime())).toBe('9:05 PM')
})
}

// ---- was doc.test.tsx
{
const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('a local Markdown link opens the document pane, which draws the file as Markdown', async ($, on) => {
  const opened: string[] = []
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: '# The plan\n\nOne line.' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 1, links: [{ phase: 0, label: 'Plan', href: '/tmp/plan.md' }], items: [{ phase: 0, name: 'a', status: 'done' }] } as never)
  const ui = await $.ui.mount({ ...PANE, requestId: 'progress', surface: 'desktop' })
  // Stage 0 is done and folded: open it first.
  await ui.press({ key: 'open-0' })
  // The document link is a plain button, as the tabs and artifact chips are; a press opens the document pane.
  const link = (await ui.findAll({ type: 'Button' })).find(x => String(x.props?.label ?? '') === '↗ Plan')
  expect(link).toBeTruthy()
  await ui.press({ key: String(link?.key ?? '') })
  expect(opened).toContain('mission-status-doc')
  await ui.unmount()
  const docUi = await $.ui.mount({ ...PANE, requestId: 'mission-status-doc', surface: 'desktop' })
  const md = await docUi.find({ type: 'Markdown' })
  expect(String(md?.props?.text ?? '')).toContain('# The plan')
  await docUi.unmount()
})
}

// A rebuilt picture restarts its animation, so a running strip must keep one source while its timer ticks.
test('a running helper strip keeps one source while time passes', () => {
  const strip = () => stripSvg({ title: 'Scan tests', detail: 'haiku', state: 'running' })
  expect(strip()).toBe(strip())
  expect(strip()).not.toContain('min')
})
