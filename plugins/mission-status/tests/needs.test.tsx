import { expect, test } from 'claude-code/testing'
import type { Item, Summary } from '../types'
import { NO_FACTS, brokenRules, derive, mergeItems, type Facts } from '../hooks/machine'
import { needsBadgeSvg } from '../hooks/bars'

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
