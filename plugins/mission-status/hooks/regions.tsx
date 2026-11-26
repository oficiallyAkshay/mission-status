import { atom, update } from 'claude-code'
import type { EngineInterface, RenderChildren } from 'claude-code'
import type { Count, HypothesisState, Helper, Item, PrRecord, Runbook, RunbookStep } from '../types'
import { type WatchRow, spark, trendWord } from './watches'
import { stepsRailSvg, prIconSvg, badgeSvg, exitSvg, flowLineSvg, waitsLineSvg } from './bars'
import { age, cap } from './model'
import type { deriveNow } from './store'
import { type NodeStatus, stageKey } from './machine'
import { updateText } from './update-line'
import { setAutoUpdate, updateNow } from './update'
import { blocks, durationOf, INDENT, SUBTEXT, ACCENT_TEXT } from './blocks'

// The regions of the pane, each drawn from the state renderPane (view.tsx) gathers.

// The open tab inside each pull request card, by its reference (the same storage as store.ts).
const prTabAtom = atom({ plugin: 'mission-status', key: 'prTab' } as const, {} as Record<string, string>)

// Only web addresses open as links; a file:, javascript: or app-scheme address shows as text.
export const isWebUrl = (href: string) => /^https?:\/\/[^\s]+$/i.test(href)

// The header's age of the last update: seconds, then minutes, then hours.
export function agoOf(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

// With no update from the agent for this long, the header shows the age in amber.
export const STALE_MS = 15 * 60_000

type Ui = ReturnType<EngineInterface['ui']['resolve']>
type Derived = NonNullable<Awaited<ReturnType<typeof deriveNow>>>

// The parts of the pane a region draws with, from renderPane.
export type Region = {
  Box: Ui['Box']
  Text: Ui['Text']
  Link: Ui['Link']
  Button: Ui['Button']
  B: ReturnType<typeof blocks>
  svg: (source: string, alt: string, height: number, key?: string, isInteractive?: boolean, width?: number) => RenderChildren
  hasSvg: boolean
  linkRow: (links: { label: string; href: string }[], key: string) => RenderChildren
  tabRow: RenderChildren
}

// What the header shows: the title, the ticket, the goal and the notices.
export type HeaderState = {
  s: Derived['s']
  turnOpen: boolean
  // The later of the agent's last update and the start of the running turn: stale time counts from here.
  staleFrom: number
  t: number
  seen: number
  clock: number
  upd: { phase: string; version: string | null; failures: number; at: number } | null
  auto: boolean | null
  isDone: boolean
  readFailed: boolean
  askUpdate: () => void
}

// The header: the title; the goal below.
export function header($: EngineInterface, r: Region, h0: HeaderState) {
  const { Box, Text, Link, Button } = r
  const { s, turnOpen, staleFrom, t, seen, clock, upd, auto, isDone, readFailed, askUpdate } = h0
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Text size="heading" weight="semibold" wrap="wrap">{s.project}</Text>
        </Box>
        {/* How old the agent's last update is; it goes back to 0s with each update. */}
        <Box flexShrink={0}>
          {/* One state in one place: out of date (the agent ignored two reminders) wins over Live, so the header never
              says Live and out of date at once; else Live while a turn runs; else how long ago the session last did
              anything the pane saw. */}
          {s.mayBeOutOfDate === true ? (
            <Text color="warning">May be out of date</Text>
          ) : turnOpen ? (
            <Text color={ACCENT_TEXT}>Live</Text>
          ) : (
            <Text color={SUBTEXT}>{agoOf(t - Math.max(seen, s.at))}</Text>
          )}
        </Box>
      </Box>
      {s.ticket !== null && (
        <Text>
          {s.ticket.url !== null && isWebUrl(s.ticket.url) ? <Link href={s.ticket.url}>{s.ticket.ref}</Link> : s.ticket.ref}
          {s.ticket.title !== null ? <Text dimColor>{`  ${s.ticket.title}`}</Text> : null}
        </Text>
      )}
      {s.goalLine !== null && <Text color={SUBTEXT}>{s.goalLine}</Text>}
      {/* Two notices, each only when it applies: the agent has not updated after two reminders; an update ran or failed. */}
      {s.waitingForAgent === true && <Text color={SUBTEXT}>Waiting for the agent</Text>}
      {(() => {
        const line = updateText((upd ?? null) as never, clock)
        return line === null ? null : <Text color={SUBTEXT}>{line}</Text>
      })()}
      {/* Auto-update off (a choice in the onboarding): a release that waits installs on a press, and one press turns
          auto-update back on. */}
      {(auto === false || upd?.phase === 'available') && (
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          {auto === false && <Text color={SUBTEXT}>Auto-update is off.</Text>}
          {upd?.phase === 'available' && <Button key="update-now" label="Update now" onPress={() => void updateNow($)} />}
          {auto === false && <Button key="auto-on" label="Turn on auto-update" onPress={() => void setAutoUpdate($, true)} />}
        </Box>
      )}
      {/* No line when all is done: the folded cards already say it. Stale means the agent worked STALE_MS with no
          update: only while a turn runs, counted from the later of its last update and the turn's start. Between turns
          the agent is idle and the time is the person's, so the state is not stale then. */}
      {!isDone && turnOpen && clock - staleFrom >= STALE_MS && (
        <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
          <Text color="warning" wrap="wrap">{`No update from the agent for ${age(staleFrom, clock)} of work.`}</Text>
          <Button key="update-stale" label="Update" onPress={askUpdate} />
        </Box>
      )}
      {readFailed && <Text color="error" wrap="wrap">The pane could not read part of its stored state. It shows the last good view.</Text>}
    </Box>
  )
}

