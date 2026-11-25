import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Git, Helper, Live, Pr } from '../types'
import { nowOf } from './store'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const live = atom({ plugin: 'mission-status', key: 'live' } as const, null as Live | null, { shape: 'live' })

// The Merge card's timing. Git is read every 5 s at all times. GitHub is read every 30 s while a pull request is open;
// with no open pull request, again when the branch or its upstream moves, or after 5 minutes. After a failed read the
// wait doubles from 60 s up to 10 minutes.
export const GIT_MS = 5_000
export const GH_MS = 30_000
export const GH_IDLE_MS = 5 * 60_000
export const GH_MAX_MS = 10 * 60_000
// A session that starts a GitHub read holds it this long, so other sessions on the repository wait for its result.
const LEASE_MS = 25_000
// Shared reads of a repository nobody polled for 7 days are deleted.
const KEEP_MS = 7 * 24 * 3600_000

// The state of the GitHub read, as the Merge card shows it.
// ok: read. missing: the GitHub CLI is not installed or not signed in. failed: the last read failed (backoff runs).
// none: the repository has no GitHub remote, so there is nothing to read. idle: not read yet.
export type GhState = 'ok' | 'missing' | 'failed' | 'none' | 'idle'

// What one poller reads for a repository, shared through $.store under the repository's top folder.
export type RepoRead = {
  repo: string
  gitAt: number
  git: Git
  // The branch and its upstream commit: a change starts a GitHub read even with no open pull request.
  sig: string
  ghAt: number
  gh: GhState
  prs: Pr[]
  failures: number
  nextGhAt: number
  lease: number
}

// The Merge card's own facts, kept on the live state beside the fields the types name.
export type MergeInfo = { repo: string | null; gh: GhState; ghAt: number; nextGhAt: number; failures: number }
export type MergeLive = Live & { merge?: MergeInfo }

export const storeKey = (repo: string) => `repo:${repo}`
// 60 s after one failure, 120 s after two, and so on, never more than 10 minutes.
export const backoffMs = (failures: number) => Math.min(GH_MAX_MS, GH_MS * 2 ** Math.max(1, failures))


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

// One command; null when it exits with an error, 'missing' when it cannot start.
async function runText($: EngineInterface, argv: string[], timeoutMs = 10_000): Promise<string | null | 'missing'> {
  try {
    const r = await $.process.run(argv, { timeoutMs, env: argv[0] === 'git' ? SAFE_GIT : {} })
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return 'missing'
  }
}

// The repository's top folder, or null when git is missing or the folder is not a git repository.
export async function repoTop($: EngineInterface): Promise<string | null> {
  const top = await runText($, ['git', 'rev-parse', '--show-toplevel'])
  return top === null || top === 'missing' || top === '' ? null : top
}

function asRepoRead(v: unknown, repo: string): RepoRead | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Partial<RepoRead>
  if (o.repo !== repo || typeof o.gitAt !== 'number' || typeof o.ghAt !== 'number' || !Array.isArray(o.prs)) return null
  return {
    repo,
    gitAt: o.gitAt,
    git: (o.git ?? null) as Git,
    sig: typeof o.sig === 'string' ? o.sig : '',
    ghAt: o.ghAt,
    gh: (['ok', 'missing', 'failed', 'none', 'idle'] as const).find(x => x === o.gh) ?? 'idle',
    prs: o.prs as Pr[],
    failures: typeof o.failures === 'number' ? o.failures : 0,
    nextGhAt: typeof o.nextGhAt === 'number' ? o.nextGhAt : 0,
    lease: typeof o.lease === 'number' ? o.lease : 0,
  }
}

async function readShared($: EngineInterface, repo: string): Promise<RepoRead | null> {
  try {
    return asRepoRead(await $.store.get(storeKey(repo)), repo)
  } catch {
    return null
  }
}

async function writeShared($: EngineInterface, r: RepoRead): Promise<void> {
  try {
    await $.store.set(storeKey(r.repo), r)
  } catch {
    // A failed write costs one extra read in another session, nothing more.
  }
}

let pruned = false
// Once per load: delete the shared reads of repositories nobody polled for 7 days.
async function prune($: EngineInterface, t: number): Promise<void> {
  if (pruned) return
  pruned = true
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith('repo:')) continue
      const v = (await $.store.get(key)) as { gitAt?: unknown } | undefined
      if (typeof v?.gitAt !== 'number' || t - v.gitAt > KEEP_MS) await $.store.delete(key)
    }
  } catch {}
}

// Whether a GitHub read is due now, from the shared read.
export function ghDue(r: RepoRead, sig: string, t: number): boolean {
  if (r.lease > t) return false
  if (r.gh === 'idle') return true
  // A moved branch or upstream may have a new pull request: read at once, unless a failure backoff runs.
  if (sig !== r.sig && r.gh !== 'failed') return true
  return t >= r.nextGhAt
}

// The next GitHub read after this one.
export function nextGh(gh: GhState, prs: Pr[], failures: number, t: number): number {
  if (gh === 'failed') return t + backoffMs(failures)
  if (gh === 'missing' || gh === 'none') return t + GH_MAX_MS
  return t + (prs.some(p => p.state === 'OPEN') ? GH_MS : GH_IDLE_MS)
}

