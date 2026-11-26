import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ElementConstructor, RenderChildren, RenderInput, SvgProps } from 'claude-code'
import type { Count, Item, ItemStatus, Live, PrRecord, Runs } from '../types'
import { prIconSvg, badgeSvg, failedBadgeSvg, needsBadgeSvg, stepPulseSvg, textWidth, waitsLineSvg, stripSvg } from './bars'
import { age, cap, findRef, workOrder } from './model'
import { deriveNow } from './store'
import { type NodeStatus, type Timing, itemKey, stageKey, timeOf } from './machine'
import { openDoc } from './doc'
import { blocks, durationOf, CHEV, SPACE, SUBTEXT, ACCENT_TEXT } from './blocks'
import { type Region, type StageState, agoOf, STALE_MS, isWebUrl, header, prsTab, progressTab, runbookTab } from './regions'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const live = atom({ plugin: 'mission-status', key: 'live' } as const, null as Live | null, { shape: 'live' })
const now = atom({ plugin: 'mission-status', key: 'now' } as const, 0)
const open = atom({ plugin: 'mission-status', key: 'open' } as const, null as string[] | null)
const runsAtom = atom({ plugin: 'mission-status', key: 'runs' } as const, {} as Runs)
const seenAtom = atom({ plugin: 'mission-status', key: 'seenAt' } as const, 0)
// The pane's open tab: null is Progress, else a runbook's id.
const tabAtom = atom({ plugin: 'mission-status', key: 'tab' } as const, null as string | null)
// The open tab inside each pull request card, by its reference.
const prTabAtom = atom({ plugin: 'mission-status', key: 'prTab' } as const, {} as Record<string, string>)
// The pull requests this session made, oldest first (register.tsx and readers.ts write them).
const prRefsAtom = atom({ plugin: 'mission-status', key: 'prRefs' } as const, [] as string[])
const autoUpdate = atom({ plugin: 'mission-status', key: 'autoUpdate' } as const, null as boolean | null)
const updateState = atom({ plugin: 'mission-status', key: 'updateState' } as const, null as { phase: string; version: string | null; failures: number; at: number } | null)

// An empty 2 px drawing that holds the place of a stub where no line runs.
const STUB_NONE = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="2"></svg>'



// The clock time a step was done, in the machine's own local time, with no zone name: 9:05 PM.
export function timeOfDay(at: number): string {
  const d = new Date(at)
  const h = d.getHours()
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}

// A Claude artifact's address.
export const isArtifact = (href: string) => /^https:\/\/claude\.ai\/(code\/)?artifact\/[\w-]+[^\s]*$/i.test(href)

// Opens an artifact inside the Claude desktop app through the session's own Artifact tool. If the tool is missing
// or refuses, the address opens in the browser, as any web link does.
export async function openArtifact($: EngineInterface, url: string): Promise<void> {
  // A refusal comes back as a result with deny, not as an error: either way, ask the agent, which has the same tool.
  const res = (await Promise.resolve()
    .then(() => $.tool.call({ tool: 'Artifact', action: 'open', url } as never))
    .catch(() => null)) as { deny?: unknown } | null
  if (res === null || res.deny !== undefined)
    await $.prompt.submit({ text: `Open this artifact in the app with the Artifact tool, action open, and say nothing else: ${url}` } as never).catch(() => undefined)
}

// Kept here for the callers that read them from the view.
export { agoOf, STALE_MS }

