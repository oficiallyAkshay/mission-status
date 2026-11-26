import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ElementConstructor, ProgressProps, RenderChildren, RenderInput, SvgProps } from 'claude-code'
import type { Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Marks, Pr, Runs, StageKey, StepStatus, Summary, Task, Ticket, RunbookStep } from '../types'
import { stepsRailSvg, prIconSvg, badgeSvg, failedBadgeSvg, needsBadgeSvg, stepPulseSvg, textWidth, exitSvg, flowLineSvg, waitsLineSvg, stripSvg } from './bars'
import { age, cap, findRef, idOf, normalize, workOrder } from './model'
import type { MergeLive } from './readers'
import { ACCENT, hostOf } from './store'
import { type Facts, type NodeStatus, type Timing, derive, mergeItems, timeOf } from './machine'
import { updateText } from './update-line'
import { setAutoUpdate, updateNow } from './update'
import { openDoc } from './doc'
import { blocks, durationOf, CHEV, INDENT, NOTE, SPACE, SUBTEXT, ACCENT_TEXT } from './blocks'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const live = atom({ plugin: 'mission-status', key: 'live' } as const, null as Live | null, { shape: 'live' })
const now = atom({ plugin: 'mission-status', key: 'now' } as const, 0)
const open = atom({ plugin: 'mission-status', key: 'open' } as const, null as string[] | null)
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
// The live facts the state machine reads (store.ts writes them).
const turnOpenAtom = atom({ plugin: 'mission-status', key: 'turnOpen' } as const, false as boolean)
const waitingAtom = atom({ plugin: 'mission-status', key: 'waiting' } as const, false as boolean)
const runsAtom = atom({ plugin: 'mission-status', key: 'runs' } as const, {} as Runs)
const seenAtom = atom({ plugin: 'mission-status', key: 'seenAt' } as const, 0)
const marksAtom = atom({ plugin: 'mission-status', key: 'marks' } as const, null as Marks | null)
// The pane's open tab: null is Progress, else a runbook's id.
const tabAtom = atom({ plugin: 'mission-status', key: 'tab' } as const, null as string | null)
// The open tab inside each pull request card, by its reference.
const prTabAtom = atom({ plugin: 'mission-status', key: 'prTab' } as const, {} as Record<string, string>)
const autoUpdate = atom({ plugin: 'mission-status', key: 'autoUpdate' } as const, null as boolean | null)
const updateState = atom({ plugin: 'mission-status', key: 'updateState' } as const, null as { phase: string; version: string | null; failures: number; at: number } | null)

// An empty 2 px drawing that holds the place of a stub where no line runs.
const STUB_NONE = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="2"></svg>'
// With no update from the agent for this long, the header shows the age in amber.
// Only web addresses open as links; a file:, javascript: or app-scheme address shows as text.
const isWebUrl = (href: string) => /^https?:\/\/[^\s]+$/i.test(href)


// The header's age of the last update: seconds, then minutes, then hours.
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

export function agoOf(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  return `${Math.floor(sec / 3600)}h ago`
}

export const STALE_MS = 15 * 60_000

