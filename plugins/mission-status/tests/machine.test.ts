import { expect, test } from 'claude-code/testing'
import type { Item, Summary, Task } from '../types'
import { NO_FACTS, brokenRules, derive, itemKey, itemRule, mergeItems, stageRule, timeOf, type Facts, type NodeStatus } from '../hooks/machine'
import { settleRuns } from '../hooks/store'

// A small seeded generator (a plugin imports only its own files, so no property-testing library): the same seed gives
// the same trees, so a failure names a sequence that can be run again.
function rng(seed: number) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}
const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length)] as T

function randomState(r: () => number): { s: NonNullable<Summary>; steps: Task[]; facts: Facts } {
  const phases = ['Plan', 'Build', 'Test', 'Ship'].slice(0, 2 + Math.floor(r() * 3))
  const phase = Math.floor(r() * (phases.length + 1))
  const items: Item[] = []
  const n = Math.floor(r() * 9)
  for (let i = 0; i < n; i++) {
    const ph = Math.floor(r() * phases.length)
    const same = items.filter(x => x.phase === ph)
    // Parents and waits point at earlier items, sometimes at later ones or at themselves, so loops get made too.
    const parent = same.length > 0 && r() < 0.4 ? (pick(r, same).id ?? null) : r() < 0.05 ? `i${i + 1}` : null
    const after = same.length > 0 && r() < 0.3 ? (pick(r, same).id ?? null) : null
    items.push({ id: `i${i}`, phase: ph, name: `Item ${i}`, status: pick(r, ['now', 'next', 'done', 'failed', 'done', 'now'] as const), after, parent, when: null, since: null, touchedAt: 0 } as Item)
  }
  const s = { project: 'P', ticket: null, links: [], goalLine: null, stage: 'build', phases, phase, symptom: null, hypotheses: [], waitingOn: null, waitingSince: 0, counts: [], items, active: r() < 0.2 ? [Math.floor(r() * phases.length)] : [], template: null, starts: [], ends: [], change: null, at: 0 } as unknown as NonNullable<Summary>
  const steps: Task[] = Array.from({ length: Math.floor(r() * 3) }, (_, k) => ({ name: `Step ${k}`, status: pick(r, ['now', 'next', 'done'] as const), phase: Math.floor(r() * phases.length), since: null }))
  const facts: Facts = { ...NO_FACTS, turnOpen: r() < 0.6, waiting: r() < 0.1, helpersRunning: r() < 0.2, hostKey: null }
  return { s, steps, facts }
}

test('2,000 random trees and facts: every sanity rule holds on every derive', () => {
  const failures: string[] = []
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed)
    const { s, steps, facts } = randomState(r)
    const items = mergeItems(s, steps, facts)
    const host = items.find(x => x.status === 'now' && x.phase === s.phase)
    const f = { ...facts, hostKey: host !== undefined && r() < 0.5 ? itemKey(host) : null }
    const d = derive(s, items, f)
    for (const b of brokenRules(s, items, f, d)) failures.push(`seed ${seed}: ${b}`)
  }
  expect(failures.slice(0, 5)).toEqual([])
})

test('nothing runs without a turn, a helper or a running child: a "now" left over shows open', () => {
  const r = rng(7)
  const { s } = randomState(r)
  const one = { ...s, phases: ['Build'], phase: 0, active: [], items: [{ id: 'a', phase: 0, name: 'A', status: 'now', after: null, parent: null, when: null } as Item] }
  expect(derive(one, one.items, { ...NO_FACTS, turnOpen: false }).item(one.items[0] as Item)).toBe('open')
  expect(derive(one, one.items, { ...NO_FACTS, turnOpen: true }).item(one.items[0] as Item)).toBe('running')
  // A question to the person stops the run too.
  expect(derive(one, one.items, { ...NO_FACTS, turnOpen: true, waiting: true }).item(one.items[0] as Item)).toBe('open')
})