export async function renderPane($: EngineInterface, e: Extract<RenderInput, { component: 'Pane' }>) {
    const ui = $.ui.resolve(e)
    const { Box, Text, Link, Button } = ui
    // Svg draws the bars; a surface without it shows the figures only.
    const extra = ui as unknown as { Svg?: ElementConstructor<SvgProps> }
    const { Svg } = extra
    // A failed read of the stored state keeps the pane up and says so; the Update button asks for a fresh state.
    let readFailed = false
    const safe = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p
      } catch {
        readFailed = true
        return fallback
      }
    }
    // The one derive (store.ts): the stored state, the merged item tree and the machine's verdict.
    const dn = await safe(deriveNow($), null)
    const s = dn?.s ?? null
    const l = (await safe(read($, live), null)) as Live | null
    const t = Math.max(await safe(read($, now), 0), s?.at ?? 0)
    // The engine clock, for ages that decide a state (stale, the next GitHub try).
    const clock = await $.clock.now().catch(() => Date.now())

    // Only when the pane has no state (or cannot read it) does an Update button show, to ask the agent for one.
    const askUpdate = () =>
      void $.prompt
        .submit({ text: 'Update the progress pane: look again at the stages and the work, then send the whole state.' })
        .catch(() => undefined)
    if (s === null)
      return (
        <Box flexDirection="column" gap={1}>
          {readFailed ? (
            <Text color="error" wrap="wrap">The pane could not read its stored state. Press Update to ask the agent for a fresh state.</Text>
          ) : (
            <Text color={SUBTEXT} wrap="wrap">No progress yet. The agent sends the first state at its first step of real work.</Text>
          )}
          <Button key="update-empty" label="Update" variant="primary" onPress={askUpdate} />
        </Box>
      )
    const upd = await safe(read($, updateState), null)
    const auto = await safe(read($, autoUpdate), null)
    // The state machine decides every status (machine.ts): the view only draws it, so no two parts can disagree.
    const { items: allItems, d: machine, facts } = dn as NonNullable<typeof dn>
    const runs = (await safe(read($, runsAtom), {} as Runs)) ?? {}
    const seen = (await safe(read($, seenAtom), 0)) ?? 0
    // A node's running time: what it counted before, plus the span it runs now.
    const runTime = (key: string): number | null => {
      const r = runs[key]
      if (r === undefined) return null
      return r.ms + (r.from !== null ? Math.max(0, t - r.from) : 0)
    }
    // A stage's time: its counted running time; for work from before running time was counted, its recorded start and
    // end. Never blank where a time is known.
    // A stage's time (machine.timeOf): its own running time, else its items' running time, else their span, else the
    // recorded start and end, else when its last item finished. A stage the stage number jumped past still has one.
    const stageTiming = (k: number, st: NodeStatus): Timing => {
      const mine = allItems.filter(x => machine.stageOf(x) === k)
      const tm = timeOf(runTime(stageKey(k)), mine.map(x => ({ ran: runTime(itemKey(x)), since: x.since, doneAt: x.doneAt })))
      if (tm !== null) return tm
      const from = s.starts?.[k] ?? null
      const to = st === 'done' ? (s.ends?.[k] ?? null) : st === 'running' ? t : null
      return from !== null && to !== null && to >= from ? { ms: to - from } : null
    }
    // What a stage shows: a duration where one is known, else the clock time it finished.
    const stageTimeText = (k: number, st: NodeStatus): string | null => {
      const tm = stageTiming(k, st)
      return tm === null ? null : 'ms' in tm ? (tm.ms > 0 ? durationOf(tm.ms) : null) : timeOfDay(tm.at)
    }
    // For the open state and the chips: a running or open stage counts as in progress, so it stays open to read.
    const stageState = (k: number): 'done' | 'now' | 'next' => {
      const st = machine.stage(k)
      return st === 'done' ? 'done' : st === 'next' ? 'next' : 'now'
    }
    // The badge: a spinner only while it runs; open work shows a still dot.
    const badgeOf = (st: NodeStatus): 'done' | 'now' | 'next' | 'dot' => (st === 'running' ? 'now' : st === 'open' || st === 'failed' || st === 'needs' ? 'dot' : st)
    // A node's badge drawing: a failure and a wait on the person each have their own mark.
    const badgeFor = (st: NodeStatus, size = 16) => (st === 'failed' ? failedBadgeSvg(size) : st === 'needs' ? needsBadgeSvg(size) : badgeSvg(badgeOf(st), 0, size))
    // The status word for a wait on the person, in the meta column of its row.
    const needsWord = (st: NodeStatus, key: string) => st === 'needs' && B.Caption({ key: `${key}-needs`, color: 'warning', children: 'Needs you' })

    // isInteractive draws the picture in a sandboxed frame, where its <title> tooltips show on hover.
    // width: a fixed pixel width. A drawing in a column box is stretched to the column's width without it.
    const svg = (source: string, alt: string, height: number, key?: string, isInteractive?: boolean, width?: number) =>
      Svg === undefined ? null : <Svg key={key} source={source} alt={alt} height={height > 0 ? height : undefined} width={width} isInteractive={isInteractive === true ? true : undefined} />
    // The building blocks every region is drawn from (blocks.tsx).
    const B = blocks({ Box, Text, Button, Link }, (source, alt, height, key, width) => svg(source, alt, height, key, undefined, width))

    const isDone = machine.allDone

    // What the pane reads itself.
    const helpersAll = l?.helpers ?? []
    const running = helpersAll.filter(x => x.status === 'running')
    // The session's pull requests: the newest 20 it made, each from its one record.
    const sessionPrs = ((await safe(read($, prRefsAtom), [])) ?? [])
      .slice(-20)
      .map(r => l?.prRecords?.[r])
      .filter((x): x is PrRecord => x !== undefined)
    // GitHub not read: a CI timer stops at the last good read, and the PRs tab says since when.
    const prsStale = l?.prsUnread === true
    const prsReadAt = l?.prsReadAt ?? null
    const nowOrRead = () => (prsStale && prsReadAt !== null ? prsReadAt : clock)
    const merged = sessionPrs.filter(p => p.state === 'merged').length

    // One measure per stage. The pane supplies pull requests for a Deploy stage that has none.
    const deploy = s.phases.indexOf('Deploy')
    const measures: Count[] = [...s.counts]
    if (deploy >= 0 && sessionPrs.length > 0 && !measures.some(c => c.phase === deploy))
      measures.push({ label: 'Pull requests merged', when: 'every pull request merges', n: merged, m: sessionPrs.length, phase: deploy })

    // What is open follows state: a card or an item in progress opens by itself, and a completed one closes. A press
    // overrides that, but only while the card stays in the state it had at the press; a change of state restores the rule.
    // An item's key: its stage and id, so two items with one name never share a row key or an open state.
    const stateOfKey = (key: string): string => {
      if (key.startsWith('stage-')) return stageState(Number(key.slice(6)))
      if (key.startsWith('item-')) return allItems.find(x => itemKey(x) === key)?.status ?? 'next'
      return 'fixed'
    }
    const overrides = ((await safe(read($, open), [] as string[])) ?? []).filter(x => x.includes('@'))
    const isOpenKey = (key: string) => {
      const st = stateOfKey(key)
      const mine = overrides.find(x => x.startsWith(`${key}@${st}=`))
      return mine !== undefined ? mine.endsWith('=1') : st === 'now'
    }
    const opened = s.phases.map((_, k) => k).filter(k => isOpenKey(stageKey(k)))
    const toggleKey = (key: string) => {
      const st = stateOfKey(key)
      const next = isOpenKey(key) ? 0 : 1
      return update($, open, list => [...(list ?? []).filter(x => !x.startsWith(`${key}@`)), `${key}@${st}=${next}`])
    }
    const toggle = (k: number) => toggleKey(stageKey(k))

    const itemMark: Record<ItemStatus, string> = { done: '✓', now: '●', next: '○', failed: '✕', needs: '!' }
    const itemColor: Record<ItemStatus, string> = { done: 'success', now: ACCENT_TEXT, next: 'subtle', failed: 'error', needs: 'warning' }
    // The items of a stage as a tree: an item that waits for another sits indented under it; items side by side run in parallel.
    // Items are cards, nested to any depth by parent. Siblings in order: an item that waits for another follows it
    // after the other's gate; siblings with no wait between them run in parallel.
    // An item's status for its row: the machine's word, as the row's state names it.
    const itemState = (x: Item): ItemStatus => {
      const st = machine.item(x)
      return st === 'running' ? 'now' : st === 'open' ? 'now' : st
    }
    // The item tree, drawn the way tree views draw it. Siblings share one column. A wait is a vertical line in the
    // badge column that joins the two badges, past any note and any child rows between them. Children indent by one
    // step (the badge column plus its gap). Every row carries the rail columns of its ancestors, so lines never break.
    // Links on a card. A web link is a link chip; a Claude artifact and a local Markdown file are the app's own grey
    // buttons (they open inside Claude); any other path shows as its label and path.
    const linkRow = (links: { label: string; href: string }[], key: string) =>
      links.length === 0
        ? null
        : B.ChipRow({
            id: key,
            children: links.map((l, k) =>
              isArtifact(l.href)
                ? // A real button, so the press always reaches the pane; the press calls the session's Artifact tool.
                  <Button key={`art-${key}-${k}`} label={`↗ ${l.label}`} onPress={() => void openArtifact($, l.href)} />
                : isWebUrl(l.href)
                  ? B.Chip({ id: `${key}-${k}`, label: `↗ ${l.label}`, tone: 'link', href: l.href })
                  : /\.(md|markdown)$/i.test(l.href) && (l.href.startsWith('/') || l.href.startsWith('~'))
                    ? <Button key={`doc-${key}-${k}`} label={`↗ ${l.label}`} onPress={() => void openDoc($, l.label, l.href).catch(() => undefined)} />
                    : <Text color={SUBTEXT} key={`${key}-${k}`}>{`${l.label}: ${l.href}`}</Text>,
            ),
          })
    // Siblings in the work's own order: as the agent sent them, an item after the one it waits for. No sort by status,
    // so a row never jumps when its status changes.
    const ordered = (list: Item[]) => workOrder(list, allItems)
    // The items of a stage as a tree (blocks.tsx Tree): each item one Row, its badge column carrying the trunk to the
    // next sibling; the note, sub-sub-steps, helpers, links and open children sit in its body, under its name.
    const itemCards = (list: Item[], depth: number): RenderChildren => {
      const order = ordered(list)
      return B.Tree({
        // A list is keyed by its stage and its parent, never by an item's name, so a rename or a new first item keeps
        // every drawing in it mounted.
        id: `list-${depth}-${order[0]?.phase ?? 0}-${order[0]?.parent ?? 'root'}`,
        line: waitsLineSvg,
        none: STUB_NONE,
        nodes: order.map(x => {
          const kids = machine.kids(x)
          const key = itemKey(x)
          const isOpen = kids.length > 0 && isOpenKey(key)
          const state = itemState(x)
          const st = machine.item(x)
          // The item's pull request CI rides on the item's own line, after the item's time: a part of that time.
          const ci = x.pr != null ? (l?.ci?.[x.pr] ?? null) : null
          const ciTook = ci === null || ci.start === null ? null : (ci.end ?? nowOrRead()) - ci.start
          // A done item with passed checks says nothing more; a failure always shows.
          const ciPart =
            ci === null || ci.state === 'none' || (ci.state === 'passing' && state === 'done')
              ? null
              : `${ci.state === 'running' ? 'CI' : ci.state === 'failing' ? 'CI failed' : 'CI passed'}${ciTook === null ? '' : ` ${durationOf(ciTook)}`}`
          // A timer counts only while the item runs (its running time, never idle hours); a done item shows when it
          // finished; an open one shows nothing.
          const ran = runTime(key)
          const timeWord =
            st === 'running'
              ? durationOf(ran !== null && ran > 0 ? ran : Math.max(0, t - (x.since ?? t)))
              : state === 'done' && (x.doneAt ?? null) !== null
                ? timeOfDay(x.doneAt ?? 0)
                : null
          const word = state === 'done' ? 'done' : state === 'needs' ? 'needs you' : state === 'now' ? 'in progress' : state === 'failed' ? 'failed' : 'not started'
          const mine = s.links.filter(lk => lk.item !== null && findRef(allItems, lk.item, x.phase) === x)
          const helpers = Svg !== undefined && hostKey !== null && itemKey(x) === hostKey ? running : []
          const prNo = x.pr != null ? `#${String(x.pr).split('#').pop()}` : null
          return {
            id: key,
            badge: badgeFor(st),
            alt: `${x.name}: ${word}`,
            fallback: <Text color={itemColor[x.status]}>{itemMark[x.status]}</Text>,
            // Body style for every item; the badge carries the state, the colour only steps back for done and later items.
            title: (
              <Text color={state === 'now' || state === 'needs' ? undefined : SUBTEXT} wrap="wrap">
                {x.name}
              </Text>
            ),
            // The meta column: the pull request (its state icon and number), its CI, then the item's time.
            meta: [
              prNo !== null && (
                <Box flexDirection="row" alignItems="center" gap={0} key={`${key}-pr`}>
                  {svg(prIconSvg(ci?.pr ?? 'open'), `Pull request ${x.pr}: ${ci?.pr ?? 'open'}`, 14, `${key}-pr-icon`, undefined, 14)}
                  {B.Caption({ children: ci?.url != null && isWebUrl(ci.url) ? <Link href={ci.url}>{prNo}</Link> : prNo })}
                </Box>
              ),
              needsWord(st, key),
              ciPart !== null && B.Caption({ key: `${key}-ci`, color: ci?.state === 'failing' ? 'error' : undefined, children: ciPart }),
              timeWord !== null && B.Time({ key: `${key}-time`, children: timeWord }),
            ],
            control: B.Control({ id: key, open: isOpen, onPress: kids.length > 0 ? () => void toggleKey(key) : undefined }),
            body: [
              // The note sits directly under the name, with no gap.
              (x.note ?? null) !== null && B.Note({ key: `${key}-note`, children: x.note }),
              // Sub-sub-steps that run at the same time: each name pulses while the item runs, with a small offset
              // between them, never one after another.
              (x.steps ?? []).length > 0 && x.stepsParallel === true && Svg !== undefined &&
                B.ChipRow({
                  id: `${key}-psteps`,
                  children: (x.steps ?? []).map((name, j) => svg(stepPulseSvg(name, j, st === 'running'), name, 16, `${key}-pstep-${j}`, undefined, textWidth(name, 12) + 2)),
                }),
              // Sub-sub-steps in order, on one dot-separated line: the one that runs now in full-opacity body text, the
              // rest faint.
              (x.steps ?? []).length > 0 && (x.stepsParallel !== true || Svg === undefined) &&
                B.Note({
                  key: `${key}-steps`,
                  children: (x.steps ?? []).map((name, j) => [
                    j > 0 ? ' · ' : '',
                    j === x.step && state === 'now' ? <Text key={`${key}-step-${j}`} weight="bold" color="text">{name}</Text> : name,
                  ]),
                }),
              // The helpers the session runs now sit under the item in progress, as its children.
              ...helpers.slice(0, 6).map(helper => (
                <Box key={`${key}-helper-${helper.id}`} paddingRight={CHEV} minWidth={0}>
                  {svg(stripSvg({ title: cap(helper.description), detail: helper.model, state: 'running', time: age(helper.startTime, t) }), `Helper ${helper.description}: running`, 22, `strip-${helper.id}`)}
                </Box>
              )),
              helpers.length > 6 && B.Caption({ key: `${key}-more`, children: `${helpers.length - 6} more helpers run.` }),
              mine.length > 0 && linkRow(mine, `links-${key}`),
              // Children start one space below the item's last line, the same space as between siblings.
              isOpen && depth < 5 && <Box key={`${key}-kids`} width="100%" marginTop={SPACE}>{itemCards(kids, depth + 1)}</Box>,
            ],
          }
        }),
      })
    }
    // The item that holds the running helpers (store.ts hostOf), or null.
    const hostKey = facts.hostKey
    // A root is an item no item holds in the machine's tree, so an item in a parent loop still shows.
    const isRoot = (x: Item) => !allItems.some(y => machine.kids(y).includes(x))
    const stage: StageState = { s, machine, allItems, opened, measures, isDone, t, running, hostKey, stageState, stageTimeText, badgeFor, needsWord, toggle, itemCards, isRoot }

    // Tabs: Progress, then one tab for each runbook the session follows. A press switches the view.
    const runbooks = s.runbooks ?? []
    const tab = await safe(read($, tabAtom), null)
    const book = runbooks.find(r => r.id === tab) ?? null
    // Tabs: Progress, PRs (always), then each runbook or skill the session follows.
    const onPrs = tab === 'prs'
    // The tab bar (blocks.tsx Tabs): Progress, PRs, then one tab for each runbook or skill. One runbook: its tab reads
    // Runbook (or Skill), and its title heads the view. Several: each tab carries its title.
    const pick = (value: string | null) => () => void update($, tabAtom, () => value)
    const tabRow = B.Tabs({
      id: 'tabs',
      tabs: [
        { key: 'tab-progress', icon: '◔', label: 'Progress', on: book === null && !onPrs, onPress: pick(null) },
        { key: 'tab-prs', icon: '⎇', label: sessionPrs.length > 0 ? `PRs ${sessionPrs.length}` : 'PRs', on: onPrs, onPress: pick('prs') },
        ...runbooks.map(r => ({
          key: `tab-${r.id}`,
          icon: r.id.startsWith('skill-') ? '✦' : '☰',
          label: runbooks.length === 1 ? (r.id.startsWith('skill-') ? 'Skill' : 'Runbook') : r.title.replace(/^Skill: /, ''),
          on: book?.id === r.id,
          onPress: pick(r.id),
        })),
      ],
    })
    const region: Region = { Box, Text, Link, Button, B, svg, hasSvg: Svg !== undefined, linkRow, tabRow }
    if (onPrs) {
      const prTabs = (await safe(read($, prTabAtom), {} as Record<string, string>)) ?? {}
      return prsTab($, region, { sessionPrs, prTabs, prsStale, prsReadAt, clock, nowOrRead, isOpenKey, toggleKey })
    }
    if (book !== null) return runbookTab(region, book)

    return progressTab(region, stage, header($, region, { s, turnOpen: facts.turnOpen, t, seen, clock, upd, auto, isDone, readFailed, askUpdate }))
}
