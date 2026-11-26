import type { Count, Item, ItemCi, Summary, Task } from '../types'
import { isWatchItem } from './watches'
import { cap, findRef, idOf } from './model'

// The state machine: one pure function from the facts to the status of every stage card and every item, and the one
// merge of the agent's items, the task-list steps and the marker's marks. The view draws only what this returns, so
// the header, the stage chips, the cards and the items can never disagree.
//
// Statuses: running (something runs for it now: a spinner and a live timer), open (started, not done, nothing runs:
// no spinner), done, failed, next (not started), needs (it waits on the person: an approval, a sign-off, an answer;
// no spinner).
export type NodeStatus = 'running' | 'open' | 'done' | 'failed' | 'next' | 'needs'

// What the pane knows besides the agent's tree. turnOpen: a main-loop turn runs now. waiting: the turn waits on the
// person (a question is open). hostKey: the item that holds the running helpers, or null. marks: the marker's kept
// marks by item id, each with the time it was kept.
export type Facts = {
  turnOpen: boolean
  waiting: boolean
  helpersRunning: boolean
  hostKey: string | null
  ci: Record<string, ItemCi | undefined>
  marks: Record<string, { status: 'done' | 'now' | 'failed' | 'needs'; at: number } | undefined>
}

export const NO_FACTS: Facts = { turnOpen: false, waiting: false, helpersRunning: false, hostKey: null, ci: {}, marks: {} }

export const itemKey = (x: Item) => `item-${x.phase}-${x.id ?? idOf(x.name)}`
export const stageKey = (k: number) => `stage-${k}`

// The one merge: the agent's items, with the facts that close them (a merged pull request, a bound task step), plus
// the task-list steps for stages the agent leaves empty (and any step in progress), plus the marker's newer marks.
export function mergeItems(s: NonNullable<Summary>, steps: Task[], facts: Facts): Item[] {
  // One tree: every task-list step is bound to at most one item, so the chat's checklist and the pane name each piece of
  // work once. A bound step draws no row of its own; its item takes its status.
  const bindings = bindSteps(s.items, steps)
  const items = s.items.map(x => {
    // A mark newer than the agent's own last word on the item stands in for its status.
    const mark = facts.marks[x.id ?? idOf(x.name)]
    const base = mark !== undefined && mark.at > (x.touchedAt ?? 0) ? { ...x, status: mark.status } : x
    if (base.status === 'done') return base
    // A merged pull request closes the item, unless the agent named the item after the merge: the work went on.
    const mergedAt = x.pr != null ? (facts.ci[x.pr]?.mergedAt ?? null) : null
    if (mergedAt !== null && mergedAt >= (x.touchedAt ?? 0)) return { ...base, status: 'done' as const, doneAt: mergedAt, since: null }
    // An item takes its bound steps' status: done when every bound step is done, running when one runs.
    const mine = steps.filter(t => bindings.get(t) === x)
    if (mine.length > 0 && mine.every(t => t.status === 'done')) {
      const at = Math.max(...mine.map(t => t.doneAt ?? 0))
      return { ...base, status: 'done' as const, doneAt: at > 0 ? at : (base.doneAt ?? null), since: null }
    }
    if (mine.some(t => t.status === 'now') && base.status === 'next') return { ...base, status: 'now' as const }
    return base
  })
  const fromSteps = steps
    .filter(t => !bindings.has(t))
    .map(t => ({ id: `task:${idOf(t.name)}`, phase: t.phase, name: cap(t.name), status: t.status, after: null, parent: null, when: null, since: t.since ?? null, doneAt: t.doneAt ?? null, seenAt: t.seenAt ?? null }) as Item)
  // A watch item (watching or waiting, not work) leaves the cards: the Watching section shows it (watches.ts).
  const merged = interleave(items, fromSteps)
  return merged.filter(x => !isWatchItem(x, merged))
}

// One list in the work's order: the agent's items keep the order it sent; each task-list step goes among them by time.
// A done step goes before the first top-level item of its stage that is not done or was done after it; any other
// step goes before the first top-level item not yet done that appeared after it. A step with no time goes last.
export function interleave(items: Item[], fromSteps: Item[]): Item[] {
  const out = [...items]
  for (const t of fromSteps) {
    const top = (x: Item) => x.phase === t.phase && x.parent == null && !x.id?.startsWith('task:')
    const k =
      t.status === 'done'
        ? out.findIndex(x => top(x) && (x.status !== 'done' || (x.doneAt ?? 0) > (t.doneAt ?? 0)))
        : t.seenAt == null
          ? -1
          : out.findIndex(x => top(x) && x.status !== 'done' && (x.seenAt ?? 0) > (t.seenAt ?? 0))
    if (k < 0) out.push(t)
    else out.splice(k, 0, t)
  }
  return out
}

