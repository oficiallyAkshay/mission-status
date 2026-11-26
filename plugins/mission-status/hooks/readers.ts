import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Helper, ItemCi, Live, PrRecord, Summary } from '../types'
import { nowOf } from './store'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const live = atom({ plugin: 'mission-status', key: 'live' } as const, null as Live | null, { shape: 'live' })

// Each pull request is read at most once a minute, whether the pane shows or not; a merged or closed one is not read
// again. A rate-limited reply stops every GitHub read for a while:
// 60 s after one, 120 s after two, and so on, up to 10 minutes.
export const PR_MS = 60_000
export const GH_MAX_MS = 10 * 60_000
// The pane counts as open when it was drawn within this long.
export const PANE_OPEN_MS = 30_000

// A session with no open turn and nothing seen for this long, and no CI running, is idle: its tick reads no GitHub. The next turn's tick reads again.
export const IDLE_MS = 10 * 60_000

// The backoff keeps its own 30 s base: one rate-limited reply waits 60 s, then 120 s, never more than 10 minutes.
const BACKOFF_BASE_MS = 30_000
export const backoffMs = (failures: number) => Math.min(GH_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(1, failures))

// git runs in any folder the session opens: a repository's own config must not start a program (fsmonitor, an
// external diff or a text conversion), and a read takes no optional lock.
const SAFE_GIT: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'diff.external',
  GIT_CONFIG_VALUE_1: '',
  GIT_CONFIG_KEY_2: 'core.hooksPath',
  GIT_CONFIG_VALUE_2: '/dev/null',
}

// The folder the PR reads run in: the repository the agent named for the work, else the session's own folder.
let repoDir: string | null = null
const prRefsAtom = atom({ plugin: 'mission-status', key: 'prRefs' } as const, [] as string[])
// The branches this session's own tool inputs name (git push, git checkout -b and the like); register.tsx keeps them.
const prBranchesAtom = atom({ plugin: 'mission-status', key: 'prBranches' } as const, [] as string[])
const summaryAtom = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
// A headless run (claude -p, an SDK host, a helper job): no person sees a pane (metrics.tsx writes it at session start).
const headless = atom({ plugin: 'mission-status', key: 'headless' } as const, false as boolean)
const turnOpenAtom = atom({ plugin: 'mission-status', key: 'turnOpen' } as const, false as boolean)
const seenAtAtom = atom({ plugin: 'mission-status', key: 'seenAt' } as const, 0)

// Idle: no turn is open, something was seen but not within IDLE_MS, and no pull request's CI runs. A session that has
// seen nothing yet is new, not idle.
async function idleAt($: EngineInterface, t: number): Promise<boolean> {
  if ((await read($, turnOpenAtom).catch(() => true)) !== false) return false
  const seen = (await read($, seenAtAtom).catch(() => 0)) ?? 0
  if (seen === 0 || t - seen <= IDLE_MS) return false
  const recs = (await read($, live).catch(() => null))?.prRecords ?? {}
  return !Object.values(recs).some(r => r.ci === 'running' && !prFinal(r))
}

// One command; null when it exits with an error, 'missing' when it cannot start.
async function runText($: EngineInterface, argv: string[], timeoutMs = 10_000): Promise<string | null | 'missing'> {
  try {
    const r = await $.process.run(argv, { timeoutMs, env: argv[0] === 'git' ? SAFE_GIT : {}, ...(repoDir === null ? {} : { cwd: repoDir }) })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return 'missing'
  }
}

// One gh command: its output, or why it failed. limited: GitHub refused for its rate limit.
async function runGh($: EngineInterface, argv: string[]): Promise<{ out: string } | { fail: 'limited' | 'missing' | 'failed' }> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 20_000, ...(repoDir === null ? {} : { cwd: repoDir }) })
    if (r.exitCode === 0) return { out: r.stdout.trim() }
    return { fail: /rate limit|HTTP 429/i.test(`${r.stderr}\n${r.stdout}`) ? 'limited' : 'failed' }
  } catch {
    // The GitHub CLI cannot start: it is not installed.
    return { fail: 'missing' }
  }
}