// What the PRs tab shows: the session's pull requests and how fresh GitHub's read is.
export type PrsState = {
  sessionPrs: PrRecord[]
  prTabs: Record<string, string>
  prsStale: boolean
  prsReadAt: number | null
  clock: number
  nowOrRead: () => number
  isOpenKey: (key: string) => boolean
  toggleKey: (key: string) => Promise<unknown>
}

// The PRs tab: every pull request this session made, newest first, as a card that opens to its facts. The tab
// names the view, so no heading repeats it.
export function prsTab($: EngineInterface, r: Region, p0: PrsState) {
  const { Box, Text, Link, B, svg, tabRow } = r
  const { sessionPrs, prTabs, prsStale, prsReadAt, clock, nowOrRead, isOpenKey, toggleKey } = p0
  const word = { merged: 'Merged', open: 'Open', draft: 'Draft', conflict: 'Conflict', closed: 'Closed' } as const
  const ciWord = { running: 'CI running', passing: 'CI passed', failing: 'CI failed', none: 'No CI' } as const
  // CI on the closed row only while it runs (with its time so far) or after it failed; passed CI stays inside the card.
  const ciShort = (p: (typeof sessionPrs)[number]) =>
    p.ci === 'running' ? `CI ${p.ciStart != null ? durationOf(nowOrRead() - p.ciStart) : ''}`.trim() : p.ci === 'failing' && p.state !== 'merged' ? 'CI failed' : null
  const counts = (['merged', 'open', 'draft', 'conflict', 'closed'] as const)
    .map(st => [st, sessionPrs.filter(p => p.state === st).length] as const)
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${word[st].toLowerCase()}`)
    .join('  ·  ')
  return (
    <Box flexDirection="column" gap={1} paddingBottom={1}>
      {tabRow}
      <Text color={SUBTEXT}>{sessionPrs.length === 0 ? 'This session has made no pull request yet.' : counts}</Text>
      {prsStale && sessionPrs.length > 0 ? <Text color={SUBTEXT}>{prsReadAt === null ? 'GitHub not read: these may be out of date' : `GitHub not read since ${agoOf(clock - prsReadAt)}: these may be out of date`}</Text> : null}
      <Box flexDirection="column" gap={1}>
        {[...sessionPrs].reverse().map(p => {
          const key = `pr-${p.ref}`
          const isOpen = isOpenKey(key)
          const which = prTabs[p.ref] === 'ci' ? 'ci' : 'commits'
          const pickTab = (name: string) => () => void update($, prTabAtom, m => ({ ...(m ?? {}), [p.ref]: name }))
          const checks = p.checks ?? []
          const commits = p.commits ?? []
          return B.Card({
            id: key,
            children: [
              // Line 1: where it is: the repository and the linked number; its CI and state in the meta column.
              B.Row({
                id: `${key}-where`,
                align: 'center',
                title: B.Caption({
                  wrap: 'truncate-end',
                  children: [`${p.ref.includes('#') ? p.ref.split('#')[0] : 'This repository'}  •  `, isWebUrl(p.url) ? <Link key="n" href={p.url}>{`#${p.number}`}</Link> : `#${p.number}`],
                }),
                meta: [
                  ciShort(p) !== null && B.Caption({ key: `${key}-ci`, color: p.ci === 'failing' ? 'error' : undefined, children: ciShort(p) }),
                  B.Caption({ key: `${key}-state`, color: p.state === 'conflict' ? 'warning' : SUBTEXT, children: word[p.state] }),
                ],
                control: B.Control({ id: key, open: isOpen, onPress: () => void toggleKey(key) }),
              }),
              // Line 2: the state icon and the title, whole; line 3: what it does, in two sentences, open or closed.
              B.Row({
                id: `${key}-title`,
                badge: svg(prIconSvg(p.state), `${word[p.state]}`, 16, `${key}-icon`, undefined, 16) ?? <Text>{word[p.state][0]}</Text>,
                title: <Text wrap="wrap" dimColor={p.state === 'merged' || p.state === 'closed'}>{p.title}</Text>,
                body: [
                  (p.summary ?? '') !== '' && B.Note({ key: `${key}-summary`, children: p.summary }),
                  // Inside an open card: two tabs, Commits and CI; the choice is kept per pull request.
                  isOpen && (
                    <Box key={`${key}-open`} flexDirection="column" gap={0} marginTop={1}>
                      {B.Tabs({
                        id: `${key}-tabs`,
                        tabs: [
                          { key: `${key}-b-commits`, icon: '●', label: `Commits ${commits.length}`, on: which === 'commits', onPress: pickTab('commits') },
                          { key: `${key}-b-ci`, icon: '✓', label: checks.length > 0 ? `CI ${checks.filter(c => c.state === 'passing').length}/${checks.length}` : 'CI', on: which === 'ci', onPress: pickTab('ci') },
                        ],
                      })}
                      {which === 'commits' &&
                        (commits.length === 0
                          ? B.Caption({ children: 'No commits read yet.' })
                          : commits.map(c => (
                              <Box key={`${key}-c-${c.sha}`} flexDirection="row" gap={1} minWidth={0}>
                                {B.Caption({ children: c.sha })}
                                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                                  <Text size="caption" wrap="truncate-end">{c.title}</Text>
                                </Box>
                              </Box>
                            )))}
                      {which === 'ci' && (
                        <Box flexDirection="column" gap={0}>
                          {B.Caption({
                            color: p.ci === 'failing' ? 'error' : undefined,
                            children: `${ciWord[p.ci]}${p.ciStart != null ? `  ·  ${durationOf((p.ciEnd ?? clock) - p.ciStart)}` : ''}`,
                          })}
                          {checks.map((c, j) => (
                            <Box key={`${key}-k-${j}`} flexDirection="row" gap={1} minWidth={0}>
                              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                                <Text size="caption" wrap="truncate-end">{c.name}</Text>
                              </Box>
                              {B.Caption({
                                color: c.state === 'failing' ? 'error' : c.state === 'running' ? ACCENT_TEXT : undefined,
                                children: c.state === 'passing' ? 'Passed' : c.state === 'failing' ? 'Failed' : c.state === 'running' ? 'Running' : 'No result',
                              })}
                            </Box>
                          ))}
                        </Box>
                      )}
                    </Box>
                  ),
                ],
              }),
            ],
          })
        })}
      </Box>
    </Box>
  )
}