test('a parent the agent called done stays open while a child is open, and says why; the header is not done', () => {
  const items = [
    { id: 'p', phase: 0, name: 'Parent', status: 'done', after: null, parent: null, when: null },
    { id: 'c', phase: 0, name: 'Child', status: 'next', after: null, parent: 'p', when: null },
  ] as Item[]
  const s = { phases: ['Only'], phase: 1, active: [], items } as unknown as NonNullable<Summary>
  const d = derive(s, items, NO_FACTS)
  expect(d.item(items[0] as Item)).toBe('open')
  expect(d.reason(itemKey(items[0] as Item))).toContain('Child')
  expect(d.stage(0)).toBe('open')
  expect(d.allDone).toBe(false)
})

test('if A depends on B and B is not done, A is not done', () => {
  const items = [
    { id: 'b', phase: 0, name: 'B', status: 'next', after: null, parent: null, when: null },
    { id: 'a', phase: 0, name: 'A', status: 'done', after: 'b', parent: null, when: null },
  ] as Item[]
  const s = { phases: ['Only'], phase: 0, active: [], items } as unknown as NonNullable<Summary>
  expect(derive(s, items, NO_FACTS).item(items[1] as Item)).toBe('open')
})

test('a loop in parents never hangs and its items count as open', () => {
  const items = [
    { id: 'a', phase: 0, name: 'A', status: 'done', after: null, parent: 'b', when: null },
    { id: 'b', phase: 0, name: 'B', status: 'done', after: null, parent: 'a', when: null },
  ] as Item[]
  const s = { phases: ['Only'], phase: 1, active: [], items } as unknown as NonNullable<Summary>
  const d = derive(s, items, NO_FACTS)
  expect(['open', 'done']).toContain(d.item(items[0] as Item))
  expect(d.allDone).toBe(d.stage(0) === 'done')
})

test('a merged pull request closes its item even while the agent still says now', () => {
  const items = [{ id: 'a', phase: 0, name: 'A', status: 'now', after: null, parent: null, when: null, pr: '7', touchedAt: 10 } as Item]
  const s = { phases: ['Only'], phase: 0, active: [], items } as unknown as NonNullable<Summary>
  const facts = { ...NO_FACTS, turnOpen: true, ci: { '7': { state: 'passing' as const, start: null, end: null, mergedAt: 20 } } }
  const merged = mergeItems(s, [], facts)
  expect(derive(s, merged, facts).item(merged[0] as Item)).toBe('done')
})

test('a mark newer than the agent stands in for its status; the agent\'s next word wins again', () => {
  const items = [{ id: 'a', phase: 0, name: 'A', status: 'now', after: null, parent: null, when: null, touchedAt: 10 } as Item]
  const s = { phases: ['Only'], phase: 0, active: [], items } as unknown as NonNullable<Summary>
  const newer = { ...NO_FACTS, marks: { a: { status: 'done' as const, at: 20 } } }
  expect(mergeItems(s, [], newer)[0]?.status).toBe('done')
  const older = { ...NO_FACTS, marks: { a: { status: 'done' as const, at: 5 } } }
  expect(mergeItems(s, [], older)[0]?.status).toBe('now')
})

test('running time counts only while running, and a second settle at the same time changes nothing', () => {
  let runs = settleRuns({}, new Set(['x']), 1_000)
  expect(runs.x).toEqual({ ms: 0, from: 1_000 })
  runs = settleRuns(runs, new Set(), 4_000)
  expect(runs.x).toEqual({ ms: 3_000, from: null })
  // An idle hour adds nothing.
  runs = settleRuns(runs, new Set(), 4_000 + 3_600_000)
  expect(runs.x?.ms).toBe(3_000)
  runs = settleRuns(runs, new Set(['x']), 5_000_000)
  const again = settleRuns(runs, new Set(['x']), 5_000_000)
  expect(again).toBe(runs)
})

// Every input of each rule table, enumerated: claims, every set of child statuses, every dependency status and every
// fact. Each input maps to one status by construction (first match); these checks prove the rules hold for all.
const ALL: NodeStatus[] = ['running', 'open', 'done', 'failed', 'next', 'needs']
const subsets = <T,>(xs: T[]): T[][] => xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map(a => [...a, x])], [[]])