// The folder the agent named for the work, from the stored summary.
async function syncRepo($: EngineInterface): Promise<Summary> {
  const sum = await read($, summaryAtom).catch(() => null)
  const named = (sum as { repo?: string | null } | null)?.repo ?? null
  // A new folder has its own pull requests: its list is read at once.
  if (named !== repoDir) {
    repoDir = named
    slugRead = false
    listAt = 0
  }
  return sum
}

// The CI of a pull request no item names any more is dropped.
export const ciNamed = (ci: Record<string, ItemCi>, refs: string[]): Record<string, ItemCi> => Object.fromEntries(Object.entries(ci).filter(([ref]) => refs.includes(ref)))

// The one read of a pull request: every field the item chip, the PRs tab and the Deploy count use.
const PR_FIELDS = 'number,title,url,state,isDraft,mergeStateStatus,statusCheckRollup,mergedAt,headRefName,body,commits'

// One pull request's record from its gh reply: merged, closed, a conflict, a draft, or open.
export function prRecordOf(ref: string, o: Record<string, unknown>, at: number): PrRecord {
  const state = String(o.state ?? '').toUpperCase()
  const merged = typeof o.mergedAt === 'string' ? Date.parse(o.mergedAt) : NaN
  const c = ciOf(Array.isArray(o.statusCheckRollup) ? (o.statusCheckRollup as Record<string, unknown>[]) : [])
  return {
    ref,
    number: Number(o.number ?? ref.split('#').pop() ?? 0),
    title: String(o.title ?? ''),
    url: String(o.url ?? ''),
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : String(o.mergeStateStatus ?? '').toUpperCase() === 'DIRTY' ? 'conflict' : o.isDraft === true ? 'draft' : 'open',
    ci: c.state,
    ciStart: c.start,
    ciEnd: c.end,
    branch: typeof o.headRefName === 'string' ? o.headRefName : null,
    mergedAt: Number.isFinite(merged) ? merged : null,
    at,
    summary: summaryOf(typeof o.body === 'string' ? o.body : ''),
    // The key of the title and description the generated summary is made from: a new key means a new summary.
    summaryKey: keyOf(`${String(o.title ?? '')}\n${typeof o.body === 'string' ? o.body : ''}`),
    v: REC_V,
    // The newest 10 commits, newest first, and each check by name with its state, for the card's tabs.
    commits: (Array.isArray(o.commits) ? (o.commits as Record<string, unknown>[]) : [])
      .map(x => ({ sha: String(x.oid ?? '').slice(0, 7), title: String(x.messageHeadline ?? '') }))
      .reverse()
      .slice(0, 10),
    checks: (Array.isArray(o.statusCheckRollup) ? (o.statusCheckRollup as Record<string, unknown>[]) : []).map(x => ({
      name: String(x.name ?? x.context ?? 'check'),
      state: ciOf([x]).state,
    })),
  }
}