// What a stage card reads: the machine's verdict on each stage and item, and the parts it draws with.
export type StageState = {
  s: Derived['s']
  machine: Derived['d']
  allItems: Item[]
  opened: number[]
  measures: Count[]
  isDone: boolean
  t: number
  running: Helper[]
  watches: WatchRow[]
  watchOpen: string[]
  toggleWatch: (id: string) => Promise<unknown>
  // Hides ended watches the person removed, on the Watches tab.
  removeWatches: (ids: string[]) => Promise<unknown>
  hostKey: string | null
  stageState: (k: number) => 'done' | 'now' | 'next'
  stageTimeText: (k: number, st: NodeStatus) => string | null
  badgeFor: (st: NodeStatus, size?: number) => string
  needsWord: (st: NodeStatus, key: string) => RenderChildren
  toggle: (k: number) => Promise<unknown>
  itemCards: (list: Item[], depth: number) => RenderChildren
  isRoot: (x: Item) => boolean
}


// Each stage is a Card (blocks.tsx): a header Row with its badge, name, time and open control, then its links,
// items and wait. The running stage's card carries the accent border; helpers show in the Watching strip.
export function stageCard(r: Region, c: StageState, name: string, k: number) {
  const { Box, Text, B, svg, linkRow } = r
  const { s, machine, allItems, opened, t, stageState, stageTimeText, badgeFor, needsWord, toggle, itemCards, isRoot } = c
  // The machine's word on the stage: running (a spinner and its timer), open, done or next.
  const state = stageState(k)
  const stStage = machine.stage(k)
  const hasItems = allItems.some(x => x.phase === k)
  // A done stage can fold back to its one line, items or not.
  const canFold = hasItems || state === 'done'
  const isOpen = canFold && opened.includes(k)
  // The time on the stage: its running time, live while it runs, its total once done; nothing open or ahead.
  const ran = stStage === 'running' || stStage === 'done' ? stageTimeText(k, stStage) : null
  const links = s.links.filter(lk => lk.phase === k && lk.item === null)
  const word = stStage === 'done' ? 'done' : stStage === 'running' ? 'in progress' : stStage === 'next' ? 'not started' : stStage === 'needs' ? 'needs you' : 'open'
  return B.Card({
    id: stageKey(k),
    active: stStage === 'running',
    children: [
      B.Row({
        id: stageKey(k),
        align: 'center',
        badge: svg(badgeFor(stStage), `${name}: ${word}`, 16, `stage-badge-${k}`, undefined, 16) ?? <Text>{state === 'done' ? '✓' : state === 'now' ? '●' : '○'}</Text>,
        title: <Text weight="semibold" dimColor={state === 'next'}>{name}</Text>,
        meta: [needsWord(stStage, stageKey(k)), ran !== null && B.Time({ key: `stage-time-${k}`, children: ran })],
        control: B.Control({ id: String(k), open: isOpen, onPress: canFold ? () => void toggle(k) : undefined }),
        body: [
          links.length > 0 && linkRow(links, `links-stage-${k}`),
          // A wait is a normal state, not a fault: a quiet subtitle under the stage, no warning box. The first
          // letter drops to lower case only for a plain word, so CI and PR stay as written.
          state === 'now' && s.waitingOn !== null && (
            <Text key={`wait-${k}`} color={SUBTEXT} wrap="wrap">
              {`Waiting on ${/^[A-Z][a-z]/.test(s.waitingOn) ? s.waitingOn.charAt(0).toLowerCase() + s.waitingOn.slice(1) : s.waitingOn}`}
              <Text dimColor>{`  ·  ${age(s.waitingSince, t)}`}</Text>
            </Text>
          ),
        ],
      }),
      // A stage's items are its children: they start where the stage name starts.
      isOpen && (
        <Box key={`tree-${k}`} width="100%" flexDirection="column" gap={0} paddingLeft={INDENT} marginTop={1}>
          {itemCards(allItems.filter(x => x.phase === k && isRoot(x)), 0)}
        </Box>
      ),
    ],
  })
}
// A finished stage folds to one line: a flat Card (no visible border, the same width) holding one Row, so its
// badge, name and time sit exactly where an open card's do. Its met gates sit in the meta column, before the time.
// The line between stages runs through the row itself: it fills the badge column above and below the badge, and
// the space after the row sits inside it, so the line never breaks between folded stages.
export function foldedCard(r: Region, c: StageState, name: string, k: number, gates: string[], hasMore: boolean, isLast: boolean) {
  const { Text, B, svg } = r
  const { stageTimeText, toggle } = c
  const ran = stageTimeText(k, 'done')
  const pic = svg(badgeSvg('done', 0, 16), `${name}: done`, 16, `fold-badge-${k}`, undefined, 16)
  return B.Card({
    id: `fold-${k}`,
    flat: true,
    children: B.Row({
      id: `fold-${k}`,
      align: 'center',
      space: !isLast,
      badge:
        pic === null
          ? <Text color="success">✓</Text>
          : [B.Trunk({ id: `fold-up-${k}`, on: k > 0, source: waitsLineSvg }), pic, B.Trunk({ id: `fold-down-${k}`, on: !isLast, source: waitsLineSvg })],
      title: <Text dimColor>{name}</Text>,
      meta: [
        gates.length > 0 && B.Caption({ key: `fold-gates-${k}`, children: `✓ ${gates.join(' · ')}` }),
        ran !== null && B.Time({ key: `fold-time-${k}`, children: ran }),
      ],
      control: B.Control({ id: String(k), open: false, onPress: hasMore ? () => void toggle(k) : undefined }),
    }),
  })
}