// Words that carry meaning, for matching a step to an item.
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'then', 'that', 'this', 'its', 'run', 'add'])
const wordsOf = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)))

// Which item each task-list step is: the agent's own link (taskStep) first, then the same name, then one name inside
// the other, then the item whose words overlap the step's most (half or more of the smaller set). Any stage counts:
// a step is slotted in the stage that ran when it first appeared, and the agent's item for the same work may sit in a
// later one; an item in the step's own stage wins a tie. A step with no match stays its own row.
export function bindSteps(items: Item[], steps: Task[]): Map<Task, Item> {
  const out = new Map<Task, Item>()
  const norm = (t: string) => t.trim().toLowerCase()
  for (const t of steps) {
    const n = norm(t.name)
    const byLink = items.find(x => norm(x.taskStep ?? '') === n)
    const byName = items.find(x => norm(x.name) === n)
    const contains = (x: Item) => norm(x.name).length >= 4 && (n.includes(norm(x.name)) || norm(x.name).includes(n))
    const byContain = items.find(x => x.phase === t.phase && contains(x)) ?? items.find(contains)
    let best: Item | undefined
    let bestScore = 0
    const tw = wordsOf(t.name)
    for (const x of items) {
      const xw = wordsOf(x.name)
      const shared = [...tw].filter(w => xw.has(w)).length
      const score = (Math.min(tw.size, xw.size) === 0 ? 0 : shared / Math.min(tw.size, xw.size)) + (x.phase === t.phase ? 0.001 : 0)
      if (shared >= 1 && score >= 0.5 && score > bestScore) {
        best = x
        bestScore = score
      }
    }
    const hit = byLink ?? byName ?? byContain ?? best
    if (hit !== undefined) out.set(t, hit)
  }
  return out
}

// ---- The rules: two ordered tables, first match wins. Each table ends in a catch-all, so every input has exactly one
// status (mutually exclusive by order, exhaustive by the last row). Tests enumerate every input of each table.

// What decides an item: its claim (the agent's word, a mark or a closing fact, already merged), the set of its
// children's statuses, its dependency's status ('none' when it waits for nothing), and three facts.
export type ItemInput = {
  claim: 'now' | 'next' | 'done' | 'failed' | 'needs'
  // Its prerequisite (its wait, or the sibling sent before it unless it is parallel) is not done, or a parent's is not.
  blocked: boolean
  kids: readonly NodeStatus[]
  dep: NodeStatus | 'none'
  ciFailing: boolean
  live: boolean
  hosting: boolean
}
export type RuleOut = { status: NodeStatus; why: 'child' | 'dependency' | 'gate' | null }

// I1 failed: the agent says so, or its own open pull request's checks fail.
// I1a needs: the agent says it waits on the person; never running, whatever runs under it or in the session.
// I1b waiting: its prerequisite is not done, so nothing in it can run: open if a child has started, else next. A done
//     claim is not held here (a finished piece of work is a fact); only an explicit wait holds a done claim (I3).
// I2 running: a child runs (a running child always has a running parent).
// I3 the agent says done: done only when every child and the dependency are done; else open, with the reason.
// I4 running: it holds the session's running helpers.
// I5 the agent says now: running while a turn runs and waits on nobody; else open.
// I6 open: a child has started (open, done, failed or needs under a parent not yet started).
// I7 next: nothing has started.
export function itemRule(i: ItemInput): RuleOut {
  if (i.claim === 'failed' || i.ciFailing) return { status: 'failed', why: null }
  if (i.claim === 'needs') return { status: 'needs', why: null }
  if (i.blocked && i.claim !== 'done') return { status: i.kids.some(k => k !== 'next') ? 'open' : 'next', why: 'dependency' }
  if (i.kids.includes('running')) return { status: 'running', why: null }
  if (i.claim === 'done') {
    if (i.kids.some(k => k !== 'done')) return { status: 'open', why: 'child' }
    if (i.dep !== 'none' && i.dep !== 'done') return { status: 'open', why: 'dependency' }
    return { status: 'done', why: null }
  }
  if (i.hosting) return { status: 'running', why: null }
  if (i.claim === 'now') return { status: i.live ? 'running' : 'open', why: null }
  if (i.kids.some(k => k !== 'next')) return { status: 'open', why: null }
  return { status: 'next', why: null }
}

