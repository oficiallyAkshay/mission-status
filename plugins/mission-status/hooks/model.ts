import type { CardLink, Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, StepEntry, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket, Runbook, RunbookStatus, RunbookStep } from '../types'


// The stage bar of each kind of work: the stages it passes through, in order.
export const PHASES: Record<StageKey, string[]> = {
  plan: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  build: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  review: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  ship: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  fix: ['Reproduce', 'Find cause', 'Fix', 'Test', 'Deploy'],
  cause: ['Reproduce', 'Test causes', 'Confirm cause', 'Fix', 'Learn'],
}
export const STAGE_KEYS = Object.keys(PHASES) as StageKey[]

// Templates: quick choices of stage lists. The model picks one that fits the session, or writes its own stages
// when none fits, and changes them whenever the work changes.
export const TEMPLATES: Record<string, string[]> = {
  feature: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'],
  'product-loop': ['Plan', 'Build', 'Review', 'Deploy', 'Monitor', 'Iterate'],
  'bug-fix': ['Reproduce', 'Find cause', 'Fix', 'Test', 'Deploy'],
  incident: ['Detect', 'Triage', 'Mitigate', 'Root cause', 'Fix', 'Review'],
  research: ['Question', 'Gather', 'Analyze', 'Synthesize', 'Report'],
  design: ['Brief', 'Explore', 'Pick', 'Refine', 'Hand off'],
  'board-batch': ['Intake', 'Plan', 'Build', 'Review', 'Merge'],
  writing: ['Outline', 'Draft', 'Review', 'Publish'],
  migration: ['Plan', 'Dry run', 'Migrate', 'Verify', 'Clean up'],
  'plan-review': ['Intake', 'Draft', 'Review waves', 'Your rows', 'Hand off'],
}
// The most sub-phases one item's line holds.
export const MAX_SUB = 8
export const HYPOTHESIS_STATES: readonly HypothesisState[] = ['open', 'testing', 'ruled out', 'confirmed']


// One task-list call applied to the steps: a whole list, or advance / done / start on the list as it stands.
export function applyPlan(list: Task[], args: Record<string, unknown>, phase: number): Task[] {
  let next = [...list]
  if (Array.isArray(args.items)) {
    next = (args.items as unknown[])
      .map(raw => {
        const o = (raw ?? {}) as Record<string, unknown>
        const name = typeof o.content === 'string' ? o.content : ''
        const status: Task['status'] = o.status === 'completed' ? 'done' : o.status === 'in_progress' ? 'now' : 'next'
        const was = list.find(x => x.name === name)
        const since = status === 'now' ? (was?.status === 'now' ? (was.since ?? Date.now()) : Date.now()) : null
        const doneAt = status === 'done' ? (was?.status === 'done' ? (was.doneAt ?? Date.now()) : Date.now()) : null
        // A step that starts now goes to the stage that runs now, as advance and start move it.
        const moved = status === 'now' && was !== undefined && was.status !== 'now'
        return { name, status, phase: moved ? phase : (was?.phase ?? phase), since, doneAt }
      })
      .filter(x => x.name !== '')
  }
  const set = (i: number, status: Task['status']) => {
    const x = next[i]
    if (x !== undefined)
      next[i] = { ...x, status, phase: status === 'now' && x.status === 'next' ? phase : x.phase, since: status === 'now' ? (x.status === 'now' ? (x.since ?? Date.now()) : Date.now()) : null, doneAt: status === 'done' ? (x.status === 'done' ? (x.doneAt ?? Date.now()) : Date.now()) : null }
  }
  if (args.advance === true) {
    const k = next.findIndex(x => x.status === 'now')
    if (k >= 0) set(k, 'done')
    const n = next.findIndex(x => x.status === 'next')
    if (n >= 0) set(n, 'now')
  }
  if (Array.isArray(args.done)) for (const d of args.done) if (typeof d === 'number') set(d - 1, 'done')
  if (typeof args.start === 'number') set(args.start - 1, 'now')
  return next
}



export const base = (path: unknown) => (typeof path === 'string' ? (path.split('/').pop() ?? path) : '')
export const clip = (text: string, max = 70) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// The chat's own status words for a tool call; null for the pane's own calls.
export function actionOf(e: Record<string, unknown>): string | null {
  const tool = String(e.tool ?? '')
  if (tool.startsWith('mcp__mission-status__') || tool.startsWith('mcp__ccd_') || tool === 'ToolSearch') return null
  if (tool === 'Bash') return 'Running a command'
  if (tool === 'Read') return 'Reading a file'
  if (tool === 'Edit' || tool === 'MultiEdit') return 'Editing a file'
  if (tool === 'Write') return 'Writing a file'
  if (tool === 'Grep' || tool === 'Glob') return 'Searching'
  if (tool === 'Agent' || tool === 'Task') return 'Running a helper'
  if (tool === 'WebSearch') return 'Searching the web'
  if (tool === 'WebFetch') return 'Reading a web page'
  if (tool === 'AskUserQuestion') return 'Waiting for your answer'
  if (tool === 'Skill') return 'Loading a skill'
  if (tool === 'SendMessage') return 'Sending a message'
  return 'Using a tool'
}



export const ITEM_STATES: readonly ItemStatus[] = ['done', 'now', 'next', 'failed', 'needs']