// Watching: background work that waits for something, only on the Watches tab, so the Progress tab holds only the
// work. Each watch is its own card (the accent border while it runs): its badge, name, shape and time, then what it
// found. A watch that ends stays, marked complete or failed, until the person removes it.
export const sectionHead = (r: Region, key: string, title: string, count: string | null, action?: { label: string; onPress: () => void }) => {
  const { Box, Text, B, Button } = r
  return (
    <Box key={`head-${key}`} width="100%" flexDirection="row" alignItems="center" gap={1}>
      <Text weight="bold">{title}</Text>
      <Box flexGrow={1}><Text>{''}</Text></Box>
      {count !== null && B.Caption({ children: count })}
      {action !== undefined && <Button key={`act-${key}`} label={action.label} plain onPress={action.onPress} />}
    </Box>
  )
}
// What a watch card holds under its title line; an ended watch with none has nothing to unfold.
function watchLines(w: WatchRow, t: number): string[] {
  const ended = w.endedAt !== null
  const lines: string[] = []
  if (w.shape === 'trend' && w.values.length > 0) {
    lines.push([String(w.values[w.values.length - 1]), spark(w.values), trendWord(w.values)].filter(x => x !== '').join('  '))
  } else if (w.hits > 0) {
    lines.push(`${w.hits} ${w.hits === 1 ? 'hit' : 'hits'}${w.lastAt !== null ? ` · last ${age(w.lastAt, t)}` : ''}`)
  }
  if (w.last !== null && w.last !== '') lines.push(`“${w.last}”`)
  if (w.progress !== null && w.progress !== '') lines.push(w.progress)
  if (!ended && w.due !== null) lines.push(`Next check in ${durationOf(Math.max(0, w.due - t))}`)
  if (!ended && lines.length === 0 && w.shape === 'until') lines.push('Ends at its first hit')
  if (!ended && lines.length === 0 && w.shape === 'stream') lines.push('No hits yet')
  return lines
}
function watchBlock(r: Region, c: StageState, w: WatchRow, folded: boolean, lines: string[]): RenderChildren {
  const { Text, B, svg, Button } = r
  const { t, badgeFor, toggleWatch, removeWatches } = c
  const ended = w.endedAt !== null
  const st = ended ? (w.outcome === 'failed' ? 'failed' : 'done') : 'running'
  const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const shape = w.shape ?? (w.source === 'helper' ? 'helper' : w.kind ?? 'watch')
  const meta = ended
    ? `${w.outcome === 'failed' ? 'Failed' : w.outcome === 'hit' ? 'Hit' : 'Complete'} ${clock(w.endedAt ?? t)}`
    : `${shape} · ${durationOf(Math.max(0, t - w.since)) || '0s'}`
  return B.Row({
    id: `watch-${w.id}`,
    align: folded ? 'center' : undefined,
    // Only an ended watch with lines under it folds; one with nothing to show has no + or −.
    control: ended && lines.length > 0 ? B.Control({ id: `watch-${w.id}`, open: !folded, onPress: () => void toggleWatch(w.id) }) : undefined,
    badge: svg(badgeFor(st as NodeStatus), `${w.source === 'helper' ? 'Helper ' : ''}${w.name}: ${ended ? meta.toLowerCase() : 'running'}`, 16, `watch-badge-${w.id}`, undefined, 16) ?? <Text>{ended ? '✓' : '●'}</Text>,
    title: <Text weight="semibold" dimColor={ended} wrap="wrap">{cap(w.name)}</Text>,
    meta: [
      B.Time({ key: `watch-time-${w.id}`, color: w.outcome === 'failed' ? 'error' : undefined, children: meta }),
      // An ended watch can be removed; a running one cannot.
      ended && <Button key={`watch-remove-${w.id}`} label="Remove" plain dimColor onPress={() => void removeWatches([w.id])} />,
    ],
    body: folded || lines.length === 0 ? undefined : lines.map((x, k) => B.Note({ key: `watch-${w.id}-l${k}`, children: x })),
  })
}
// The newest ended first after the running ones (watches.ts order). Watches show only on the Watches tab.
const countOf = (rows: readonly WatchRow[]) => {
  const live = rows.filter(w => w.endedAt === null).length
  return live === rows.length ? `${live} running` : `${live} running · ${rows.length - live} ended`
}
function watchCards(r: Region, c: StageState, rows: readonly WatchRow[]): RenderChildren {
  const { B } = r
  return rows.map(w => {
    // An ended watch folds to one line (its badge, name and end), as a done stage does; + opens it again.
    // An ended watch with nothing under its title line is always one flat line.
    const lines = watchLines(w, c.t)
    const folded = w.endedAt !== null && (lines.length === 0 || !c.watchOpen.includes(w.id))
    return B.Card({ id: `watch-card-${w.id}`, active: w.endedAt === null, flat: folded, children: watchBlock(r, c, w, folded, lines) })
  })
}
// The Watches tab: every watch, running first, then the ended ones newest first.
export function watchesTab(r: Region, c: StageState) {
  const { Box, Text } = r
  const rows = c.watches
  const endedIds = rows.filter(w => w.endedAt !== null).map(w => w.id)
  return (
    <Box flexDirection="column" alignItems="stretch" gap={2} paddingBottom={1}>
      {r.tabRow}
      <Box width="100%" flexDirection="column" gap={1}>
        {sectionHead(r, 'watches-all', 'Watching (Beta)', rows.length === 0 ? null : countOf(rows), endedIds.length > 0 ? { label: 'Remove ended', onPress: () => void c.removeWatches(endedIds) } : undefined)}
        {rows.length === 0 ? <Text color="subtle">No watches in this session.</Text> : watchCards(r, c, rows)}
      </Box>
    </Box>
  )
}