// What decides a stage: the set of its items' statuses, its gates as the agent claims them ('none' when it has none),
// where it stands against the stage number, and whether a turn runs. passed: before the current stage and not active.
// active: the current stage or one sent as active. ahead: after. Past the last stage, every stage counts as passed.
export type StageInput = { items: readonly NodeStatus[]; gates: 'none' | 'met' | 'unmet'; position: 'passed' | 'active' | 'ahead'; live: boolean }

// S1 running: an item runs.  S2 needs: an item waits on the person and none runs.  S3 failed: an item failed.
// S4 its work is finished: done when its gates are met; else open, waiting for the gate. Finished means it has items
//    and every one is done (wherever the stage number stands: the agent's number lags the work), or it has no items
//    and the stage number has passed it.
// S5 active: running while a turn runs; else open.
// S6 open when an item has started; else next.
export function stageRule(i: StageInput): RuleOut {
  if (i.items.includes('running')) return { status: 'running', why: null }
  if (i.items.includes('needs')) return { status: 'needs', why: null }
  if (i.items.includes('failed')) return { status: 'failed', why: null }
  const finished = i.items.length > 0 ? i.items.every(x => x === 'done') : i.position === 'passed'
  if (finished) return i.gates === 'unmet' ? { status: 'open', why: 'gate' } : { status: 'done', why: null }
  if (i.position === 'passed') return { status: 'open', why: 'child' }
  if (i.position === 'active') return { status: i.live ? 'running' : 'open', why: null }
  return { status: i.items.some(x => x !== 'next') ? 'open' : 'next', why: null }
}

// What the agent claims of a gate: met by a word (met, yes, done, approved, merged, passed) or by x of y reached.
export const claimMet = (c: Count) =>
  c.text !== undefined ? /^(met|yes|done|approved|merged|passed)$/i.test(c.text) : c.m !== undefined && c.n !== undefined && c.n >= c.m

export type Derived = {
  item: (x: Item) => NodeStatus
  stage: (k: number) => NodeStatus
  // A gate shows met only when the agent claims it and every item of its stage is done.
  gateMet: (c: Count) => boolean
  // The tree the machine judged: an item's children and its dependency, with every cycle cut.
  kids: (x: Item) => Item[]
  dep: (x: Item) => Item | undefined
  // The item it must wait for (its wait, or the sibling before it), and whether anything holds it now.
  pre: (x: Item) => Item | undefined
  blocked: (x: Item) => boolean
  stageOf: (x: Item) => number
  // Why an item or stage the agent called done shows open: the open child or dependency that holds it.
  reason: (key: string) => string | null
  allDone: boolean
}