// A skill's steps, read from its SKILL.md: the numbered lines of its Steps (or Order of work) section, else every
// numbered line. A bold lead names the step; else its first words do. At most 20.
export function skillSteps(md: string): string[] {
  const lines = md.split('\n')
  const start = lines.findIndex(l => /^#{2,3}\s+(steps|order of work|procedure|workflow)\b/i.test(l))
  let body = lines
  if (start >= 0) {
    const end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l))
    body = lines.slice(start + 1, end < 0 ? undefined : end)
  }
  const out: string[] = []
  for (const l of body) {
    const m = /^\s{0,3}(\d+)\.\s+(.*)$/.exec(l)
    if (m === null) continue
    const bold = /^\*\*([^*]+?)\*\*/.exec(m[2] ?? '')
    const words = (bold?.[1] ?? (m[2] ?? '').replace(/[*`_]/g, '')).replace(/[.:]+$/, '').split(/\s+/).slice(0, 8).join(' ')
    if (words !== '') out.push(cap(words))
    if (out.length >= 20) break
  }
  return out
}

// The UTF-8 size of a text, for byte offsets into a file.
export function byteLength(text: string): number {
  let n = 0
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      k++
    } else n += 3
  }
  return n
}

// Every pull request a session made, from its transcript (JSON lines): the own result of each call that may make one.
export function prRefsInTranscript(text: string): string[] {
  return prRefsInLines(text.split('\n'), new Set<string>())
}

// The same over some lines, with the calls seen so far kept in makers, so a scan can go in parts. The branches the
// calls' own inputs name go into branches.
export function prRefsInLines(lines: string[], makers: Set<string>, branches: Set<string> = new Set()): string[] {
  const out: string[] = []
  for (const line of lines) {
    const use = line.includes('"tool_use"') && line.includes('"Bash"')
    const res = line.includes('"tool_result"') && line.includes('/pull/')
    if (!use && !res) continue
    let content: unknown
    try {
      content = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content
    } catch {
      continue
    }
    if (!Array.isArray(content)) continue
    for (const c of content as { type?: unknown; id?: unknown; name?: unknown; input?: { command?: unknown }; tool_use_id?: unknown; content?: unknown }[]) {
      if (c?.type === 'tool_use' && c.name === 'Bash' && typeof c.input?.command === 'string') {
        if (PR_MAKERS.test(c.input.command)) makers.add(String(c.id))
        for (const b of branchesIn(c.input.command)) branches.add(b)
      }
      if (c?.type === 'tool_result' && makers.has(String(c.tool_use_id)))
        for (const ref of prUrlsIn(JSON.stringify(c.content ?? ''))) if (!out.includes(ref)) out.push(ref)
    }
  }
  return out
}

// The commands whose output names the pull requests they made: gh pr create, and a Marga job (marga run, wait or
// collect), which may open one in another repository. The live catch and the transcript scan use the same matcher.
export const PR_MAKERS = /\b(?:gh\s+pr\s+create|marga\s+(?:run|wait|collect))\b/

// Every pull request address in a text, as owner/name#number.
export function prUrlsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g)) out.add(`${m[1]}#${m[2]}`)
  return [...out]
}

// The pull requests a tool call made: every pull request address in the output of a call PR_MAKERS matches.
export function prRefsIn(command: string, output: string): string[] {
  return PR_MAKERS.test(command) ? prUrlsIn(output) : []
}

// The newest 30 pull requests: the earlier ones first in the order first seen, the new ones after.
export const unionRefs = (list: string[], added: string[]) => [...list, ...added.filter(r => !list.includes(r))].slice(-30)

// The branches a command names as its own input: git push's targets, git checkout -b, git switch -c, git worktree
// add -b and gh pr create --head. A branch that only a command's output names does not count.
export function branchesIn(command: string): string[] {
  const out = new Set<string>()
  const ok = (b: string | undefined) => {
    const name = (b ?? '').replace(/^refs\/heads\//, '')
    if (name !== '' && name !== 'HEAD' && !name.startsWith('-') && /^[\w./-]+$/.test(name)) out.add(name)
  }
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = (part.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["']|["']$/g, ''))
    const flag = (args: string[], names: string[]) => {
      for (let k = 0; k < args.length; k++) {
        const w = args[k] ?? ''
        if (names.includes(w)) ok(args[k + 1]?.split(':').pop())
        for (const n of names) if (n.startsWith('--') && w.startsWith(`${n}=`)) ok(w.slice(n.length + 1).split(':').pop())
      }
    }
    const gh = words.indexOf('gh')
    if (gh >= 0 && words[gh + 1] === 'pr' && words[gh + 2] === 'create') flag(words.slice(gh + 3), ['--head', '-H'])
    let g = words.indexOf('git')
    if (g < 0) continue
    // git's own options before the subcommand: -C and -c take a value.
    g++
    while (g < words.length && (words[g] ?? '').startsWith('-')) g += words[g] === '-C' || words[g] === '-c' ? 2 : 1
    const sub = words[g]
    const rest = words.slice(g + 1)
    if (sub === 'checkout' || sub === 'switch') flag(rest, ['-b', '-B', '-c', '-C', '--create', '--force-create'])
    else if (sub === 'worktree' && rest[0] === 'add') flag(rest, ['-b', '-B'])
    else if (sub === 'push') {
      const valued = ['--repo', '-o', '--push-option', '--receive-pack', '--exec']
      const pos: string[] = []
      for (let k = 0; k < rest.length; k++) {
        const w = rest[k] ?? ''
        if (valued.includes(w)) k++
        else if (!w.startsWith('-')) pos.push(w)
      }
      // The first word is the remote; each refspec after it names its target branch.
      for (const spec of pos.slice(1)) ok(spec.replace(/^\+/, '').split(':').pop())
    }
  }
  return [...out]
}

// An item's pull request: a number in the work's repository, or owner/name#number in another.
export const PR_REF = /^(?:[\w.-]+\/[\w.-]+#)?\d{1,7}$/
export function asPrRef(v: unknown): string | null {
  const t = typeof v === 'number' ? String(Math.round(v)) : typeof v === 'string' ? v.trim() : ''
  return PR_REF.test(t) ? t : null
}

export function asItem(raw: unknown): Item | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const name = str(o.name)
  const phase = num(o.phase)
  if (name === null || phase === undefined) return undefined
  const after = str(o.after)
  const parent = str(o.parent)
  const text = str(o.text)
  return {
    id: str(o.id) ?? idOf(name),
    phase: Math.round(phase),
    name: cap(name),
    status: ITEM_STATES.find(x => x === o.status) ?? 'next',
    after: after === null ? null : cap(after),
    parent: parent === null ? null : cap(parent),
    when: str(o.when),
    // Sentence case, as for names.
    note: str(o.note) === null ? null : cap(str(o.note) ?? ''),
    n: num(o.n),
    m: num(o.m),
    text: text === null ? undefined : cap(text),
    pr: asPrRef(o.pr),
    ...subPhases(o),
    ...(o.stepsParallel === true ? { stepsParallel: true } : {}),
    taskStep: str(o.taskStep),
    // Siblings follow one another in the order sent; parallel lets this one run beside the one before it.
    ...(o.parallel === true ? { parallel: true } : {}),
  }
}

// An item's sub-phases: a short dot-separated line under its name, the one at step shown bold and the others faint.
// steps null clears the line. A step outside the list shows every sub-phase faint.
// A sub-step sent as { name, steps } keeps its entry in stepsSent; the line shows the rest (see splitSteps).
function subPhases(o: Record<string, unknown>): Pick<Item, 'steps' | 'step' | 'stepsSent' | 'stepSent'> {
  const out: Pick<Item, 'steps' | 'step' | 'stepsSent' | 'stepSent'> = {}
  const step = num(o.step)
  if (o.step === null) out.step = null
  else if (step !== undefined) out.step = Math.round(step)
  if (o.steps === null) out.steps = null
  else if (Array.isArray(o.steps)) Object.assign(out, splitSteps(stepEntries(o.steps), out.step))
  return out
}

// The sub-steps as sent, cleaned: names in sentence case, at most MAX_SUB in a list, nested lists to MAX_DEPTH. An object
// entry with no steps of its own is just its name.
const MAX_DEPTH = 4
function stepEntries(raw: unknown[], depth = 0): StepEntry[] {
  const out: StepEntry[] = []
  for (const x of raw) {
    if (typeof x === 'string') {
      if (x.trim() !== '') out.push(cap(x.trim()))
      continue
    }
    if (!isObj(x) || str(x.name) === null) continue
    const name = cap(str(x.name) ?? '')
    const steps = Array.isArray(x.steps) && depth < MAX_DEPTH ? stepEntries(x.steps, depth + 1) : []
    if (steps.length === 0) {
      out.push(name)
      continue
    }
    const status = ITEM_STATES.find(k => k === x.status)
    const note = str(x.note)
    out.push({ name, steps, ...(status ? { status } : {}), ...(note !== null ? { note: cap(note) } : {}) })
  }
  return out.slice(0, MAX_SUB)
}

const promotable = (e: StepEntry): e is Exclude<StepEntry, string> => typeof e !== 'string' && (e.steps?.length ?? 0) > 0

// The steps line once the entries with their own sub-steps are taken out, with step moved so it still names the same
// sub-step (null when that one was taken out). With no such entry, the line is the list as sent and nothing is kept.
function splitSteps(sent: StepEntry[], at: number | null | undefined): Pick<Item, 'steps' | 'step' | 'stepsSent' | 'stepSent'> {
  if (!sent.some(promotable)) return { steps: sent.map(e => (typeof e === 'string' ? e : e.name)), ...(at !== undefined ? { step: at } : {}) }
  const steps: string[] = []
  let step: number | null | undefined = at === undefined || at === null ? at : null
  sent.forEach((e, k) => {
    if (promotable(e)) return
    if (k === at) step = steps.length
    // An object entry with no sub-steps of its own stays as its name (the guard above narrows its type away).
    steps.push(typeof e === 'string' ? e : (e as { name: string }).name)
  })
  // A step past the end still shows every sub-phase faint.
  if (typeof at === 'number' && at >= sent.length) step = steps.length
  return { steps, step, stepsSent: sent, stepSent: at ?? null }
}

// Promotion: each sub-step sent as { name, steps } becomes its own child item under the item that holds it, in the same
// stage, with id <parent id>-<its name as an id>. Its status is the one sent, else read from its place: before step done,
// at step (or any place while the parent runs its sub-steps in parallel and is now) now, else next. Promoted items are
// made again from their parent at every pass, so a repeated write makes no duplicate and a parent that drops the entry
// drops the child. An item the agent sent with the same id wins over the promoted one.
export function promoteSteps(items: Item[]): Item[] {
  const before = new Map(items.filter(x => x.promoted === true).map(x => [x.id ?? idOf(x.name), x]))
  const agents = items.filter(x => x.promoted !== true)
  const taken = new Set(agents.map(x => x.id ?? idOf(x.name)))
  const out: Item[] = []
  const add = (x: Item, depth: number) => {
    out.push(x)
    const sent = x.stepsSent
    if (!Array.isArray(sent) || depth > MAX_DEPTH) return
    const at = x.stepSent
    const parent = x.id ?? idOf(x.name)
    sent.forEach((e, k) => {
      if (!promotable(e)) return
      const id = `${parent}-${idOf(e.name)}`
      if (taken.has(id)) return
      taken.add(id)
      const status: ItemStatus =
        e.status ??
        // A done parent's sub-steps are done; parallel sub-steps of a running parent all run; else by position.
        (x.status === 'done'
          ? 'done'
          : x.stepsParallel === true
            ? x.status === 'now' ? 'now' : 'next'
            : typeof at === 'number' && k < at ? 'done' : k === at ? 'now' : 'next')
      const was = before.get(id)
      const child: Item = {
        id,
        phase: x.phase,
        name: e.name,
        status,
        after: null,
        parent,
        when: null,
        note: e.note ?? null,
        promoted: true,
        ...splitSteps(e.steps ?? [], undefined),
        // Its timers: the ones it had at the last pass, else its parent's.
        since: status === 'now' ? (was?.status === 'now' ? was.since : x.since) ?? null : null,
        doneAt: status === 'done' ? (was?.status === 'done' ? was.doneAt : x.doneAt) ?? null : null,
        touchedAt: was?.touchedAt ?? x.touchedAt ?? null,
      }
      add(child, depth + 1)
    })
  }
  for (const x of agents) add(x, 0)
  return out
}

// An item's steps from a stored state: a list that still holds { name, steps } entries (written before this version
// split them, or by hand) is split here, so every read promotes them.
function sentSteps(x: Item): Pick<Item, 'steps' | 'step' | 'stepsSent' | 'stepSent'> {
  const raw = x.stepsSent ?? (x.steps as unknown)
  if (!Array.isArray(raw) || !raw.some(e => typeof e !== 'string')) return {}
  return splitSteps(stepEntries(raw), x.stepsSent ? x.stepSent : x.step)
}

export const figureOf = (c: Count) => (c.text !== undefined ? c.text : c.m === undefined ? `${c.n ?? ''}` : `${c.n ?? 0} of ${c.m}`)

// A stored state from any earlier version: every field this version reads gets a value, so a reload keeps the pane.
export function normalize(raw: Summary): Summary {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const phases = Array.isArray(r.phases) && r.phases.length > 0 ? (r.phases as string[]) : ['Plan', 'Build', 'Test', 'Deploy', 'Learn']
  return {
    project: typeof r.project === 'string' ? r.project : 'Project',
    ticket: (r.ticket as Summary extends infer T ? T extends { ticket: infer K } ? K : never : never) ?? null,
    links: Array.isArray(r.links) ? (r.links as CardLink[]) : [],
    goalLine: typeof r.goalLine === 'string' ? r.goalLine : null,
    stage: (typeof r.stage === 'string' ? r.stage : 'build') as StageKey,
    phases,
    phase: typeof r.phase === 'number' ? r.phase : 0,
    active: Array.isArray(r.active) ? (r.active as number[]) : [],
    template: typeof r.template === 'string' ? r.template : null,
    symptom: typeof r.symptom === 'string' ? r.symptom : null,
    hypotheses: Array.isArray(r.hypotheses) ? (r.hypotheses as Hypothesis[]) : [],
    waitingOn: typeof r.waitingOn === 'string' ? r.waitingOn : null,
    waitingSince: typeof r.waitingSince === 'number' ? r.waitingSince : 0,
    counts: Array.isArray(r.counts) ? (r.counts as Count[]) : [],
    items: Array.isArray(r.items)
      ? linkRefs(promoteSteps((r.items as Item[]).map(x => ({ ...x, id: x.id ?? idOf(x.name), after: x.after ?? null, parent: x.parent ?? null, when: x.when ?? null, ...sentSteps(x) }))))
      : [],
    starts: Array.isArray(r.starts) ? (r.starts as (number | null)[]) : phases.map(() => null),
    ends: Array.isArray(r.ends) ? (r.ends as (number | null)[]) : phases.map(() => null),
    change: (r.change as { label: string; from: string; at: number } | null) ?? null,
    at: typeof r.at === 'number' ? r.at : 0,
    version: typeof r.version === 'number' ? r.version : 0,
    repo: typeof r.repo === 'string' && r.repo.startsWith('/') ? r.repo : null,
    runbooks: Array.isArray(r.runbooks) ? (r.runbooks as unknown[]).map(asRunbook).filter((x): x is Runbook => x !== undefined) : [],
    waitingForAgent: r.waitingForAgent === true,
    mayBeOutOfDate: r.mayBeOutOfDate === true,
    agentVersion: typeof r.agentVersion === 'number' ? r.agentVersion : 0,
  }
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

// Sentence case: the first letter up, the rest as written, so proper names keep their capitals.
export const cap = (text: string): string => (text === '' ? text : text.charAt(0).toUpperCase() + text.slice(1))

export function asCount(raw: unknown): Count | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const label = str(o.label)
  const n = num(o.n)
  const text = str(o.text)
  const when = str(o.when)
  if (label === null && when === null) return undefined
  const phase = num(o.phase)
  return {
    label: cap(label ?? when ?? ''),
    when: when ?? undefined,
    n,
    m: num(o.m),
    text: text === null ? undefined : cap(text),
    phase: phase === undefined ? undefined : Math.round(phase),
    href: str(o.href) ?? undefined,
    hrefLabel: str(o.hrefLabel) ?? undefined,
  }
}

export function asHypothesis(raw: unknown): Hypothesis | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const text = str(o.text)
  if (text === null) return undefined
  return { text: cap(text), state: HYPOTHESIS_STATES.find(x => x === o.state) ?? 'open' }
}

// The chat's own elapsed form: 12s, then 1m 5s.
export function secondsOf(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
}

// A stage timer: MM:SS, or H:MM:SS past an hour.
export function clockOf(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const ss = String(sec % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${String(m).padStart(2, '0')}:${ss}`
}

export function since(from: number, to: number): string {
  const sec = Math.floor(Math.max(0, to - from) / 1000)
  return sec < 60 ? `${sec} s ago` : `${age(from, to)} ago`
}

export function age(from: number, to: number): string {
  const min = Math.floor(Math.max(0, to - from) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`
}

// The pane reads helpers and this branch's pull requests itself.

// A link on a card: to a plan, a document, a page, a pull request or any made artifact. A stage card holds the links
// with its phase; an item holds the links that name it.
export function asLink(raw: unknown): CardLink | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const href = str(o.href)
  if (href === null) return undefined
  const phase = num(o.phase)
  return { phase: phase === undefined ? null : Math.round(phase), item: str(o.item), label: str(o.label) ?? 'Open', href }
}

// ---- The schema's guards: size cap, validation, item ids, patches (v1 scope item 1) ----

// The size cap of one agent update and of the stored state.
export const CAP_BYTES = 32 * 1024
// The freshness triggers (product plan, "How the state stays current").
export const AUTO_OPEN_CALLS = 5 // the pane opens by itself at the 5th tool call with no agent state
export const STALE_MS = 10 * 60_000 // 10 minutes of tool calls with no agent update
export const STALE_STEPS = 3 // or 3 task-list steps started with no agent update
export const IGNORED_AFTER = 3 // a reminder is ignored when 3 tool calls pass, or the turn ends, with no update
export const IGNORED_LIMIT = 2 // after 2 ignored reminders the state is marked "May be out of date"
export const UPDATE_TOOL = 'mcp__mission-status__update'

// The standing rule: in the system prompt, and put back into the context after each compaction.
export const RULE =
  '# Mission status pane\nKeep the Mission status pane current with mcp__mission-status__update at every meaningful change. ' +
  'At each update, look again at the stages: keep a template only while it fits the work, and send new stages when the work changes. ' +
  'Stages may run in parallel (active). The pane reads the task list, git, pull requests and helpers itself: do not send those. ' +
  'The pane has four levels: a card is one stage (phases); a step is an item in a card; a sub-step is an item under a step (its parent); ' +
  'sub-sub-steps are one line under a sub-step (its steps; stepsParallel when they run at the same time). ' +
  'Give each step a stable id, and send small step changes as patch operations. Never name a step as its card: a step is work inside the card. ' +
  'When the work is in another repository than the session folder, send repo once. ' +
  'When an item has a pull request, send its number as the item\'s pr, so the pane shows its CI. ' +
  'When the session follows a runbook (a numbered procedure or checklist), send it as runbooks with each step\'s status, and keep it current. A skill you run with numbered steps gets its tab by itself (id skill-<name>): mark its steps as you go. ' +
  'The pane is the only progress report. In the chat, write only what the person must do or decide to unblock the work ' +
  '(a decision, an approval, a step only they can do), and a direct answer when they ask a question. ' +
  'Send no progress lines, status, recaps, plans or narration in the chat: put them in the pane.'

// The one-line reminder the pane adds to the agent's next step.
// The check every 2 minutes: the items the pane still shows in progress, asked about by name.
export const CHECK_MS = 2 * 60_000
export function checkLine(names: string[]): string {
  return `Mission status pane check: are these still in progress: ${names.join('; ')}? If any finished or changed, send a patch with mcp__mission-status__update now.`
}
export const REMINDER = 'Mission status pane: the state is stale. Send the current state with mcp__mission-status__update now.'
export const FIRST_REMINDER =
  'Mission status pane: it opened by itself from the task list and waits for you. Send the first state with mcp__mission-status__update now.'
// The end of a turn that did work but sent the pane nothing: one short request, so the pane moves every turn.
export const TURN_TEXT =
  'Mission status pane: this turn did work but sent no update. Before you end the turn, send what changed (stage, items, gates) with mcp__mission-status__update.'
export const HOLD_TEXT =
  'Mission status pane: the state is stale. Before you end the turn, send the current state with mcp__mission-status__update.'

// A stable id from a name: lower case, words joined by hyphens.
export const idOf = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item'

// The UTF-8 size of a value as JSON, without TextEncoder (the hooks module has no web globals).
export function bytesOf(value: unknown): number {
  const text = JSON.stringify(value) ?? ''
  let n = 0
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      k += 1
    } else n += 3
  }
  return n
}


// The fields the engine or the test kit puts on a tool call's input, never part of the state.
const CALL_KEYS = new Set(['tool', 'agentId', 'tool_use_id', 'toolUseId'])
export const argsOf = (e: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(e).filter(([k]) => !CALL_KEYS.has(k)))

export type PatchOp = { op: 'add' | 'remove' | 'change'; id?: string; [field: string]: unknown }
export const PATCH_OPS = ['add', 'remove', 'change'] as const
// Task-list steps belong to the pane; an agent item may not take their id space.
const PANE_ID = /^task:/i

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown) => typeof v === 'string' && v.trim() !== ''
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v)