// A short key of a text, so a summary is made again only when the title or the description changes.
export function keyOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// The summary until Haiku's is ready, and where the marker is off: the description's first two sentences, as plain
// text. A sentence ends at . ! or ? followed by a space and a capital letter or the end, so "0.12.0" or "machine.ts"
// never cut one. Headings, lists, links, code and the attribution line go.
export function summaryOf(body: string): string {
  const text = body
    .split('\n')
    .filter(l => !/^\s*(#|```|\||>|🤖|Co-Authored-By)/i.test(l) && !/Generated with \[?Claude Code/i.test(l))
    .map(l => l.replace(/^\s*([-*+]|\d+\.)\s+/, ''))
    .join(' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = text.match(/.+?[.!?](?=\s+[A-Z(“"]|\s*$)/g) ?? (text === '' ? [] : [text])
  const two = sentences.slice(0, 2).join('').trim()
  return two.length > 280 ? `${two.slice(0, 279)}…` : two
}
// What the item chip shows of a record.
export const itemCiOf = (r: PrRecord): ItemCi => ({ state: r.ci, start: r.ciStart ?? null, end: r.ciEnd ?? null, mergedAt: r.mergedAt, pr: r.state, url: r.url === '' ? null : r.url })
// A merged or closed pull request does not change again: it is not read again.
// The record's shape version: a record from an older version is read once more, even when merged or closed, so it gains
// the fields added since (summary, commits, checks).
export const REC_V = 2
export const prFinal = (r: PrRecord | undefined) => r !== undefined && (r.v ?? 0) >= REC_V && (r.state === 'merged' || r.state === 'closed' || r.mergedAt !== null)

// The CI of one pull request: running while any check runs, else failing or passing, with the first start and the
// last finish of its checks.
export function ciOf(rollup: Record<string, unknown>[]): ItemCi {
  if (rollup.length === 0) return { state: 'none', start: null, end: null }
  const word = (c: Record<string, unknown>) => String(c.conclusion ?? c.state ?? c.status ?? '').toUpperCase()
  const time = (v: unknown) => (typeof v === 'string' && !v.startsWith('0001') ? Date.parse(v) : NaN)
  const starts = rollup.map(c => time(c.startedAt)).filter(Number.isFinite)
  const ends = rollup.map(c => time(c.completedAt)).filter(Number.isFinite)
  const running = rollup.some(c => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(word(c)))
  const failing = rollup.some(c => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(word(c)))
  return {
    state: running ? 'running' : failing ? 'failing' : 'passing',
    start: starts.length > 0 ? Math.min(...starts) : null,
    end: running || ends.length === 0 ? null : Math.max(...ends),
  }
}

// owner/name of the work's repository, from its origin remote (no gh call); null when it is not on GitHub.
let slugOf: string | null = null
let slugRead = false
async function repoSlug($: EngineInterface): Promise<string | null> {
  if (slugRead) return slugOf
  const url = await runText($, ['git', 'remote', 'get-url', 'origin'])
  slugRead = true
  slugOf = (typeof url === 'string' ? /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url) : null)?.[1] ?? null
  return slugOf
}

// The PR reads' own timing: the last try of each pull request, the last list, and the rate-limit backoff.
const tried = new Map<string, number>()
let listAt = 0
let holdUntil = 0
let limits = 0
let prBusy = false
let prAgain = false
// The next time a PR read or the list falls due; a tick before it reads nothing.
let prNextAt = 0

// The pull requests this session made, from its own tool inputs: gh pr list in the session's repository, kept only
// when the head branch is the current branch or one the session's inputs named.
async function listMine($: EngineInterface): Promise<{ refs: string[]; fail?: 'limited' | 'missing' | 'failed' }> {
  const current = await runText($, ['git', 'branch', '--show-current'])
  const branches = new Set([...(await read($, prBranchesAtom).catch(() => [] as string[])), ...(typeof current === 'string' && current !== '' ? [current] : [])])
  if (branches.size === 0) return { refs: [] }
  const got = await runGh($, ['gh', 'pr', 'list', '--author', '@me', '--state', 'all', '--limit', '30', '--json', 'number,url,headRefName'])
  if ('fail' in got) return { refs: [], fail: got.fail }
  try {
    const list = JSON.parse(got.out) as { url?: unknown; headRefName?: unknown }[]
    return {
      refs: list
        .filter(p => typeof p.headRefName === 'string' && branches.has(p.headRefName))
        .map(p => /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(String(p.url ?? '')))
        .filter((m): m is RegExpExecArray => m !== null)
        .map(m => `${m[1]}#${m[2]}`),
    }
  } catch {
    return { refs: [] }
  }
}

// One pass of the PR reads, apart from the helpers poll: every pull request due is read at once, in parallel.
// No gh call at all in a headless session. A failed read keeps the last record.
// force: a new pull request or an agent update came; the pass runs now, and still reads each one at most once a minute.
export async function pollPrs($: EngineInterface, force = false): Promise<void> {
  if (prBusy) {
    if (force) prAgain = true
    return
  }
  prBusy = true
  try {
    let forced = force
    do {
      prAgain = false
      await prsOnce($, forced)
      forced = true
    } while (prAgain)
  } catch {
    // A pass that broke leaves the records as they were; the next tick reads again.
  } finally {
    prBusy = false
  }
}

async function prsOnce($: EngineInterface, force: boolean): Promise<void> {
  const t = await nowOf($)
  if (!force && (t < prNextAt || (await idleAt($, t)))) return
  prNextAt = t + PR_MS
  if (await read($, headless).catch(() => true)) return
  const sum = await syncRepo($)
  const limited = t < holdUntil
  let made = await read($, prRefsAtom).catch(() => [] as string[])
  let fails: ('limited' | 'missing' | 'failed')[] = []
  if (!limited && t - listAt >= PR_MS) {
    listAt = t
    const mine = await listMine($)
    if (mine.fail !== undefined) fails.push(mine.fail)
    const added = mine.refs.filter(r => !made.includes(r))
    if (added.length > 0) {
      await update($, prRefsAtom, list => [...list, ...added.filter(r => !list.includes(r))].slice(-30))
      made = [...made, ...added]
    }
  }
  made = made.slice(-20)
  const itemRefs = [...new Set(((sum as { items?: { pr?: string | null }[] } | null)?.items ?? []).map(i => i.pr ?? null).filter((x): x is string => x !== null))].slice(0, 20)
  const slug = itemRefs.some(r => !r.includes('#')) ? await repoSlug($) : null
  // The record key: owner/name#number; a bare number belongs to the work's repository.
  const keyOf = (ref: string) => (ref.includes('#') || slug === null ? ref : `${slug}#${ref}`)
  const keys = [...new Set([...made, ...itemRefs.map(keyOf)])]
  const prev = await read($, live).catch(() => null)
  const before = prev?.prRecords ?? {}
  const due = limited ? [] : keys.filter(k => !prFinal(before[k]) && t - (tried.get(k) ?? -Infinity) >= PR_MS)
  for (const k of due) tried.set(k, t)
  const got = await Promise.all(
    due.map(async k => {
      const [repo, num] = k.includes('#') ? k.split('#') : [null, k]
      const r = await runGh($, ['gh', 'pr', 'view', String(num), ...(repo ? ['-R', repo] : []), '--json', PR_FIELDS])
      if ('fail' in r) return { k, fail: r.fail }
      try {
        const o = JSON.parse(r.out) as Record<string, unknown>
        // The description, cut short, stays in this pass: only the summary made from it is stored.
        return { k, rec: prRecordOf(k, o, t), body: (typeof o.body === 'string' ? o.body : '').slice(0, 4000) }
      } catch {
        return { k, fail: 'failed' as const }
      }
    }),
  )
  fails = [...fails, ...got.flatMap(g => ('fail' in g && g.fail !== undefined ? [g.fail] : []))]
  if (fails.includes('limited') || fails.includes('missing')) {
    // Rate limited, or no GitHub CLI: stop reading for a while and keep the last records.
    limits = fails.includes('limited') ? limits + 1 : limits
    holdUntil = t + (fails.includes('limited') ? backoffMs(limits) : GH_MAX_MS)
  } else limits = 0
  const recs: Record<string, PrRecord> = { ...before }
  const bodies = new Map<string, string>()
  for (const g of got)
    if ('rec' in g && g.rec !== undefined) {
      recs[g.k] = g.rec
      bodies.set(g.k, g.body)
    }
  // Each card's two-sentence summary, written by Haiku inside Claude Code from the title and the description: once per
  // pull request, and again only when either changes. Until then, and where traffic is off, the first two sentences.
  // In parallel, and each text tried once per load, so a failing call never repeats every minute.
  await Promise.all(
    keys.map(async k => {
      const rec = recs[k]
      const old = before[k]
      if (rec === undefined) return
      if (old?.summaryKey === rec.summaryKey && old?.summaryBy === 'model' && old.summary) {
        recs[k] = { ...rec, summary: old.summary, summaryBy: 'model' }
        return
      }
      const body = bodies.get(k)
      const tag = `${k}:${rec.summaryKey ?? ''}`
      if (body === undefined || summaryTried.has(tag)) return
      summaryTried.add(tag)
      const made = await summarize($, rec.title, body)
      if (made !== null) recs[k] = { ...rec, summary: made, summaryBy: 'model' }
    }),
  )
  const kept = Object.fromEntries(keys.filter(k => recs[k] !== undefined).map(k => [k, recs[k] as PrRecord]))
  // The next pass: when the list or a pull request not yet merged or closed is due, and not inside a backoff.
  prNextAt = Math.max(holdUntil, Math.min(listAt + PR_MS, ...keys.filter(k => !prFinal(kept[k])).map(k => (tried.get(k) ?? t) + PR_MS)))
  const ci = Object.fromEntries(itemRefs.filter(r => kept[keyOf(r)] !== undefined).map(r => [r, itemCiOf(kept[keyOf(r)] as PrRecord)]))
  // The PRs tab and the Deploy count read the session's pull requests from these records, in the order of prRefs.
  // Unread: any GitHub read of this pass failed (auth, permission, rate limit, no gh) or a backoff holds the reads.
  // prsReadAt: the last pass that read GitHub with no failure, so the view can say since when it is not read.
  const unread = t < holdUntil || fails.length > 0
  const readOk = !unread && (due.length > 0 || listAt === t)
  const fields = { prRecords: kept, ci, prsUnread: unread, prsReadAt: readOk ? t : (prev?.prsReadAt ?? null) }
  // Nothing new: no write, so the pane does not draw again for nothing.
  if ((Object.keys(fields) as (keyof typeof fields)[]).every(f => JSON.stringify(prev?.[f]) === JSON.stringify(fields[f]))) return
  try {
    await update($, live, now => ({ ...(now ?? { helpers: [] }), ...fields }) as Live)
  } catch {
    // The session or the reload ended while the read ran: the next tick writes again.
  }
}

// One summary from Haiku; null when traffic is off, in a headless session, or when the call fails (the card then keeps
// the description's first sentences). A short call: 30 s at most, a small reply.
const summaryTried = new Set<string>()
async function summarize($: EngineInterface, title: string, body: string): Promise<string | null> {
  try {
    if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) return null
    if (await read($, headless)) return null
    const r = await $.model.complete({
      model: 'haiku',
      system: 'You summarize a GitHub pull request for a progress pane. Answer with exactly two short plain sentences, present tense, no markdown, no lists, no file names unless essential: what the change does for the person who uses it, then the most important detail.',
      prompt: `Title: ${title}\n\nDescription:\n${body}`,
      maxTokens: 160,
      effort: 'low',
      timeoutMs: 30_000,
    })
    const text = (r as { text?: unknown }).text
    return typeof text === 'string' && text.trim() !== '' ? text.trim().replace(/\s+/g, ' ').slice(0, 320) : null
  } catch {
    return null
  }
}

// The pane's last draw or opening.
// A flag the Pane render and each ui.open set, the least machinery that needs no event for a closed pane.
let paneAt = 0
// The pane was drawn or opened. After a closed spell a draw starts a read, so the helpers are fresh soon.
export async function paneSeen($: EngineInterface, drawn = false): Promise<void> {
  const t = await nowOf($)
  const cold = t - paneAt > PANE_OPEN_MS
  paneAt = t
  if (cold && drawn) void poll($, true)
}

// The poll running now, if one runs, and whether a forced poll arrived during it.
let current: Promise<void> | null = null
let pollAgain = false

// One poll, every 5 s from register.tsx: the helpers, and a pass of the PR reads, which
// runs apart from it.
// force: an agent update just came. One poll runs at a time; a forced poll that arrives meanwhile makes one more run
// after it. The answer settles when the runs are done.
export function poll($: EngineInterface, force = false): Promise<void> {
  void pollPrs($, force)
  if (current !== null) {
    if (force) pollAgain = true
    return current
  }
  current = (async () => {
    try {
      do {
        pollAgain = false
        await pollOnce($)
      } while (pollAgain)
    } catch {
      // A poll that broke leaves the card as it was; the next tick reads again.
    } finally {
      current = null
    }
  })()
  return current
}

async function pollOnce($: EngineInterface): Promise<void> {
  let helpers: Helper[] = []
  try {
    helpers = (await $.agent.list()).map(a => ({
      id: a.id,
      description: a.description,
      status: String(a.taskStatus ?? a.status),
      model: a.model ?? null,
      startTime: a.startTime,
    }))
  } catch {}
  // The same helpers as stored: no write, so an idle pane does not draw again every tick.
  const prev = await read($, live).catch(() => null)
  if (prev != null && JSON.stringify(prev.helpers) === JSON.stringify(helpers)) return
  try {
    // Built from the value in the store when the write runs, so the PR reads' fields are kept.
    await update($, live, before => ({ ...(before ?? { prsUnread: false }), helpers }) as Live)
  } catch {
    // The session or the reload ended while the read ran: the next tick writes again.
  }
}