export function progressTab(r: Region, c: StageState) {
  const { Box, Text, B, svg, hasSvg, tabRow } = r
  const { s, allItems, opened, measures, machine, stageState } = c
  const isMet = (x: Count) => machine.gateMet(x)
  const small = (text: string, color?: string) => (
    <Text dimColor={color === undefined} color={color}>
      {text}
    </Text>
  )

  const hypoMark: Record<HypothesisState, string> = { open: '○', testing: '●', 'ruled out': '✕', confirmed: '✓' }
  const hypoColor: Record<HypothesisState, string> = { open: 'subtle', testing: ACCENT_TEXT, 'ruled out': 'subtle', confirmed: 'success' }
  const confirmed = s.hypotheses.find(x => x.state === 'confirmed')
  return (
    <Box flexDirection="column" alignItems="stretch" gap={2} paddingBottom={1}>
      {/* The header and the tabs come first (view.tsx tabRow); the tabs stand where the stage bar was. */}
      {tabRow}



      {(s.stage === 'fix' || s.stage === 'cause') && s.symptom !== null && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            {small('Symptom')}
            <Text>{s.symptom}</Text>
          </Box>
          {confirmed !== undefined && (
            <Box flexDirection="column">
              {small('Cause')}
              <Text>{confirmed.text}</Text>
            </Box>
          )}
          {s.stage === 'cause' &&
            s.hypotheses.map((x, k) =>
              B.Row({
                id: `hypo-${k}`,
                badge: <Text color={hypoColor[x.state]}>{hypoMark[x.state]}</Text>,
                title: <Text wrap="wrap" dimColor={x.state === 'ruled out' || x.state === 'open'}>{x.text}</Text>,
                meta: B.Caption({ children: cap(x.state) }),
              }),
            )}
        </Box>
      )}

      <Box flexDirection="column" alignItems="stretch" gap={0}>
        {(() => {
          // Pull requests show on the items that made them (a chip on the item's row), not as a card of their own.
          const rows: RenderChildren[] = []
          s.phases.forEach((name, k) => {
            // A stage may have several gates: each draws its own chip on the line, one under another.
            const exits = measures.filter(c => c.phase === k && c.when !== undefined)
            const isLast = k === s.phases.length - 1
            const met = stageState(k) === 'done'
            // A finished stage whose gates are all met folds to one line: its badge, name, gates and time. The
            // person's + opens the full card again.
            const hasMore = allItems.some(x => x.phase === k) || s.links.some(l => l.phase === k)
            if (met && !opened.includes(k)) {
              rows.push(
                <Box width="100%" flexDirection="column" gap={0} key={`flow-${k}`}>
                  {foldedCard(r, c, name, k, exits.map(x => x.when ?? ''), hasMore, isLast)}
                </Box>,
              )
              return
            }
            rows.push(
              <Box width="100%" flexDirection="column" gap={0} key={`flow-${k}`}>
                {stageCard(r, c, name, k)}
                {exits.map((exit, j) =>
                  hasSvg
                    ? svg(
                        exitSvg(exit.when ?? '', isLast && j === exits.length - 1, isMet(exit)),
                        isMet(exit) ? `Gate met: ${exit.when}` : `Gate: ${exit.when}`,
                        40,
                        `gate-${k}-${j}`,
                      )
                    : small(`Gate: ${exit.when}`),
                )}
                {/* Every card joins the next by a line, gate or no gate. */}
                {exits.length === 0 && !isLast && (hasSvg ? svg(flowLineSvg(16), 'Line to the next stage', 16, `flow-line-${k}`) : <Box height={1}><Text>{''}</Text></Box>)}
              </Box>,
            )
          })
          return rows
        })()}
      </Box>
    </Box>
  )
}