// A steps list: at most MAX_SUB entries, each a name or { name, steps?, status?, note? } (nested to MAX_DEPTH).
function stepsOk(v: unknown, depth: number): boolean {
  if (!Array.isArray(v) || v.length > MAX_SUB) return false
  return v.every(e =>
    isText(e) ||
    (isObj(e) && isText(e.name) &&
      (e.steps === undefined || (depth < MAX_DEPTH && stepsOk(e.steps, depth + 1))) &&
      (e.status === undefined || ITEM_STATES.includes(e.status as ItemStatus)) &&
      (e.note === undefined || typeof e.note === 'string')),
  )
}

function checkItemFields(o: Record<string, unknown>, where: string, whole: boolean, errors: string[]): void {
  if (whole || o.name !== undefined) if (!isText(o.name)) errors.push(`${where}: name must be a non-empty string`)
  if (whole || o.phase !== undefined) if (!isNum(o.phase) || (o.phase as number) < 0) errors.push(`${where}: phase must be a number from 0`)
  if (o.status !== undefined && !ITEM_STATES.includes(o.status as ItemStatus)) errors.push(`${where}: status must be one of ${ITEM_STATES.join(', ')}`)
  if (o.id !== undefined && !isText(o.id)) errors.push(`${where}: id must be a non-empty string`)
  if (isText(o.id) && PANE_ID.test(String(o.id))) errors.push(`${where}: id ${String(o.id)} belongs to the pane's task list`)
  for (const k of ['after', 'parent', 'note', 'when', 'text', 'taskStep'] as const)
    if (o[k] !== undefined && o[k] !== null && typeof o[k] !== 'string') errors.push(`${where}: ${k} must be a string`)
  for (const k of ['n', 'm'] as const) if (o[k] !== undefined && !isNum(o[k])) errors.push(`${where}: ${k} must be a number`)
  if (o.steps !== undefined && o.steps !== null && !stepsOk(o.steps, 0))
    errors.push(`${where}: steps must be a list of at most ${MAX_SUB} names or { name, steps } entries`)
  if (o.stepsParallel !== undefined && typeof o.stepsParallel !== 'boolean') errors.push(`${where}: stepsParallel must be true or false`)
  if (o.step !== undefined && o.step !== null && !isNum(o.step)) errors.push(`${where}: step must be a number`)
  if (o.pr !== undefined && o.pr !== null && asPrRef(o.pr) === null) errors.push(`${where}: pr must be a pull request number, or owner/name#number`)
}