export async function renderPane($: EngineInterface, e: Extract<RenderInput, { component: 'Pane' }>) {
    const ui = $.ui.resolve(e)
    const { Box, Text, Link, Button, Markdown } = ui
    // Svg draws the bars; Progress stands in where Svg is missing, and a surface with neither shows the figures only.
    const extra = ui as unknown as { Progress?: ElementConstructor<ProgressProps>; Svg?: ElementConstructor<SvgProps> }
    const { Progress, Svg } = extra
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
    const s = normalize(await safe(read($, summary), null))
    const l = (await safe(read($, live), null)) as MergeLive | null
    const t = Math.max(await safe(read($, now), 0), s?.at ?? 0, l?.at ?? 0)
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
    const steps = (await safe(read($, tasks), [] as Task[])) ?? []
    const upd = await safe(read($, updateState), null)
    const auto = await safe(read($, autoUpdate), null)
    // The state machine decides every status (machine.ts): the view only draws it, so no two parts can disagree.
    const baseFacts: Facts = {
      turnOpen: (await safe(read($, turnOpenAtom), false)) === true,
      waiting: (await safe(read($, waitingAtom), false)) === true,
      helpersRunning: (l?.helpers ?? []).some(h => h.status === 'running'),
      hostKey: null,
      ci: (l?.ci ?? {}) as Facts['ci'],
      marks: (await safe(read($, marksAtom), null))?.marks ?? {},
    }
    const allItems: Item[] = mergeItems(s, steps, baseFacts)
    const facts: Facts = { ...baseFacts, hostKey: hostOf(s, allItems) }
    const machine = derive(s, allItems, facts)
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
      const tm = timeOf(runTime(`stage-${k}`), mine.map(x => ({ ran: runTime(itemKey(x)), since: x.since, doneAt: x.doneAt })))
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
    const small = (text: string, color?: string) => (
      <Text dimColor={color === undefined} color={color}>
        {text}
      </Text>
    )

    const total = s.phases.length
    const isDone = machine.allDone
    const current = isDone ? null : (s.phases[s.phase] ?? null)

    // What the pane reads itself.
    const helpersAll = l?.helpers ?? []
    const running = helpersAll.filter(x => x.status === 'running')
    const prs = l?.prs ?? []
    const merged = prs.filter(p => p.state === 'MERGED').length

    // One measure per stage. The pane supplies pull requests for a Deploy stage that has none.
    const deploy = s.phases.indexOf('Deploy')
    const measures: Count[] = [...s.counts]
    if (deploy >= 0 && prs.length > 0 && !measures.some(c => c.phase === deploy))
      measures.push({ label: 'Pull requests merged', when: 'every pull request merges', n: merged, m: prs.length, phase: deploy })

    // What is open follows state: a card or an item in progress opens by itself, and a completed one closes. A press
    // overrides that, but only while the card stays in the state it had at the press; a change of state restores the rule.
    // An item's key: its stage and id, so two items with one name never share a row key or an open state.
    const itemKey = (x: Item) => `item-${x.phase}-${x.id ?? idOf(x.name)}`
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
    const opened = s.phases.map((_, k) => k).filter(k => isOpenKey(`stage-${k}`))
    const toggleKey = (key: string) => {
      const st = stateOfKey(key)
      const next = isOpenKey(key) ? 0 : 1
      return update($, open, list => [...(list ?? []).filter(x => !x.startsWith(`${key}@`)), `${key}@${st}=${next}`])
    }
    const toggle = (k: number) => toggleKey(`stage-${k}`)

    // A gate shows met only as the state machine says: the agent claims it and every item of its stage is done.
    const isMet = (c: Count) => machine.gateMet(c)
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
    const kidsOf = (x: Item) => allItems.filter(y => y.phase === x.phase && y !== x && findRef(allItems, y.parent, y.phase, y) === x)
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
          const kids = kidsOf(x)
          const key = itemKey(x)
          const isOpen = kids.length > 0 && isOpenKey(key)
          const state = itemState(x)
          const st = machine.item(x)
          // The item's pull request CI rides on the item's own line, after the item's time: a part of that time.
          const ci = x.pr != null ? (l?.ci?.[x.pr] ?? null) : null
          const ciTook = ci === null || ci.start === null ? null : (ci.end ?? Date.now()) - ci.start
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
          const helpers = Svg !== undefined && hostName !== null && x.phase === s.phase && x.name === hostName ? running : []
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
    const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()
    // The item that holds the running helpers: the last item in progress in the current stage, not one named as the stage.
    const hostName =
      [...allItems].reverse().find(x => x.phase === s.phase && x.status === 'now' && !sameName(x.name, s.phases[s.phase] ?? ''))?.name ?? null
    // Each stage is a Card (blocks.tsx): a header Row with its badge, name, time and open control, then its links,
    // items, wait and helpers. The running stage's card carries the accent border.
    const stageRow = (name: string, k: number) => {
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
        id: `stage-${k}`,
        active: stStage === 'running',
        children: [
          B.Row({
            id: `stage-${k}`,
            align: 'center',
            badge: svg(badgeFor(stStage), `${name}: ${word}`, 16, `stage-badge-${k}`, undefined, 16) ?? <Text>{state === 'done' ? '✓' : state === 'now' ? '●' : '○'}</Text>,
            title: <Text weight="semibold" dimColor={state === 'next'}>{name}</Text>,
            meta: [needsWord(stStage, `stage-${k}`), ran !== null && B.Time({ key: `stage-time-${k}`, children: ran })],
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
              {itemCards(allItems.filter(x => x.phase === k && findRef(allItems, x.parent, k, x) === undefined), 0)}
            </Box>
          ),
          k === s.phase && Svg !== undefined && running.length > 0 && hostName === null && (
            <Box key={`helpers-${k}`} flexDirection="column" gap={0} paddingLeft={INDENT} marginTop={1}>
              {running.slice(0, 4).map(x =>
                svg(stripSvg({ title: cap(x.description), detail: x.model, state: 'running', time: age(x.startTime, t) }), `Helper ${x.description}: running`, 22, `strip-${x.id}`),
              )}
              {running.length > 4 && B.Caption({ children: `${running.length - 4} more helpers run.` })}
            </Box>
          ),
        ],
      })
    }
    // A finished stage folds to one line: a flat Card (no visible border, the same width) holding one Row, so its
    // badge, name and time sit exactly where an open card's do. Its met gates sit in the meta column, before the time.
    // The line between stages runs through the row itself: it fills the badge column above and below the badge, and
    // the space after the row sits inside it, so the line never breaks between folded stages.
    const foldedRow = (name: string, k: number, gates: string[], hasMore: boolean, isLast: boolean) => {
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
            gates.length > 0 && B.Caption({ key: `fold-gates-${k}`, color: 'success', children: `✓ ${gates.join(' · ')}` }),
            ran !== null && B.Time({ key: `fold-time-${k}`, children: ran }),
          ],
          control: B.Control({ id: String(k), open: false, onPress: hasMore ? () => void toggle(k) : undefined }),
        }),
      })
    }

    const hypoMark: Record<HypothesisState, string> = { open: '○', testing: '●', 'ruled out': '✕', confirmed: '✓' }
    const hypoColor: Record<HypothesisState, string> = { open: 'subtle', testing: ACCENT_TEXT, 'ruled out': 'subtle', confirmed: 'success' }
    const confirmed = s.hypotheses.find(x => x.state === 'confirmed')
    // The characters a full-width line holds in this pane, at about 7 px for each 12 px character.
    const room = Math.max(20, Math.floor(((e.props.bodyColumns || 50) * 8 - 64) / 7))
    const fit = (text: string) => (text.length > room ? `${text.slice(0, room - 1)}…` : text)

    // Tabs: Progress, then one tab for each runbook the session follows. A press switches the view.
    const runbooks = s.runbooks ?? []
    const tab = await safe(read($, tabAtom), null)
    const book = runbooks.find(r => r.id === tab) ?? null
    // Tabs: Progress, PRs (always), then each runbook or skill the session follows.
    const sessionPrs = l?.sessionPrs ?? []
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
    if (onPrs) {
      const prTabs = (await safe(read($, prTabAtom), {} as Record<string, string>)) ?? {}
      // The PRs tab: every pull request this session made, newest first, as a card that opens to its facts. The tab
      // names the view, so no heading repeats it.
      const word = { merged: 'Merged', open: 'Open', draft: 'Draft', conflict: 'Conflict', closed: 'Closed' } as const
      const ciWord = { running: 'CI running', passing: 'CI passed', failing: 'CI failed', none: 'No CI' } as const
      // CI on the closed row only while it runs (with its time so far) or after it failed; passed CI stays inside the card.
      const ciShort = (p: (typeof sessionPrs)[number]) =>
        p.ci === 'running' ? `CI ${p.ciStart != null ? durationOf(Date.now() - p.ciStart) : ''}`.trim() : p.ci === 'failing' && p.state !== 'merged' ? 'CI failed' : null
      const counts = (['merged', 'open', 'draft', 'conflict', 'closed'] as const)
        .map(st => [st, sessionPrs.filter(p => p.state === st).length] as const)
        .filter(([, n]) => n > 0)
        .map(([st, n]) => `${n} ${word[st].toLowerCase()}`)
        .join('  ·  ')
      return (
        <Box flexDirection="column" gap={1} paddingBottom={1}>
          {tabRow}
          <Text color={SUBTEXT}>{sessionPrs.length === 0 ? 'This session has made no pull request yet.' : counts}</Text>
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
                                children: `${ciWord[p.ci]}${p.ciStart != null ? `  ·  ${durationOf((p.ciEnd ?? Date.now()) - p.ciStart)}` : ''}`,
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
    if (book !== null) {
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
            svg(badgeSvg(x.status === 'done' ? 'done' : x.status === 'now' ? 'now' : 'next', 0, 16), `Step ${k + 1}: ${x.status}`, 16, `${key}-badge`, undefined, 16) ??
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
          {Svg !== undefined && svg(stepsRailSvg(book.steps.map(x => x.status)), `${doneN} of ${m} steps done`, 6, 'runbook-rail')}
          {book.href !== null && linkRow([{ label: 'Open the runbook', href: book.href }], 'runbook-link')}
          <Box flexDirection="column" gap={0}>
            <Text weight="semibold">Steps</Text>
            {book.steps.map((x, k) => stepRow(x, k, `rb-${k}`))}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" alignItems="stretch" gap={2} paddingBottom={1}>
        {tabRow}
        {/* The header: the title; the goal below. */}
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text size="heading" weight="semibold" wrap="wrap">{s.project}</Text>
            </Box>
            {/* How old the agent's last update is; it goes back to 0s with each update. */}
            <Box flexShrink={0}>
              {/* Live while a turn runs; else how long ago the session last did anything the pane saw. */}
              {baseFacts.turnOpen ? (
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
          {s.mayBeOutOfDate === true && <Text color="warning">May be out of date</Text>}
          {s.waitingForAgent === true && <Text color={SUBTEXT}>Waiting for the agent</Text>}
          {(() => {
            const line = updateText((upd ?? null) as never, Date.now())
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
          {/* No line when all is done: the folded cards already say it. Stale: amber is the only stale signal, with the age. */}
          {!isDone && clock - s.at >= STALE_MS && (
            <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
              <Text color="warning" wrap="wrap">{`No update from the agent for ${age(s.at, clock)}.`}</Text>
              <Button key="update-stale" label="Update" onPress={askUpdate} />
            </Box>
          )}
          {readFailed && <Text color="error" wrap="wrap">The pane could not read part of its stored state. It shows the last good view.</Text>}
        </Box>

        {/* The stage bar: one chip per stage in a row that wraps onto more lines when the pane is narrow. The layout
            sizes it, so nothing is measured or guessed: every stage always shows, whole, in order. */}
        {/* The stage bar: one line, always. When the pane is narrow, the chips other than the current one narrow and
            cut their names; the bar never wraps onto a second line. */}
        {B.ChipRow({
          id: 'stage-bar',
          oneLine: true,
          children: s.phases.map((name, k) => {
            const st = stageState(k)
            const isCurrent = !isDone && k === s.phase
            return B.Chip({
              id: `stage-chip-${k}`,
              label: st === 'done' && !isCurrent ? `✓ ${name}` : name,
              tone: isCurrent ? 'on' : st === 'done' ? 'done' : 'quiet',
              shrink: !isCurrent,
            })
          }),
        })}

        {(s.stage === 'fix' || s.stage === 'cause') && s.symptom !== null && (
          <Box flexDirection="column" gap={1}>
            <Box flexDirection="column">
              {small('Symptom')}
              <Text>{s.symptom}</Text>
            </Box>
            {confirmed !== undefined && (
              <Box flexDirection="column">
                {small('Cause', 'success')}
                <Text color="success">{confirmed.text}</Text>
              </Box>
            )}
            {s.stage === 'cause' &&
              s.hypotheses.map((x, k) =>
                B.Row({
                  id: `hypo-${k}`,
                  badge: <Text color={hypoColor[x.state]}>{hypoMark[x.state]}</Text>,
                  title: <Text wrap="wrap" dimColor={x.state === 'ruled out' || x.state === 'open'}>{x.text}</Text>,
                  meta: B.Caption({ color: x.state === 'confirmed' ? 'success' : undefined, children: cap(x.state) }),
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
                    {foldedRow(name, k, exits.map(x => x.when ?? ''), hasMore, isLast)}
                  </Box>,
                )
                return
              }
              rows.push(
                <Box width="100%" flexDirection="column" gap={0} key={`flow-${k}`}>
                  {stageRow(name, k)}
                  {exits.map((exit, j) =>
                    Svg !== undefined
                      ? svg(
                          exitSvg(exit.when ?? '', isLast && j === exits.length - 1, isMet(exit)),
                          isMet(exit) ? `Gate met: ${exit.when}` : `Gate: ${exit.when}`,
                          40,
                          `gate-${k}-${j}`,
                        )
                      : small(`Gate: ${exit.when}`),
                  )}
                  {/* Every card joins the next by a line, gate or no gate. */}
                  {exits.length === 0 && !isLast && (Svg !== undefined ? svg(flowLineSvg(16), 'Line to the next stage', 16, `flow-line-${k}`) : <Box height={1}><Text>{''}</Text></Box>)}
                </Box>,
              )
            })
            return rows
          })()}
        </Box>
      </Box>
    )
}