test('item table: every one of 35,840 inputs keeps the rules (done needs done children and dependency; a running child runs its parent unless it needs the person; running needs evidence; needs never runs; nothing starts itself)', () => {
  const bad: string[] = []
  let n = 0
  for (const claim of ['now', 'next', 'done', 'failed', 'needs'] as const)
   for (const blocked of [false, true])
    for (const kids of subsets(ALL))
      for (const dep of ['none', ...ALL] as const)
        for (const ciFailing of [false, true])
          for (const live of [false, true])
            for (const hosting of [false, true]) {
              n++
              const i = { claim, blocked, kids, dep, ciFailing, live, hosting }
              // Cannot happen: a waiting parent makes its children wait, so none of them runs.
              if (blocked && kids.includes('running')) continue
              const { status, why } = itemRule(i)
              const tag = JSON.stringify(i)
              if (status === 'done' && (kids.some(k => k !== 'done') || (dep !== 'none' && dep !== 'done'))) bad.push(`done too early ${tag}`)
              if (kids.includes('running') && status !== 'running' && status !== 'failed' && status !== 'needs') bad.push(`running child, parent ${status} ${tag}`)
              if (status === 'running' && !live && !hosting && !kids.includes('running')) bad.push(`runs with no evidence ${tag}`)
              if (claim === 'needs' && !ciFailing && status !== 'needs') bad.push(`needs hidden ${tag}`)
              if (claim === 'needs' && status === 'running') bad.push(`needs runs ${tag}`)
              if (kids.includes('needs') && status === 'done') bad.push(`done over a needs child ${tag}`)
              if (blocked && status === 'running') bad.push(`runs before its prerequisite is done ${tag}`)
              if (claim === 'next' && kids.every(k => k === 'next') && !hosting && !ciFailing && status !== 'next') bad.push(`starts by itself ${tag}`)
              if ((claim === 'failed' || ciFailing) && status !== 'failed') bad.push(`failure hidden ${tag}`)
              if (claim === 'done' && !ciFailing && kids.every(k => k === 'done') && (dep === 'none' || dep === 'done') && status !== 'done') bad.push(`done withheld ${tag}`)
              if (status === 'open' && claim === 'done' && why === null) bad.push(`held with no reason ${tag}`)
            }
  expect(n).toBe(5 * 2 * 64 * 7 * 2 * 2 * 2)
  expect(bad.slice(0, 5)).toEqual([])
})

test('stage table against an independent spec, over every input: items, gates, position and turn', () => {
  // The spec in plain words, written apart from the table: what the owner would call true.
  const spec = (items: NodeStatus[], gates: 'none' | 'met' | 'unmet', position: 'passed' | 'active' | 'ahead', live: boolean): NodeStatus => {
    if (items.includes('running')) return 'running' // something in it runs
    if (items.includes('needs')) return 'needs' // something in it waits on the person
    if (items.includes('failed')) return 'failed' // something in it failed
    const allDone = items.length > 0 && items.every(x => x === 'done')
    const emptyAndPassed = items.length === 0 && position === 'passed'
    if ((allDone || emptyAndPassed) && gates !== 'unmet') return 'done' // its work is finished and its gate is met
    if (allDone || emptyAndPassed) return 'open' // finished work, gate not met: waits for the gate
    if (position === 'active') return live ? 'running' : 'open' // the agent works here now
    return items.some(x => x !== 'next') || position === 'passed' ? 'open' : 'next' // started, or behind the agent
  }
  const bad: string[] = []
  let n = 0
  for (const items of subsets(ALL))
    for (const gates of ['none', 'met', 'unmet'] as const)
      for (const position of ['passed', 'active', 'ahead'] as const)
        for (const live of [false, true]) {
          n++
          const got = stageRule({ items, gates, position, live }).status
          const want = spec(items, gates, position, live)
          if (got !== want) bad.push(`${JSON.stringify({ items, gates, position, live })}: table ${got}, spec ${want}`)
        }
  expect(n).toBe(2 ** ALL.length * 3 * 3 * 2)
  expect(bad.slice(0, 5)).toEqual([])
})