// Every error in an agent update, in plain words; none means the update is valid. A failed update writes nothing.
// ---- Runbooks: each one a tab beside Progress ----
export const RUNBOOK_STATES = ['done', 'now', 'next', 'failed', 'blocked'] as const
export const MAX_RUNBOOKS = 4
export const MAX_STEPS = 60

export function asRunbook(raw: unknown): Runbook | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const id = str(o.id)
  if (id === null) return undefined
  const steps = (Array.isArray(o.steps) ? o.steps : [])
    .map(x => {
      const s = (x ?? {}) as Record<string, unknown>
      const name = str(s.name)
      if (name === null) return undefined
      const status = RUNBOOK_STATES.includes(s.status as RunbookStatus) ? (s.status as RunbookStatus) : 'next'
      return { name, status, note: str(s.note), waitsOn: str(s.waitsOn) }
    })
    .filter((x): x is RunbookStep => x !== undefined)
    .slice(0, MAX_STEPS)
  return { id, title: str(o.title) ?? id, href: str(o.href), steps }
}

// Runbooks an update sends replace the stored ones with the same id; remove: true drops one.
export function mergeRunbooks(old: Runbook[], raw: unknown[]): Runbook[] {
  let next = [...old]
  for (const x of raw) {
    const o = (x ?? {}) as Record<string, unknown>
    const id = str(o.id)
    if (id === null) continue
    next = next.filter(r => r.id !== id)
    if (o.remove === true) continue
    const r = asRunbook(o)
    if (r !== undefined) next.push(r)
  }
  return next.slice(0, MAX_RUNBOOKS)
}