// The derive: the tables applied over the tree, children and dependencies first. The tree is made acyclic first, so
// every node has one status and no order of evaluation can change it:
// - an item outside the stage list belongs to the nearest stage;
// - a parent chain that comes back to itself is cut (the item becomes a root);
// - a dependency on an item that depends, through children or waits, on this one is cut (it waits for nothing).
export function derive(s: NonNullable<Summary>, items: Item[], facts: Facts): Derived {
  const total = s.phases.length
  const last = Math.max(0, total - 1)
  const stageOf = (x: Item) => Math.max(0, Math.min(last, Number.isFinite(x.phase) ? Math.floor(x.phase) : 0))
  const parentRaw = (x: Item) => findRef(items, x.parent, x.phase, x)
  const loops = (x: Item): boolean => {
    const seen = new Set<Item>([x])
    for (let y = parentRaw(x); y !== undefined; y = parentRaw(y)) {
      if (y === x) return true
      if (seen.has(y)) return false
      seen.add(y)
    }
    return false
  }
  const parentOf = new Map<Item, Item | undefined>(items.map(x => [x, loops(x) ? undefined : parentRaw(x)]))
  const kidsOf = (x: Item) => items.filter(y => y !== x && parentOf.get(y) === x)
  // Dependencies, kept only where they add no cycle to the graph of children and kept dependencies.
  const depMap = new Map<Item, Item | undefined>()
  const reaches = (from: Item, to: Item): boolean => {
    const seen = new Set<Item>()
    const stack = [from]
    while (stack.length > 0) {
      const y = stack.pop() as Item
      if (y === to) return true
      if (seen.has(y)) continue
      seen.add(y)
      stack.push(...kidsOf(y))
      const d = depMap.get(y)
      if (d !== undefined) stack.push(d)
      const p = prevMap.get(y)
      if (p !== undefined) stack.push(p)
      // Waiting is inherited: an item waits on each ancestor's prerequisite too, so those count as its edges.
      for (let a = parentOf.get(y); a !== undefined; a = parentOf.get(a)) {
        const ad = depMap.get(a) ?? prevMap.get(a)
        if (ad !== undefined) stack.push(ad)
      }
    }
    return false
  }
  // The implicit order: an item with no wait of its own follows the sibling sent just before it, unless it is parallel.
  const prevMap = new Map<Item, Item | undefined>()
  for (const x of items) {
    const d = findRef(items, x.after, x.phase, x)
    depMap.set(x, d !== undefined && !reaches(d, x) ? d : undefined)
  }
  for (const x of items) {
    if (depMap.get(x) !== undefined || x.parallel === true) continue
    const siblings = items.filter(y => stageOf(y) === stageOf(x) && parentOf.get(y) === parentOf.get(x))
    const i = siblings.indexOf(x)
    const p = i > 0 ? siblings[i - 1] : undefined
    if (p !== undefined && !reaches(p, x)) prevMap.set(x, p)
  }
  const depOf = (x: Item) => depMap.get(x)
  // Its prerequisite: its wait, else the sibling before it.
  const preOf = (x: Item) => depMap.get(x) ?? prevMap.get(x)
  const live = facts.turnOpen && !facts.waiting

  const memo = new Map<Item, NodeStatus>()
  const reasons = new Map<string, string>()
  const visiting = new Set<Item>()
  // Blocked: its prerequisite is not done, or its parent is blocked (nothing inside waiting work runs).
  const blockMemo = new Map<Item, Item | null>()
  const blocker = (x: Item): Item | null => {
    const known = blockMemo.get(x)
    if (known !== undefined) return known
    blockMemo.set(x, null)
    const pre = preOf(x)
    const parent = parentOf.get(x)
    const out = pre !== undefined && item(pre) !== 'done' ? pre : parent !== undefined ? blocker(parent) : null
    blockMemo.set(x, out)
    return out
  }
  const item = (x: Item): NodeStatus => {
    const known = memo.get(x)
    if (known !== undefined) return known
    // A cycle the cuts above could not see (a wait inside another chain): the item counts as waiting.
    if (visiting.has(x)) return 'next'
    visiting.add(x)
    const kids = kidsOf(x)
    const kidStates = kids.map(item)
    const dep = depOf(x)
    const ci = x.pr != null ? facts.ci[x.pr] : undefined
    const held = blocker(x)
    const out = itemRule({
      claim: x.status,
      blocked: held !== null,
      kids: kidStates,
      dep: dep === undefined ? 'none' : item(dep),
      ciFailing: ci?.state === 'failing' && ci.mergedAt == null,
      live,
      hosting: facts.hostKey === itemKey(x) && facts.helpersRunning,
    })
    if (out.why === 'child') reasons.set(itemKey(x), `${x.name} waits for its step "${kids.find((_, i) => kidStates[i] !== 'done')?.name ?? ''}"`)
    if (out.why === 'dependency') reasons.set(itemKey(x), `${x.name} waits for "${(held ?? dep)?.name ?? ''}"`)
    visiting.delete(x)
    memo.set(x, out.status)
    return out.status
  }

  // A stage's gates: the exit clauses the agent sent for it.
  const gatesOf = (k: number) => (s.counts ?? []).filter(c => c.phase === k && c.when !== undefined)
  // Every item of the stage is done (or it has none).
  const workDone = (k: number) => items.filter(x => stageOf(x) === k).every(x => item(x) === 'done')
  const stageMemo = new Map<number, NodeStatus>()
  const stage = (k: number): NodeStatus => {
    const known = stageMemo.get(k)
    if (known !== undefined) return known
    const mine = items.filter(x => stageOf(x) === k)
    const states = mine.map(item)
    const position = s.phase >= total || (k < s.phase && !s.active.includes(k)) ? 'passed' : k === s.phase || s.active.includes(k) ? 'active' : 'ahead'
    const gates = gatesOf(k)
    const out = stageRule({ items: states, gates: gates.length === 0 ? 'none' : gates.every(claimMet) ? 'met' : 'unmet', position, live })
    if (out.why === 'child') reasons.set(stageKey(k), `${s.phases[k] ?? 'The stage'} waits for "${mine.find((_, i) => states[i] !== 'done')?.name ?? ''}"`)
    if (out.why === 'gate') reasons.set(stageKey(k), `${s.phases[k] ?? 'The stage'} waits for its gate "${gates.find(c => !claimMet(c))?.when ?? ''}"`)
    stageMemo.set(k, out.status)
    return out.status
  }

  // Never all done while an item waits on the person.
  const allDone = total > 0 && s.phases.every((_, k) => stage(k) === 'done') && !facts.helpersRunning && !items.some(x => item(x) === 'needs')
  const gateMet = (c: Count) => claimMet(c) && (c.phase === undefined || c.phase === null ? true : workDone(c.phase))
  return { item, stage, gateMet, kids: kidsOf, dep: depOf, pre: preOf, blocked: x => blocker(x) !== null, stageOf, reason: key => reasons.get(key) ?? null, allDone }
}

