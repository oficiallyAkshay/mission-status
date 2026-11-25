import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const live = atom({ plugin: 'progress-pane', key: 'live' } as const, null as Live | null, { shape: 'live' })

export async function poll($: EngineInterface, withPrs = true): Promise<void> {
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
  const before = await read($, live).catch(() => null)
  let prs: Pr[] = before?.prs ?? []
  let prsUnread = before?.prsUnread ?? false
  if (withPrs) try {
    prs = []
    prsUnread = false
    const branch = await $.process.run(['git', 'branch', '--show-current'])
    const head = branch.stdout.trim()
    if (branch.exitCode === 0 && head !== '') {
      const out = await $.process.run(
        ['gh', 'pr', 'list', '--head', head, '--state', 'all', '--json', 'number,state,url,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup'],
        { timeoutMs: 20_000 },
      )
      if (out.exitCode === 0) prs = (JSON.parse(out.stdout) as Record<string, unknown>[]).map(asPr)
      else prsUnread = true
    }
  } catch {
    prsUnread = true
  }
  let git: Git = before?.git ?? null
  if (withPrs) git = await readGit($).catch(() => null)
  try {
    await update($, live, () => ({ helpers, prs, prsUnread, at: Date.now(), reads: (before?.reads ?? 0) + 1, git }))
  } catch {
    // The session or the reload ended while the read ran: the next tick writes again.
  }
}

// The branch against main: commits ahead, files and lines changed, and files not yet committed.
export async function readGit($: EngineInterface): Promise<Git> {
  const run = async (argv: string[]) => {
    const r = await $.process.run(argv, { timeoutMs: 10_000 })
    return r.exitCode === 0 ? r.stdout.trim() : null
  }
  const branch = await run(['git', 'branch', '--show-current'])
  if (branch === null || branch === '') return null
  const base = (await run(['git', 'merge-base', 'HEAD', 'origin/main'])) ?? (await run(['git', 'merge-base', 'HEAD', 'main']))
  const ahead = base === null ? 0 : Number((await run(['git', 'rev-list', '--count', `${base}..HEAD`])) ?? 0)
  const behind = Number((await run(['git', 'rev-list', '--count', 'HEAD..origin/main'])) ?? 0)
  const stat = base === null ? '' : ((await run(['git', 'diff', '--shortstat', base])) ?? '')
  const pick = (re: RegExp) => Number(stat.match(re)?.[1] ?? 0)
  const dirty = ((await run(['git', 'status', '--porcelain'])) ?? '').split('\n').filter(Boolean).length
  return { branch, ahead, behind, files: pick(/(\d+) files? changed/), added: pick(/(\d+) insertions?/), removed: pick(/(\d+) deletions?/), dirty }
}

// One pull request with its CI state folded to one word: passing, failing, running, or none.
export function asPr(o: Record<string, unknown>): Pr {
  const checks = Array.isArray(o.statusCheckRollup) ? (o.statusCheckRollup as Record<string, unknown>[]) : []
  const word = (c: Record<string, unknown>) => String(c.conclusion ?? c.state ?? c.status ?? '').toUpperCase()
  const ci =
    checks.length === 0
      ? 'none'
      : checks.some(c => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(word(c)))
        ? 'failing'
        : checks.some(c => ['', 'PENDING', 'QUEUED', 'IN_PROGRESS', 'EXPECTED'].includes(word(c)))
          ? 'running'
          : 'passing'
  return {
    number: Number(o.number ?? 0),
    state: String(o.state ?? ''),
    url: String(o.url ?? ''),
    title: String(o.title ?? ''),
    isDraft: o.isDraft === true,
    review: String(o.reviewDecision ?? ''),
    merge: String(o.mergeStateStatus ?? ''),
    ci,
  }
}

// The facts of a pull request and its branch, as short words with the colour of their state.
export function prFacts(pr: Pr | undefined, g: Git): { text: string; tone: 'success' | 'error' | 'warning' | 'dim' }[] {
  const out: { text: string; tone: 'success' | 'error' | 'warning' | 'dim' }[] = []
  if (pr !== undefined) {
    out.push(
      pr.state === 'MERGED'
        ? { text: 'Merged', tone: 'success' }
        : pr.state === 'CLOSED'
          ? { text: 'Closed', tone: 'error' }
          : pr.isDraft === true
            ? { text: 'Draft', tone: 'dim' }
            : { text: 'Open', tone: 'dim' },
    )
    if (pr.state === 'OPEN') {
      if (pr.ci === 'passing') out.push({ text: 'CI passing', tone: 'success' })
      if (pr.ci === 'failing') out.push({ text: 'CI failing', tone: 'error' })
      if (pr.ci === 'running') out.push({ text: 'CI running', tone: 'warning' })
      if (pr.review === 'APPROVED') out.push({ text: 'Approved', tone: 'success' })
      if (pr.review === 'CHANGES_REQUESTED') out.push({ text: 'Changes requested', tone: 'error' })
      if (pr.review === 'REVIEW_REQUIRED') out.push({ text: 'Review needed', tone: 'warning' })
      if (pr.merge === 'DIRTY') out.push({ text: 'Conflicts', tone: 'error' })
    }
  }
  if (g !== null) {
    if ((g.behind ?? 0) > 0) out.push({ text: `${g.behind} behind main`, tone: 'warning' })
    if (g.added + g.removed > 0) out.push({ text: `+${g.added} −${g.removed}`, tone: 'dim' })
    if (g.dirty > 0) out.push({ text: `${g.dirty} not committed`, tone: 'warning' })
  }
  return out
}