// A personal template's name: what the person calls it, kept short.
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9-]{0,29}$/
// $.store key: the person's own templates, name to stage list, shared by every session on this machine.
export const TEMPLATES_KEY = 'templates'

export function asTemplates(v: unknown): Record<string, string[]> {
  if (v === null || typeof v !== 'object') return {}
  const out: Record<string, string[]> = {}
  for (const [k, list] of Object.entries(v as Record<string, unknown>))
    if (TEMPLATE_NAME.test(k) && Array.isArray(list) && list.length >= 2 && list.length <= 8 && list.every(x => typeof x === 'string')) out[k] = list as string[]
  return out
}

// The standing rule's line on the person's own templates, or nothing when there are none.
export function templatesLine(personal: Record<string, string[]>): string {
  const rows = Object.entries(personal).map(([k, v]) => `${k} (${v.join(', ')})`)
  return rows.length === 0 ? '' : ` The person's own templates, usable as template: ${rows.join('; ')}.`
}

export function checkUpdate(args: Record<string, unknown>, old: Summary, agentVersion = 0, personal: Record<string, string[]> = {}): string[] {
  const errors: string[] = []
  const size = bytesOf(args)
  if (size > CAP_BYTES) return [`the update is ${Math.ceil(size / 1024)} KB; the cap is 32 KB`]
  if (old === null) {
    if (!isText(args.project)) errors.push('the first state needs project')
    if (!isNum(args.phase)) errors.push('the first state needs phase')
  }
  if (args.project !== undefined && !isText(args.project)) errors.push('project must be a non-empty string')
  if (args.phase !== undefined && (!isNum(args.phase) || (args.phase as number) < 0)) errors.push('phase must be a number from 0')
  if (args.stage !== undefined && !STAGE_KEYS.includes(args.stage as StageKey)) errors.push(`stage must be one of ${STAGE_KEYS.join(', ')}`)
  if (args.runbooks !== undefined) {
    if (!Array.isArray(args.runbooks)) errors.push('runbooks must be a list')
    else
      args.runbooks.forEach((raw, k) => {
        if (!isObj(raw) || !isText(raw.id)) return void errors.push(`runbooks[${k}] needs id`)
        if (raw.remove === true) return
        if (!isText(raw.title)) errors.push(`runbooks[${k}] needs title`)
        if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > MAX_STEPS) errors.push(`runbooks[${k}].steps must be 1 to ${MAX_STEPS} steps`)
        else
          raw.steps.forEach((st, j) => {
            if (!isObj(st) || !isText(st.name)) errors.push(`runbooks[${k}].steps[${j}] needs name`)
            else if (st.status !== undefined && !RUNBOOK_STATES.includes(st.status as RunbookStatus))
              errors.push(`runbooks[${k}].steps[${j}]: status must be one of ${RUNBOOK_STATES.join(', ')}`)
          })
      })
  }
  if (Array.isArray(args.runbooks)) {
    const ids = new Set((old?.runbooks ?? []).map(r => r.id))
    for (const raw of args.runbooks) if (isObj(raw) && isText(raw.id)) raw.remove === true ? ids.delete(String(raw.id).trim()) : ids.add(String(raw.id).trim())
    if (ids.size > MAX_RUNBOOKS) errors.push(`at most ${MAX_RUNBOOKS} runbooks show; remove one first with {id, remove: true}`)
  }
  if (args.repo !== undefined && args.repo !== null && !(typeof args.repo === 'string' && args.repo.startsWith('/') && !args.repo.split('/').includes('..')))
    errors.push('repo must be an absolute folder path, or null for the session folder')
  if (args.saveTemplate !== undefined && !(typeof args.saveTemplate === 'string' && TEMPLATE_NAME.test(args.saveTemplate)))
    errors.push('saveTemplate must be a name of 1 to 30 lower-case letters, digits and dashes')
  if (typeof args.saveTemplate === 'string' && Object.hasOwn(TEMPLATES, args.saveTemplate)) errors.push(`saveTemplate ${args.saveTemplate} is a built-in template; pick another name`)
  if (args.template !== undefined && !(typeof args.template === 'string' && (Object.hasOwn(TEMPLATES, args.template) || Object.hasOwn(personal, args.template))))
    errors.push(`template must be one of ${[...Object.keys(TEMPLATES), ...Object.keys(personal)].join(', ')}`)
  if (args.phases !== undefined) {
    const ok = Array.isArray(args.phases) && args.phases.length >= 2 && args.phases.length <= 8 && args.phases.every(isText)
    if (!ok) errors.push('phases must be 2 to 8 non-empty strings')
  }
  if (args.version !== undefined) {
    if (!isNum(args.version) || !Number.isInteger(args.version) || (args.version as number) < 1) errors.push('version must be a whole number from 1')
    else if ((args.version as number) <= agentVersion)
      errors.push(`version ${String(args.version)} is older than the stored version ${agentVersion}; send ${agentVersion + 1} or more`)
  }
  for (const k of ['goalLine', 'symptom', 'waitingOn'] as const)
    if (args[k] !== undefined && args[k] !== null && typeof args[k] !== 'string') errors.push(`${k} must be a string or null`)
  for (const k of ['items', 'patch', 'counts', 'hypotheses', 'links', 'active'] as const)
    if (args[k] !== undefined && !Array.isArray(args[k])) errors.push(`${k} must be a list`)
  if (args.items !== undefined && args.patch !== undefined) errors.push('send items (the whole list) or patch (changes), not both')
  // An item named as its own stage repeats the card's title: refused, with the fix in the error.
  {
    const picked = typeof args.template === 'string' ? (Object.hasOwn(TEMPLATES, args.template) ? TEMPLATES[args.template] : Object.hasOwn(personal, args.template) ? personal[args.template] : undefined) : undefined
    const stages = Array.isArray(args.phases)
      ? (args.phases as unknown[]).map(String)
      : picked !== undefined
        ? picked
        : typeof args.stage === 'string' && STAGE_KEYS.includes(args.stage as StageKey) && args.stage !== old?.stage
          ? PHASES[args.stage as StageKey]
          : (old?.phases ?? [])
    const same = (name: unknown, phase: unknown) =>
      typeof name === 'string' && typeof phase === 'number' && (stages[Math.round(phase)] ?? '').trim().toLowerCase() === name.trim().toLowerCase()
    const listed = Array.isArray(args.items) ? (args.items as unknown[]) : []
    const patched = Array.isArray(args.patch) ? (args.patch as unknown[]) : []
    // A change of stages is checked against the stored items it keeps, so no item ends up named as its stage.
    const touched = new Set(patched.filter(isObj).map(x => String(x.id ?? '')))
    const kept = Array.isArray(args.items) ? [] : (old?.items ?? []).filter(x => !touched.has(x.id ?? idOf(x.name))).map(x => ({ id: x.id, name: x.name, phase: x.phase }))
    for (const raw of [...listed, ...patched, ...kept]) {
      if (!isObj(raw)) continue
      const base = isText(raw.id) ? (old?.items ?? []).find(x => (x.id ?? idOf(x.name)) === raw.id) : undefined
      const name = raw.name ?? base?.name
      const phase = raw.phase ?? base?.phase
      if (same(name, phase)) errors.push(`item ${String(name)} has its stage's own name: name the work inside the stage, not the stage again`)
    }
  }
  if (Array.isArray(args.items)) {
    const seen = new Set<string>()
    args.items.forEach((raw, k) => {
      if (!isObj(raw)) return void errors.push(`items[${k}] must be an object`)
      checkItemFields(raw, `items[${k}]`, true, errors)
      const id = isText(raw.id) ? String(raw.id) : isText(raw.name) ? idOf(String(raw.name)) : null
      if (id !== null && seen.has(id)) errors.push(`items[${k}]: id ${id} is used twice`)
      if (id !== null) seen.add(id)
    })
  }
  if (Array.isArray(args.patch)) {
    const ids = new Set((old?.items ?? []).map(x => x.id ?? idOf(x.name)))
    args.patch.forEach((raw, k) => {
      const where = `patch[${k}]`
      if (!isObj(raw)) return void errors.push(`${where} must be an object`)
      const op = raw.op
      if (!PATCH_OPS.includes(op as PatchOp['op'])) return void errors.push(`${where}: op must be add, remove or change`)
      if (op === 'add') {
        checkItemFields(raw, where, true, errors)
        const id = isText(raw.id) ? String(raw.id) : isText(raw.name) ? idOf(String(raw.name)) : null
        if (id !== null && ids.has(id)) errors.push(`${where}: id ${id} exists; use change`)
        if (id !== null) ids.add(id)
        return
      }
      if (!isText(raw.id)) return void errors.push(`${where}: ${String(op)} needs the item's id`)
      const id = String(raw.id)
      if (PANE_ID.test(id)) return void errors.push(`${where}: id ${id} belongs to the pane's task list`)
      if (!ids.has(id)) return void errors.push(`${where}: no item has id ${id}`)
      if (op === 'remove') ids.delete(id)
      else checkItemFields({ ...raw, id: undefined }, where, false, errors)
    })
  }
  if (Array.isArray(args.counts))
    args.counts.forEach((raw, k) => {
      if (!isObj(raw) || !(isText(raw.when) || isText(raw.label))) errors.push(`counts[${k}] needs when`)
    })
  if (Array.isArray(args.hypotheses))
    args.hypotheses.forEach((raw, k) => {
      if (!isObj(raw) || !isText(raw.text)) errors.push(`hypotheses[${k}] needs text`)
      else if (raw.state !== undefined && !HYPOTHESIS_STATES.includes(raw.state as HypothesisState))
        errors.push(`hypotheses[${k}]: state must be one of ${HYPOTHESIS_STATES.join(', ')}`)
    })
  if (Array.isArray(args.links))
    args.links.forEach((raw, k) => {
      if (!isObj(raw) || !isText(raw.href)) errors.push(`links[${k}] needs href`)
    })
  return errors
}