// A node's time, from what the pane knows, in order: its own counted running time; else the running time its children
// counted (a stage the stage number jumped past still ran its items); else the span from its children's first start
// to their last finish; else, when only finish times are known, the time it finished (a clock time, not a duration).
export type Timing = { ms: number } | { at: number } | null
export function timeOf(own: number | null, kids: readonly { ran: number | null; since?: number | null; doneAt?: number | null }[]): Timing {
  if (own !== null && own > 0) return { ms: own }
  const ran = kids.reduce((sum, k) => sum + (k.ran ?? 0), 0)
  if (ran > 0) return { ms: ran }
  const starts = kids.map(k => k.since ?? null).filter((x): x is number => x !== null)
  const ends = kids.map(k => k.doneAt ?? null).filter((x): x is number => x !== null)
  if (starts.length > 0 && ends.length > 0 && Math.max(...ends) > Math.min(...starts)) return { ms: Math.max(...ends) - Math.min(...starts) }
  if (ends.length > 0) return { at: Math.max(...ends) }
  return null
}

// The sanity rules, as one check of a derive. Tests run it on every derive; it returns the broken rules.
export function brokenRules(s: NonNullable<Summary>, items: Item[], facts: Facts, d: Derived): string[] {
  const out: string[] = []
  const kidsOf = d.kids
  for (const x of items) {
    const st = d.item(x)
    const dep = d.dep(x)
    if (st === 'done' && dep !== undefined && d.item(dep) !== 'done') out.push(`1: ${x.name} is done but its dependency ${dep.name} is not`)
    if (st === 'done' && kidsOf(x).some(k => d.item(k) !== 'done')) out.push(`2: ${x.name} is done with an open child`)
    for (const k of kidsOf(x)) if (d.item(k) === 'running' && st !== 'running' && st !== 'failed' && st !== 'needs') out.push(`3: ${k.name} runs under ${x.name}, which is ${st}`)
    const evidence = (facts.turnOpen && !facts.waiting) || (facts.hostKey === itemKey(x) && facts.helpersRunning) || kidsOf(x).some(k => d.item(k) === 'running')
    if (st === 'running' && !evidence) out.push(`4: ${x.name} runs with no live evidence`)
    const pre = d.pre(x)
    if (st === 'running' && pre !== undefined && d.item(pre) !== 'done') out.push(`10: ${x.name} runs before ${pre.name} is done`)
    if (st === 'running' && d.blocked(x)) out.push(`10: ${x.name} runs inside waiting work`)
  }
  for (const c of s.counts ?? []) {
    if (c.when === undefined || c.phase === undefined || c.phase === null) continue
    if (d.gateMet(c) && items.some(x => d.stageOf(x) === c.phase && d.item(x) !== 'done')) out.push(`11: gate "${c.when}" shows met while its stage has open work`)
  }
  s.phases.forEach((_, k) => {
    const st = d.stage(k)
    const mine = items.filter(x => d.stageOf(x) === k)
    if (mine.length > 0 && mine.every(x => d.item(x) === 'done') && st !== 'done' && st !== 'open') out.push(`12: stage ${k} has all its work done but shows ${st}`)
    if (st === 'done' && (s.counts ?? []).some(c => c.phase === k && c.when !== undefined && !claimMet(c))) out.push(`13: stage ${k} is done with an unmet gate`)
    if (st === 'done' && items.some(x => d.stageOf(x) === k && d.item(x) !== 'done')) out.push(`2: stage ${k} is done with an open item`)
  })
  if (d.allDone && (items.some(x => d.item(x) === 'running') || facts.helpersRunning)) out.push('5: all done while something runs')
  return out
}