// One GitHub read of the pull requests for a branch.
export async function readGh($: EngineInterface, branch: string): Promise<{ gh: GhState; prs: Pr[] }> {
  const remotes = await runText($, ['git', 'remote'])
  if (remotes === null || remotes === 'missing' || remotes === '') return { gh: 'none', prs: [] }
  let out
  try {
    out = await $.process.run(
      ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url,title,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup'],
      { timeoutMs: 20_000 },
    )
  } catch {
    // The GitHub CLI cannot start: it is not installed.
    return { gh: 'missing', prs: [] }
  }
  if (out.exitCode === 0) {
    try {
      return { gh: 'ok', prs: (JSON.parse(out.stdout) as Record<string, unknown>[]).map(asPr) }
    } catch {
      return { gh: 'failed', prs: [] }
    }
  }
  const err = out.stderr
  // gh exits 4 when it needs a sign-in.
  if (out.exitCode === 4 || /gh auth login|not logged in|authenticat/i.test(err)) return { gh: 'missing', prs: [] }
  if (/known GitHub host|no git remotes|none of the git remotes/i.test(err)) return { gh: 'none', prs: [] }
  return { gh: 'failed', prs: [] }
}

// One poll, every 5 s from register.tsx; this file keeps the Merge card's own timing.
export async function poll($: EngineInterface): Promise<void> {
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
  const t = await nowOf($)
  const merge = await pollRepo($, t).catch(() => null)
  const before = await read($, live).catch(() => null)
  try {
    await update($, live, () => {
      const next: MergeLive =
        merge === null
          ? // The read itself broke: keep the last good facts and say the read failed.
            {
              helpers,
              prs: before?.prs ?? [],
              prsUnread: true,
              at: t,
              reads: (before?.reads ?? 0) + 1,
              git: before?.git ?? null,
              merge: { ...((before as MergeLive | null)?.merge ?? { repo: null, ghAt: 0, nextGhAt: 0, failures: 0 }), gh: 'failed' },
            }
          : {
              helpers,
              prs: merge.prs,
              prsUnread: merge.gh === 'failed',
              at: t,
              reads: (before?.reads ?? 0) + 1,
              git: merge.git,
              merge: { repo: merge.repo, gh: merge.gh, ghAt: merge.ghAt, nextGhAt: merge.nextGhAt, failures: merge.failures },
            }
      return next as Live
    })
  } catch {
    // The session or the reload ended while the read ran: the next tick writes again.
  }
}

// The repository's facts: from the shared read when it is fresh, else read here and shared.
// With no repository (git missing, or not a git folder) the card has nothing to show.
export async function pollRepo(
  $: EngineInterface,
  t: number,
): Promise<{ repo: string | null; git: Git; prs: Pr[]; gh: GhState; ghAt: number; nextGhAt: number; failures: number }> {
  const repo = await repoTop($)
  if (repo === null) return { repo: null, git: null, prs: [], gh: 'idle', ghAt: 0, nextGhAt: 0, failures: 0 }
  void prune($, t)
  const shared = await readShared($, repo)
  let r: RepoRead = shared ?? { repo, gitAt: 0, git: null, sig: '', ghAt: 0, gh: 'idle', prs: [], failures: 0, nextGhAt: 0, lease: 0 }
  let changed = false
  // Git: the shared read serves while it is younger than one poll.
  if (shared === null || t - shared.gitAt >= GIT_MS) {
    r = { ...r, git: await readGit($).catch(() => r.git), gitAt: t }
    changed = true
  }
  const branch = r.git?.branch ?? ''
  if (branch !== '') {
    const up = await runText($, ['git', 'rev-parse', '@{u}'])
    const sig = `${branch}@${typeof up === 'string' ? up : ''}`
    if (ghDue(r, sig, t)) {
      // Take the lease first, so a session that polls meanwhile uses this read and does not start its own.
      await writeShared($, { ...r, lease: t + LEASE_MS })
      const got = await readGh($, branch)
      const failures = got.gh === 'failed' ? r.failures + 1 : 0
      r = {
        ...r,
        sig,
        gh: got.gh,
        // A failed read keeps the last good pull requests.
        prs: got.gh === 'failed' ? r.prs : got.prs,
        ghAt: t,
        failures,
        nextGhAt: nextGh(got.gh, got.gh === 'failed' ? r.prs : got.prs, failures, t),
        lease: 0,
      }
      changed = true
    }
  }
  if (changed) await writeShared($, r)
  return { repo, git: r.git, prs: r.prs, gh: r.gh, ghAt: r.ghAt, nextGhAt: r.nextGhAt, failures: r.failures }
}

let defaultBranch: string | null = null

// The branch against main: commits ahead, files and lines changed, and files not yet committed.
export async function readGit($: EngineInterface): Promise<Git> {
  const run = async (argv: string[]) => {
    const r = await runText($, argv)
    return r === 'missing' ? null : r
  }
  let branch = await run(['git', 'branch', '--show-current'])
  if (branch === null) return null
  // A detached head names its commit.
  if (branch === '') {
    const sha = await run(['git', 'rev-parse', '--short', 'HEAD'])
    if (sha === null || sha === '') return null
    branch = `detached at ${sha}`
  }
  // The default branch: the remote's HEAD, else main or master, on the remote first. Found once per module load: the
  // poll runs every 5 s and the answer does not change in a session.
  if (defaultBranch === null) {
    const head = await run(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    defaultBranch = head !== null && head !== '' ? head : 'main'
    if (head === null || head === '')
      for (const c of ['origin/main', 'origin/master', 'main', 'master'])
        if (await run(['git', 'rev-parse', '--verify', '--quiet', c])) {
          defaultBranch = c
          break
        }
  }
  const main = defaultBranch
  const base = await run(['git', 'merge-base', 'HEAD', main])
  const ahead = base === null ? 0 : Number((await run(['git', 'rev-list', '--count', `${base}..HEAD`])) ?? 0)
  const behind = Number((await run(['git', 'rev-list', '--count', `HEAD..${main}`])) ?? 0)
  const stat = base === null ? '' : ((await run(['git', 'diff', '--shortstat', '--no-ext-diff', '--no-textconv', base])) ?? '')
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