// parent and after name an item by its id or by its name; each is stored as the item's id, so the cards nest and wait
// the same either way, and a rename of the item keeps its children and its waits.
export function linkRefs(items: Item[]): Item[] {
  const asId = (ref: string | null, phase: number, self: Item): string | null => {
    const hit = findRef(items, ref, phase, self)
    return hit === undefined ? ref : (hit.id ?? idOf(hit.name))
  }
  return items.map(x => ({ ...x, parent: asId(x.parent, x.phase, x), after: asId(x.after, x.phase, x) }))
}

// An item named by another (as its parent or the item it waits for): by id first, then by name, in the same stage.
// The agent is told to give each item a stable id, so a reference by id is the common case.
export function findRef(items: Item[], ref: string | null | undefined, phase: number, self?: Item): Item | undefined {
  if (ref === null || ref === undefined || ref.trim() === '') return undefined
  const r = ref.trim().toLowerCase()
  const inStage = items.filter(x => x.phase === phase && x !== self)
  return (
    inStage.find(x => (x.id ?? idOf(x.name)).toLowerCase() === r) ??
    inStage.find(x => x.name.trim().toLowerCase() === r) ??
    inStage.find(x => (x.id ?? idOf(x.name)) === idOf(ref))
  )
}

// Siblings in the work's own order: the order the agent sent, moved only so an item comes after the one it waits for.
export function workOrder(list: Item[], all: Item[]): Item[] {
  const out: Item[] = []
  const left = [...list]
  // Each pass takes one item out, so the loop ends; a wait loop falls back to the sent order.
  while (left.length > 0) {
    const k = left.findIndex(x => {
      const w = findRef(all, x.after, x.phase, x)
      return w === undefined || !left.includes(w)
    })
    out.push(...left.splice(k < 0 ? 0 : k, 1))
  }
  return out
}