test('the owner\'s cases: a stage whose items are all done is done even when the agent\'s stage number lags; a met gate over running work is not met', () => {
  const items = [it('Machine', 1, 'done'), it('Facts', 1, 'done'), it('Rules', 1, 'done')]
  const s = { ...one(items, ['A', 'State machine', 'C'], 0), counts: [] }
  const d = derive(s as never, items, { ...NO_FACTS, turnOpen: true })
  expect(d.stage(1)).toBe('done')
  const work = [it('Check.sh passes', 0, 'now', { note: '234 of 237 pass' }), it('Merge machine branch', 0, 'next')]
  const gate = { phase: 0, when: 'All tests pass', label: 'Tests', text: 'Met' }
  const s2 = { ...one(work, ['Check'], 0), counts: [gate] }
  const d2 = derive(s2 as never, work, { ...NO_FACTS, turnOpen: true })
  expect(d2.gateMet(gate as never)).toBe(false)
  expect(d2.stage(0)).toBe('running')
  expect(brokenRules(s2 as never, work, { ...NO_FACTS, turnOpen: true }, d2)).toEqual([])
  // All work done but the gate unmet: the stage waits for the gate.
  const done2 = work.map(x => ({ ...x, status: 'done' }) as Item)
  const s3 = { ...one(done2, ['Check'], 0), counts: [{ ...gate, text: 'Waiting' }] }
  const d3 = derive(s3 as never, done2, NO_FACTS)
  expect(d3.stage(0)).toBe('open')
  expect(d3.reason('stage-0')).toContain('All tests pass')
})

test('the tree is made acyclic first: a wait on an ancestor, a descendant or a cycle of waits is cut, and the result does not depend on order', () => {
  // Parallel, so the order the list is sent in carries no meaning here: only the evaluation order is under test.
  const mk = (id: string, status: string, parent: string | null, after: string | null) => ({ id, phase: 0, name: id, status, parent, after, when: null, parallel: true }) as Item
  const shapes = [
    [mk('a', 'done', null, 'b'), mk('b', 'done', 'a', null)], // a waits for its own child
    [mk('a', 'done', 'b', null), mk('b', 'done', null, 'a')], // b waits for its own child
    [mk('a', 'done', null, 'b'), mk('b', 'done', null, 'c'), mk('c', 'done', null, 'a')], // a cycle of waits
    [mk('a', 'done', null, 'c'), mk('b', 'done', 'a', null), mk('c', 'now', null, 'b')], // a wait through a child
  ]
  for (const items of shapes) {
    const s = { phases: ['Only'], phase: 1, active: [], items } as unknown as NonNullable<Summary>
    const forward = derive(s, items, NO_FACTS)
    const backward = derive(s, [...items].reverse(), NO_FACTS)
    for (const x of items) expect(forward.item(x)).toBe(backward.item(x))
    expect(brokenRules(s, items, NO_FACTS, forward)).toEqual([])
  }
})

test('an item outside the stage list belongs to the nearest stage, so "all done" never hides it', () => {
  const items = [{ id: 'x', phase: 9, name: 'Lost', status: 'now', after: null, parent: null, when: null } as Item]
  const s = { phases: ['A', 'B'], phase: 2, active: [], items } as unknown as NonNullable<Summary>
  const d = derive(s, items, { ...NO_FACTS, turnOpen: true })
  expect(d.stage(1)).toBe('running')
  expect(d.allDone).toBe(false)
})

const it = (id: string, phase: number, status: string, extra: Partial<Item> = {}) => ({ id, phase, name: id, status, after: null, parent: null, when: null, ...extra }) as Item
const one = (items: Item[], phases: string[], phase: number) => ({ phases, phase, active: [], items } as unknown as NonNullable<Summary>)

test('the owner\'s Report card: one row runs, in order, and the checklist step is the same row, not a duplicate', () => {
  const items = [it('Revenue chart', 0, 'done'), it('Package bundle', 0, 'next'), it('Write digest', 0, 'now'), it('Verify release', 0, 'next')]
  const s = one(items, ['Report'], 0)
  const steps: Task[] = [{ name: 'Package and write the digest', status: 'now', phase: 0, since: null }]
  const facts = { ...NO_FACTS, turnOpen: true }
  const merged = mergeItems(s, steps, facts)
  expect(merged.length).toBe(4)
  const d = derive(s, merged, facts)
  const running = merged.filter(x => d.item(x) === 'running').map(x => x.name)
  // The step binds to "Package bundle" (it named it first among equals) or "Write digest"; either way only work whose
  // predecessor is done runs, and nothing runs out of order.
  expect(running.length).toBeLessThanOrEqual(1)
  for (const x of merged) if (d.item(x) === 'running') expect(d.pre(x) === undefined || d.item(d.pre(x) as Item) === 'done').toBe(true)
  expect(d.item(merged[2] as Item)).not.toBe('running')
  expect(brokenRules(s, merged, facts, d)).toEqual([])
})