export function runbookTab(r: Region, book: Runbook) {
  const { Box, Text, B, svg, linkRow, tabRow } = r
  // The runbook view: the summary, the rail, then the steps in order: done ones dim, the current one in the
  // accent, the rest plain. A wait on the person reads "Needs your ...".
  const m = book.steps.length
  const doneN = book.steps.filter(x => x.status === 'done').length
  const isMine = (x: RunbookStep) => x.status !== 'done' && x.waitsOn !== null && /^(you|your)\b/i.test(x.waitsOn)
  const mine = book.steps.map((x, k) => ({ x, k })).filter(({ x }) => isMine(x))
  const nowStep = book.steps.find(x => x.status === 'now') ?? null
  const waitText = (x: RunbookStep) => (x.waitsOn === null ? null : /^(you|your)\b/i.test(x.waitsOn) ? `Needs ${x.waitsOn}` : `Waits on ${x.waitsOn}`)
  // Each fact shows once: the count of waits on the person in the summary, and each wait under its own step.
  const summaryLine = [`${doneN} of ${m} done`, mine.length > 0 ? `${mine.length} need you` : null, nowStep !== null ? `now: ${nowStep.name}` : null]
    .filter(Boolean)
    .join('  ·  ')
  // Each step is a Row: its badge, its number and name, then its note and any wait in the body.
  const stepRow = (x: RunbookStep, k: number, key: string) =>
    B.Row({
      id: key,
      badge:
        svg(badgeSvg(x.status === 'done' ? 'done' : x.status === 'now' ? 'now' : 'next', Date.now(), 16), `Step ${k + 1}: ${x.status}`, 16, `${key}-badge`, undefined, 16) ??
        <Text>{x.status === 'done' ? '✓' : x.status === 'now' ? '●' : '○'}</Text>,
      title: (
        <Text wrap="wrap" dimColor={x.status === 'done'} color={x.status === 'now' ? ACCENT_TEXT : x.status === 'failed' ? 'error' : undefined}>
          <Text color={SUBTEXT}>{`${k + 1}  `}</Text>
          {x.name}
        </Text>
      ),
      body: [
        x.note !== null && B.Note({ key: `${key}-note`, children: x.note }),
        x.status !== 'done' && waitText(x) !== null && B.Note({ key: `${key}-wait`, color: isMine(x) ? 'warning' : SUBTEXT, children: waitText(x) }),
      ],
    })
  return (
    <Box flexDirection="column" gap={1} paddingBottom={1}>
      {tabRow}
      <Box flexDirection="column" gap={0}>
        <Text size="heading" weight="semibold" wrap="wrap">{book.title}</Text>
        <Text color={SUBTEXT} wrap="wrap">{summaryLine}</Text>
      </Box>
      {r.hasSvg && svg(stepsRailSvg(book.steps.map(x => x.status)), `${doneN} of ${m} steps done`, 6, 'runbook-rail')}
      {book.href !== null && linkRow([{ label: 'Open the runbook', href: book.href }], 'runbook-link')}
      <Box flexDirection="column" gap={0}>
        <Text weight="semibold">Steps</Text>
        {book.steps.map((x, k) => stepRow(x, k, `rb-${k}`))}
      </Box>
    </Box>
  )
}