// Items whose parent chain comes back to themselves never draw: each such item is named.
export function parentLoops(items: Item[]): string[] {
  const errors: string[] = []
  for (const x of items) {
    let at: Item | undefined = x
    for (let k = 0; k <= items.length && at?.parent != null; k++) {
      at = findRef(items, at.parent, x.phase, at)
      if (at === x) {
        errors.push(`item ${x.name}: its parent chain comes back to itself`)
        break
      }
    }
  }
  return errors
}

// The tool result for an update that failed: the pane keeps the last good view.
export const refusalOf = (errors: string[]): string =>
  `The pane kept the last good view and wrote nothing. Fix and send again: ${errors.join('; ')}.`

// Patch operations on the agent's items, applied in order (checkUpdate has passed them).
export function applyPatch(items: Item[], patch: unknown[]): Item[] {
  let next = [...items]
  for (const raw of patch) {
    if (!isObj(raw)) continue
    const { op, ...fields } = raw
    if (op === 'add') {
      const item = asItem(fields)
      if (item !== undefined) next.push(item)
      continue
    }
    const id = str(fields.id)
    const k = next.findIndex(x => (x.id ?? idOf(x.name)) === id)
    if (k < 0) continue
    if (op === 'remove') {
      next = next.filter((_, j) => j !== k)
      continue
    }
    const was = next[k] as Item
    // The steps as sent, so a patch of step alone still counts places in the list the agent sent.
    const sent = was.stepsSent ? { steps: was.stepsSent, step: was.stepSent } : {}
    const merged = asItem({ ...was, ...sent, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), id: was.id })
    // A promoted item stays promoted: its parent makes it again at the next read.
    if (merged !== undefined) next[k] = was.promoted === true ? { ...merged, promoted: true } : merged
  }
  return next
}