test('the owner\'s Analyze card: the checklist step joins "Warehouse load", and later items wait', () => {
  const items = [
    it('Warehouse load', 0, 'now'),
    it('Load tables', 0, 'done', { parent: 'Warehouse load' }),
    it('Run queries', 0, 'now', { parent: 'Warehouse load' }),
    it('Revenue tests', 0, 'next'),
    it('Payments sync', 0, 'next'),
  ]
  const s = one(items, ['Analyze'], 0)
  const steps: Task[] = [{ name: 'Load warehouse and run queries', status: 'now', phase: 0, since: null }]
  const facts = { ...NO_FACTS, turnOpen: true }
  const merged = mergeItems(s, steps, facts)
  expect(merged.map(x => x.name)).toEqual(['Warehouse load', 'Load tables', 'Run queries', 'Revenue tests', 'Payments sync'])
  const d = derive(s, merged, facts)
  expect(d.item(merged[0] as Item)).toBe('running')
  expect(d.item(merged[2] as Item)).toBe('running')
  expect(d.item(merged[3] as Item)).toBe('next')
  expect(brokenRules(s, merged, facts, d)).toEqual([])
})

test('parallel lets an item run beside the one before it; without it, it waits', () => {
  const facts = { ...NO_FACTS, turnOpen: true }
  const seq = [it('A', 0, 'now'), it('B', 0, 'now')]
  const d1 = derive(one(seq, ['S'], 0), seq, facts)
  expect([d1.item(seq[0] as Item), d1.item(seq[1] as Item)]).toEqual(['running', 'next'])
  const par = [it('A', 0, 'now'), it('B', 0, 'now', { parallel: true })]
  const d2 = derive(one(par, ['S'], 0), par, facts)
  expect([d2.item(par[0] as Item), d2.item(par[1] as Item)]).toEqual(['running', 'running'])
})

test('a checklist step with no matching item stays its own row; a matched one never draws twice', () => {
  const items = [it('Write docs', 0, 'next')]
  const steps: Task[] = [
    { name: 'Write the docs', status: 'now', phase: 0, since: null },
    { name: 'Deploy to staging', status: 'next', phase: 0, since: null },
  ]
  const merged = mergeItems(one(items, ['S'], 0), steps, NO_FACTS)
  expect(merged.map(x => x.name)).toEqual(['Write docs', 'Deploy to staging'])
  expect(merged[0]?.status).toBe('now')
})

test('all done is false while any item needs the person', () => {
  const items = [
    { id: 'a', phase: 0, name: 'Ship', status: 'done', after: null, parent: null, when: null },
    { id: 'b', phase: 0, name: 'Sign-off', status: 'needs', after: null, parent: null, when: null },
  ] as Item[]
  const s = { phases: ['Only'], phase: 1, active: [], items } as unknown as NonNullable<Summary>
  const d = derive(s, items, NO_FACTS)
  expect(d.item(items[1]!)).toBe('needs')
  expect(d.stage(0)).toBe('needs')
  expect(d.allDone).toBe(false)
  expect(brokenRules(s, items, NO_FACTS, d)).toEqual([])
})

test('a node\'s time comes from its children when it has none of its own: a stage the stage number jumped past still has a time', () => {
  expect(timeOf(5_000, [])).toEqual({ ms: 5_000 })
  expect(timeOf(null, [{ ran: 2_000 }, { ran: 3_000 }])).toEqual({ ms: 5_000 })
  expect(timeOf(null, [{ ran: null, since: 1_000, doneAt: 4_000 }, { ran: null, doneAt: 9_000 }])).toEqual({ ms: 8_000 })
  expect(timeOf(null, [{ ran: null, doneAt: 9_000 }])).toEqual({ at: 9_000 })
  expect(timeOf(null, [])).toBeNull()
})