// The state the pane builds by itself when the agent sends none by the 5th tool call: a Custom type whose stages
// are the task-list steps (2 to 8 of them), or one Work stage. waitingForAgent marks it "Waiting for the agent" (the view
// renders the words).
export function autoSummary(steps: Task[], at: number, project = 'This session'): { summary: NonNullable<Summary>; steps: Task[] } {
  const byStep = steps.length >= 2 && steps.length <= 8
  const phases = byStep ? steps.map(x => cap(clip(x.name, 40))) : ['Work']
  const current = byStep ? Math.max(0, steps.findIndex(x => x.status !== 'done')) : 0
  const phase = byStep && steps.every(x => x.status === 'done') ? phases.length : current
  return {
    summary: {
      project,
      ticket: null,
      links: [],
      goalLine: null,
      stage: 'build',
      phases,
      phase,
      symptom: null,
      hypotheses: [],
      waitingOn: null,
      waitingSince: at,
      counts: [],
      items: [],
      active: [],
      template: 'custom',
      starts: phases.map((_, k) => (k === phase ? at : null)),
      ends: phases.map(() => null),
      change: null,
      at,
      version: 1,
      waitingForAgent: true,
      mayBeOutOfDate: false,
    },
    steps: byStep ? steps.map((x, k) => ({ ...x, phase: k })) : steps.map(x => ({ ...x, phase: 0 })),
  }
}

// How many steps a task-list call started: steps that are now in progress and were not before.
export function stepsStarted(before: Task[], after: Task[]): number {
  return after.filter(x => x.status === 'now' && before.find(y => y.name === x.name)?.status !== 'now').length
}
