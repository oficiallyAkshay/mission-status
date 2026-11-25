import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ElementConstructor, ProgressProps, RenderChildren, RenderInput, SvgProps } from 'claude-code'
import type { Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'
import { trackFits, badgeSvg, exitSvg, flowLineSvg, spaceSvg, waitsLineSvg, slideSvg, stripSvg, trackSvg } from './bars'
import { age, cap, clockOf, figureOf, normalize } from './model'
import { prFacts } from './readers'
import type { MergeLive } from './readers'
import { ACCENT } from './store'
import { updateText } from './update-line'
import { setAutoUpdate, updateNow } from './update'
import { openDoc } from './doc'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const live = atom({ plugin: 'mission-status', key: 'live' } as const, null as Live | null, { shape: 'live' })
const now = atom({ plugin: 'mission-status', key: 'now' } as const, 0)
const open = atom({ plugin: 'mission-status', key: 'open' } as const, null as string[] | null)
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
const autoUpdate = atom({ plugin: 'mission-status', key: 'autoUpdate' } as const, null as boolean | null)
const updateState = atom({ plugin: 'mission-status', key: 'updateState' } as const, null as { phase: string; version: string | null; failures: number; at: number } | null)

// Subtext (notes, the status line, the goal): the app's secondary text colour, a theme key, so it reads on dark and
// light pages. A fixed grey cannot: the earlier rgba grey was about 2.4:1 on the light page.
const SUBTEXT = 'inactive'
// Notes under item names: one step smaller, at 75% opacity; a mid grey that reads on dark and light.
const NOTE = 'rgba(128, 128, 128, 0.75)'
// Accent text uses the app's own purple theme key, so it reads on dark and light pages. Borders and drawings keep ACCENT.
const ACCENT_TEXT = 'merged'
// With no update from the agent for this long, the header shows the age in amber.
// Only web addresses open as links; a file:, javascript: or app-scheme address shows as text.
const isWebUrl = (href: string) => /^https?:\/\/[^\s]+$/i.test(href)

// Stage chips when the bar is too narrow: the current stage in the bar's pill purple, done ones tinted, later ones grey.
const PILL_BG = '#7462E8'
const CHIP_BG_DONE = 'rgba(139, 124, 246, 0.22)'
const CHIP_BG_NEXT = 'rgba(128, 128, 128, 0.16)'

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
    const steps = await read($, tasks)
    const upd = await read($, updateState)
    const auto = await read($, autoUpdate)
    // The model's items plus the task list's steps, each in its stage. A step the model also names shows once.
    const allItems: Item[] = [
      ...s.items,
      ...steps
        // A stage the model fills with its own items shows those; the task list fills only stages it leaves empty.
        .filter(x => !s.items.some(y => y.phase === x.phase))
        .filter(x => !s.items.some(y => y.name.toLowerCase() === x.name.toLowerCase()))
        .map(x => ({ phase: x.phase, name: cap(x.name), status: x.status, after: null, parent: null, when: null, since: x.since ?? null }) as Item),
    ]
    // A stage's state. Done only when its phase is past AND every item in it is done: a passed stage with an
    // unfinished item stays in progress, beside the current stage. The current and the active stages are in progress.
    const stageState = (k: number): 'done' | 'now' | 'next' => {
      const unfinished = allItems.some(x => x.phase === k && x.status !== 'done')
      if (k === s.phase || s.active.includes(k)) return 'now'
      if (k < s.phase) return unfinished ? 'now' : 'done'
      return 'next'
    }

    // isInteractive draws the picture in a sandboxed frame, where its <title> tooltips show on hover.
    const svg = (source: string, alt: string, height: number, key?: string, isInteractive?: boolean) =>
      Svg === undefined ? null : <Svg key={key} source={source} alt={alt} height={height > 0 ? height : undefined} isInteractive={isInteractive === true ? true : undefined} />
    const row = (left: RenderChildren, right: RenderChildren, key?: string) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2} key={key}>
        {left}
        {right}
      </Box>
    )
    const small = (text: string, color?: string) => (
      <Text dimColor={color === undefined} color={color}>
        {text}
      </Text>
    )

    const total = s.phases.length
    const isDone = s.phase >= total
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

    // Columns: open control, mark, stage, measure label, figure. The figure column has one width, right-aligned.
    const CHEV = 3
    // The badge column and the gap beside it: names start this far in, and a child indents by the same amount.
    const BADGE = 2
    const INDENT = BADGE + 1
    const MARK = 2
    const FIG = 12
    // What is open follows state: a card or an item in progress opens by itself, and a completed one closes. A press
    // overrides that, but only while the card stays in the state it had at the press; a change of state restores the rule.
    const stateOfKey = (key: string): string => {
      if (key.startsWith('stage-')) return stageState(Number(key.slice(6)))
      if (key.startsWith('item-')) return allItems.find(x => `item-${x.name}` === key)?.status ?? 'next'
      return 'fixed'
    }
    const overrides = ((await read($, open)) ?? []).filter(x => x.includes('@'))
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

    // The figure on a card follows the kind of gate: a status word, x of y, a plain x, or nothing.
    const isMet = (c: Count) =>
      c.text !== undefined ? /^(met|yes|done|approved|merged|passed)$/i.test(c.text) : c.m !== undefined && c.n !== undefined && c.n >= c.m
    const figureCell = (c: Count, isDim: boolean) => {
      if (c.text === undefined && c.n === undefined) return null
      const figure = figureOf(c)
      const change = s.change !== null && s.change.label === c.label ? s.change : null
      const isRecent = change !== null && t - change.at < 10 * 60_000
      if (c.href !== undefined && isWebUrl(c.href))
        return (
          <Text>
            {`${figure} `}
            <Link href={c.href}>{c.hrefLabel ?? 'Open'}</Link>
          </Text>
        )
      // In the first seconds after a change, the new figure slides in over the old one.
      if (change !== null && Date.now() - change.at < 8_000 && Svg !== undefined)
        return svg(slideSvg(change.from, figure, Date.now() - change.at, true), `${c.label}: ${figure}`, 22)
      if (c.text !== undefined)
        // A status word reads as a word, in the colour of its state, not as a large number.
        return (
          <Text weight="semibold" color={isMet(c) ? 'success' : isDim ? undefined : 'warning'} dimColor={isDim && !isMet(c)}>
            {c.text}
          </Text>
        )
      return (
        <Text weight="semibold" dimColor={isDim && !isRecent} color={isRecent ? ACCENT_TEXT : isMet(c) ? 'success' : undefined}>
          {figure}
        </Text>
      )
    }

    const itemMark: Record<ItemStatus, string> = { done: '✓', now: '●', next: '○', failed: '✕' }
    const itemColor: Record<ItemStatus, string> = { done: 'success', now: ACCENT_TEXT, next: 'subtle', failed: 'error' }
    // The items of a stage as a tree: an item that waits for another sits indented under it; items side by side run in parallel.
    // Items are cards, nested to any depth by parent. Siblings in order: an item that waits for another follows it
    // after the other's gate; siblings with no wait between them run in parallel.
    const itemState = (x: Item): 'done' | 'now' | 'next' => (x.status === 'done' ? 'done' : x.status === 'now' ? 'now' : 'next')
    // The item tree, drawn the way tree views draw it. Siblings share one column. A wait is a vertical line in the
    // badge column that joins the two badges, past any note and any child rows between them. Children indent by one
    // step (the badge column plus its gap). Every row carries the rail columns of its ancestors, so lines never break.
    // Link chips on a card. The app opens web links only; a file path shows as its label and path.
    // Link chips on a card: a tinted purple pill with ↗ and the label. Web links open in the browser; a local Markdown
    // file opens in the document pane; any other path shows as plain text.
    const CHIP_BG = 'rgba(139, 124, 246, 0.18)'
    const CHIP_INK = '#B7ADFF'
    const chip = (inner: RenderChildren, key: string) => (
      // One text row tall: a tinted background with side padding; a border would add a row above and below.
      <Box key={key} backgroundColor={CHIP_BG} paddingX={1} flexShrink={0}>
        {inner}
      </Box>
    )
    const linkRow = (links: { label: string; href: string }[], key: string) =>
      links.length === 0 ? null : (
        <Box flexDirection="row" gap={1} flexWrap="wrap" key={key}>
          {links.map((l, k) =>
            isWebUrl(l.href)
              ? chip(
                  <Text color={CHIP_INK} weight="semibold">
                    <Link href={l.href}>{`↗ ${l.label}`}</Link>
                  </Text>,
                  `${key}-${k}`,
                )
              : /\.(md|markdown)$/i.test(l.href) && (l.href.startsWith('/') || l.href.startsWith('~'))
                ? // The same chip as a web link. A native button ignores a child's colour, so the chip holds a Markdown link
                  // the pane answers itself: a press opens the file in the document pane, not in another app.
                  chip(
                    <Markdown
                      key={`doc-${key}-${k}`}
                      text={`[↗ ${l.label.replace(/[[\]]/g, '')}](file://${encodeURI(l.href)})`}
                      onLinkPress={() => void openDoc($, l.label, l.href)}
                    />,
                    `${key}-${k}`,
                  )
                : <Text color={SUBTEXT} key={`${key}-${k}`}>{`${l.label}: ${l.href}`}</Text>,
          )}
        </Box>
      )
    const STEP = BADGE + 1
    // A rail cell: the wait line when on. A space row keeps its height with an empty drawing when no line runs through.
    const railBox = (on: boolean, height: number, key: string, keepHeight = false) => (
      <Box width={STEP} flexShrink={0} key={key}>
        {on && Svg !== undefined
          ? svg(waitsLineSvg(height), 'Wait line', height)
          : keepHeight && Svg !== undefined
            ? svg(spaceSvg(height), 'Space', height)
            : <Text>{''}</Text>}
      </Box>
    )
    const prefix = (rails: boolean[], height: number, key: string) => rails.map((on, i) => railBox(on, height, `${key}-r${i}`))
    const ordered = (list: Item[]) => {
      const out: Item[] = []
      const left = [...list]
      // Each pass takes one item out, so the loop ends; a wait loop falls back to list order.
      while (left.length > 0) {
        const k = left.findIndex(x => x.after === null || !left.some(y => y.name === x.after))
        out.push(...left.splice(k < 0 ? 0 : k, 1))
      }
      return out
    }
    const itemCards = (list: Item[], depth: number, rails: boolean[] = []): RenderChildren => {
      const rows: RenderChildren[] = []
      const order = ordered(list)
      order.forEach((x, i) => {
        const kids = allItems.filter(y => y.parent === x.name && y.phase === x.phase)
        const key = `item-${x.name}`
        const isOpen = kids.length > 0 && isOpenKey(key)
        const state = itemState(x)
        // Siblings share one trunk, as in a tree view: the line joins every badge of the list, top to bottom.
        const down = i < order.length - 1
        const up = i > 0
        rows.push(
          <Box flexDirection="row" alignItems="center" gap={0} key={`${key}-row`}>
            {prefix(rails, 20, `${key}-row`)}
            <Box width={STEP} flexShrink={0}>
              {Svg !== undefined
                ? svg(badgeSvg(state, 0, 16, up, down), `${x.name}: ${state === 'done' ? 'done' : state === 'now' ? 'in progress' : 'not started'}`, 20)
                : <Text color={itemColor[x.status]}>{itemMark[x.status]}</Text>}
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              {/* Body style for every item; the badge carries the state, the colour only steps back for done and later items. */}
              <Text color={state === 'now' ? undefined : SUBTEXT} wrap="wrap">
                {state === 'now' && (x.since ?? null) !== null ? `${x.name}  ·  ${clockOf(Date.now() - (x.since ?? Date.now()))}` : x.name}
              </Text>
            </Box>
            <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              {kids.length > 0 ? (
                <Button key={`open-${key}`} label={isOpen ? '−' : '+'} plain dimColor onPress={() => toggleKey(key)} />
              ) : (
                <Text>{''}</Text>
              )}
            </Box>
          </Box>,
        )
        if ((x.note ?? null) !== null)
          rows.push(
            <Box flexDirection="row" gap={0} key={`${key}-note`}>
              {prefix(rails, 14, `${key}-note`)}
              {railBox(down, 14, `${key}-note-own`)}
              <Box flexGrow={1} flexShrink={1} paddingRight={CHEV}>
                <Text size="caption" color={NOTE} wrap="wrap">{x.note}</Text>
              </Box>
            </Box>,
          )
        const mine = s.links.filter(l => l.item !== null && l.item.toLowerCase() === x.name.toLowerCase())
        if (mine.length > 0)
          rows.push(
            <Box flexDirection="row" gap={0} key={`${key}-links`}>
              {prefix(rails, 20, `${key}-links`)}
              {railBox(down, 20, `${key}-links-own`)}
              {linkRow(mine, `links-${key}`)}
            </Box>,
          )
        if (isOpen && depth < 5) rows.push(itemCards(kids, depth + 1, [...rails, down]))
        // One fixed space between rows; it carries the lines that pass through it.
        if (i < order.length - 1)
          rows.push(
            <Box flexDirection="row" gap={0} key={`${key}-gap`}>
              {prefix(rails, 6, `${key}-gap`)}
              {railBox(down, 6, `${key}-gap-own`, true)}
            </Box>,
          )
      })
      return (
        <Box flexDirection="column" gap={0} key={`list-${depth}-${rails.length}-${order[0]?.name ?? ''}`}>
          {rows}
        </Box>
      )
    }
    const itemTree = (k: number) => (
      // A stage's items are its children: they start where the stage name starts, as nested items start under theirs.
      <Box flexDirection="column" gap={0} paddingLeft={INDENT} marginTop={1}>
        {itemCards(allItems.filter(x => x.phase === k && (x.parent === null || !allItems.some(y => y.name === x.parent && y.phase === k))), 0)}
      </Box>
    )

    // Each stage is a card: a status badge, the stage name over its measure, the figure large on the right, and an
    // open control when the stage has items. The current stage's card carries the accent border.
    const stageRow = (name: string, k: number) => {
      // One stage is in progress at a time: the current one.
      const state = stageState(k)
      const mine = measures.filter(c => c.phase === k && c.m !== 0)
      const hasItems = allItems.some(x => x.phase === k)
      // A done stage can fold back to its one line, items or not.
      const canFold = hasItems || state === 'done'
      const isOpen = canFold && opened.includes(k)
      const isDim = state === 'next'
        return (
        <Box
          flexDirection="column"
          gap={0}
          key={`stage-${k}`}
          borderStyle="single"
          borderColor={state === 'now' ? ACCENT : 'subtle'}
          borderDimColor={state !== 'now'}
          paddingX={1}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={BADGE} flexShrink={0}>
              {Svg !== undefined ? svg(badgeSvg(state, 0, 16), `${name}: ${state === 'done' ? 'done' : state === 'now' ? 'in progress' : 'not started'}`, 16) : <Text>{state === 'done' ? '✓' : state === 'now' ? '●' : '○'}</Text>}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text weight="semibold" dimColor={isDim}>{name}</Text>
              </Box>
            </Box>
            <Box flexShrink={0} width={FIG} flexDirection="row" justifyContent="flex-end">
              {(() => {
                // The time on the stage: live on the current one, the time taken on a done one, nothing ahead.
                const from = s.starts?.[k] ?? null
                const to = state === 'done' ? (s.ends?.[k] ?? null) : state === 'now' ? Date.now() : null
                if (from === null || to === null) return <Text>{''}</Text>
                return (
                  <Text weight="semibold" color={state === 'now' ? ACCENT_TEXT : undefined} dimColor={state === 'done'}>
                    {clockOf(to - from)}
                  </Text>
                )
              })()}
            </Box>
            <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              {canFold ? (
                <Button key={`open-${k}`} label={isOpen ? '−' : '+'} plain dimColor onPress={() => toggle(k)} />
              ) : (
                <Text>{''}</Text>
              )}
            </Box>
          </Box>
          {(() => {
            const mine = s.links.filter(l => l.phase === k && l.item === null)
            return mine.length === 0 ? null : <Box paddingLeft={INDENT}>{linkRow(mine, `links-stage-${k}`)}</Box>
          })()}
          {isOpen && itemTree(k)}
          {state === 'now' &&
            s.waitingOn !== null && (
              <Box marginTop={1} borderStyle="single" borderColor="warning" paddingX={1}>
                <Text color="warning" wrap="wrap">
                  {`Waiting on ${s.waitingOn.charAt(0).toLowerCase()}${s.waitingOn.slice(1)}`}
                  <Text dimColor>{`  ·  ${age(s.waitingSince, t)}`}</Text>
                </Text>
              </Box>
            )}
          {state === 'now' && Svg !== undefined && running.length > 0 && (
            <Box flexDirection="column" gap={0} paddingLeft={INDENT} marginTop={1}>
              {running.slice(0, 4).map(x =>
                svg(
                  stripSvg({ title: cap(x.description), detail: x.model, state: 'running', time: age(x.startTime, t) }),
                  `Helper ${x.description}: running`,
                  22,
                  `strip-${x.id}`,
                ),
              )}
              {running.length > 4 && small(`${running.length - 4} more helpers run.`)}
            </Box>
          )}
        </Box>
      )
    }

    const hypoMark: Record<HypothesisState, string> = { open: '○', testing: '●', 'ruled out': '✕', confirmed: '✓' }
    const hypoColor: Record<HypothesisState, string> = { open: 'subtle', testing: ACCENT_TEXT, 'ruled out': 'subtle', confirmed: 'success' }
    const confirmed = s.hypotheses.find(x => x.state === 'confirmed')
    // The characters a full-width line holds in this pane, at about 7 px for each 12 px character.
    const room = Math.max(20, Math.floor(((e.props.bodyColumns || 50) * 8 - 64) / 7))
    const fit = (text: string) => (text.length > room ? `${text.slice(0, room - 1)}…` : text)

    // Tooltips on the stage bar: for each stage, its state, its time and its gate.
    // Tooltips on the stage bar: state, the time a done stage took, and the clause. Nothing in them changes each
    // second, so the drawing stays the same between redraws and does not flicker.
    const tips = s.phases.map((name, k) => {
      const isNow = stageState(k) === 'now'
      const from = s.starts?.[k] ?? null
      const to = !isNow && k < s.phase ? (s.ends?.[k] ?? null) : null
      const exit = measures.find(c => c.phase === k && c.when !== undefined)
      const state = isNow ? 'In progress' : stageState(k) === 'done' ? 'Done' : 'Not started'
      return [
        `${name}: ${state}${from !== null && to !== null ? `, took ${clockOf(to - from)}` : ''}.`,
        exit !== undefined ? `Gate: ${exit.when}` : '',
      ].filter(Boolean).join(' ')
    })
    const barInput = { total, done: Math.min(s.phase, total), current, isDone, clock: 0, names: s.phases, tips, checks: s.phases.map((_, k) => stageState(k) === 'done'), widthPx: Math.max(160, (e.props.bodyColumns || 50) * 8 - 32) }
    const barFits = Svg === undefined || trackFits(barInput)
    // The git bar: one line, closed by default; open, it lists the facts behind the line.
    const g = l?.git ?? null
    const isGitOpen = isOpenKey('git')
    // Merge state: done once the pull request merges, in progress while one is open or work is committed, else ahead.
    const mergeState: 'done' | 'now' | 'next' =
      prs[0]?.state === 'MERGED' ? 'done' : prs[0]?.state === 'OPEN' || (g !== null && g.ahead > 0) ? 'now' : 'next'
    // The GitHub read: a missing or signed-out CLI says so once; a failed read keeps the last pull requests and says
    // when the next try runs.
    const merge = l?.merge
    const retryIn = (at: number) => {
      const min = Math.ceil((at - clock) / 60_000)
      return min <= 1 ? 'under 1 min' : `${min} min`
    }
    const ghLine =
      merge?.gh === 'missing' ? (
        <Text color={SUBTEXT} wrap="wrap">Pull request state needs the GitHub CLI.</Text>
      ) : merge?.gh === 'failed' || (merge === undefined && l?.prsUnread === true) ? (
        <Text color="warning" wrap="wrap">
          {`Pull request read failed${prs.length > 0 ? '; this shows the last good read' : ''}. Next try in ${retryIn(merge?.nextGhAt ?? 0)}.`}
        </Text>
      ) : null
    // With no repository (git missing, or the folder is not a git repository) the card does not show.
    const gitBar =
      g === null && prs.length === 0 ? null : (
        // Merge is a stage card like the others: a badge for its state, its name, its facts as the subline.
        <Box
          flexDirection="column"
          gap={0}
          borderStyle="single"
          borderColor={mergeState === 'now' ? ACCENT : 'subtle'}
          borderDimColor={mergeState !== 'now'}
          paddingX={1}
        >
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={BADGE} flexShrink={0}>
              {Svg !== undefined
                ? svg(badgeSvg(mergeState, 0, 16), `Merge: ${mergeState === 'done' ? 'done' : mergeState === 'now' ? 'in progress' : 'not started'}`, 16)
                : <Text>{mergeState === 'done' ? '✓' : mergeState === 'now' ? '●' : '○'}</Text>}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text weight="semibold" dimColor={mergeState === 'next'}>Merge</Text>
              <Box flexDirection="row" gap={2}>
                {prFacts(prs[0], g).map((f, k) => (
                  <Text key={`gf-${k}`} color={f.tone === 'dim' ? undefined : f.tone} dimColor={f.tone === 'dim'}>
                    {f.text}
                  </Text>
                ))}
              </Box>
              {ghLine}
            </Box>
            <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              <Button key="open-git" label={isGitOpen ? '−' : '+'} plain dimColor onPress={() => toggleKey('git')} />
            </Box>
          </Box>
          {isGitOpen && (
            <Box flexDirection="column" gap={0} marginTop={1} paddingLeft={INDENT}>
              {g !== null && (
                <Box flexDirection="row" gap={2}>
                  <Box flexShrink={0}>{small('Branch')}</Box>
                  <Box flexGrow={1} flexShrink={1} flexDirection="row" justifyContent="flex-end">
                    <Text dimColor wrap="truncate-middle">{g.branch}</Text>
                  </Box>
                </Box>
              )}
              {g !== null && row(small('Commits ahead of main'), small(`${g.ahead}`))}
              {g !== null && row(small('Commits behind main'), small(`${g.behind ?? 0}`, (g.behind ?? 0) > 0 ? 'warning' : undefined))}
              {g !== null && g.files > 0 && row(small('Files changed'), small(`${g.files}`))}
              {g !== null && g.added + g.removed > 0 && row(small('Lines'), small(`+${g.added} −${g.removed}`))}
              {g !== null && g.dirty > 0 && row(small('Files not committed'), small(`${g.dirty}`, 'warning'))}
              {prs.map(p =>
                row(
                  <Text>
                    <Link href={`${p.url}/files`}>{`#${p.number}`}</Link>
                    {`  ${p.title}`}
                  </Text>,
                  small(p.state === 'MERGED' ? 'Merged' : p.state === 'CLOSED' ? 'Closed' : 'Open'),
                  `git-pr-${p.number}`,
                ),
              )}
            </Box>
          )}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={2} paddingBottom={1}>
        {/* The header: the title; the goal below. */}
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text size="heading" weight="semibold" wrap="wrap">{`Project: ${s.project}`}</Text>
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
          {isDone ? (
            <Text color="success" wrap="wrap">
              {`All ${total} stages are done.`}
              {(() => {
                const from = s.starts?.[0] ?? null
                const to = s.ends?.[total - 1] ?? null
                return from !== null && to !== null && to >= from ? <Text color={SUBTEXT}>{`  ·  took ${clockOf(to - from)}`}</Text> : null
              })()}
            </Text>
          ) : (
            // Stale: amber is the only stale signal, with the age.
            clock - s.at >= STALE_MS && (
              <Text color="warning" wrap="wrap">{`No update from the agent for ${age(s.at, clock)}. Press Update to ask for one.`}</Text>
            )
          )}
          {readFailed && <Text color="error" wrap="wrap">The pane could not read part of its stored state. It shows the last good view.</Text>}
        </Box>

        {(() => {
          // The bar while every stage name fits; when the pane is too narrow, the stages flow as chips onto more lines.
          if (barFits) return null
          return (
            <Box flexDirection="row" flexWrap="wrap" gap={1} key="stage-chips">
              {s.phases.map((name, k) => {
                const state = stageState(k)
                const isCurrent = !isDone && k === s.phase
                return (
                  <Box key={`chip-${k}`} backgroundColor={isCurrent ? PILL_BG : state === 'done' ? CHIP_BG_DONE : CHIP_BG_NEXT} paddingX={1} flexShrink={0}>
                    <Text weight={isCurrent ? 'semibold' : undefined} color={isCurrent ? '#FFFFFF' : state === 'now' ? ACCENT_TEXT : state === 'done' ? undefined : SUBTEXT}>
                      {state === 'done' ? `✓ ${name}` : name}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          )
        })()}
        {!barFits
          ? null
          : Svg !== undefined
          ? svg(
              trackSvg(barInput),
              isDone ? 'All stages are done.' : `Stage ${s.phase + 1} of ${total}: ${current}`,
              30,
              'stage-bar',
              true,
            )
          : Progress !== undefined
            ? <Progress label="Stages" value={Math.min(s.phase, total)} max={total} valueText={`${Math.min(s.phase, total)} of ${total}`} color="success" />
            : null}

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
              s.hypotheses.map((x, k) => (
                <Box flexDirection="row" key={`hypo-${k}`}>
                  <Box width={MARK} flexShrink={0}>
                    <Text color={hypoColor[x.state]}>{hypoMark[x.state]}</Text>
                  </Box>
                  <Box flexGrow={1}>
                    {row(
                      <Text dimColor={x.state === 'ruled out' || x.state === 'open'}>{x.text}</Text>,
                      small(cap(x.state), x.state === 'confirmed' ? 'success' : undefined),
                    )}
                  </Box>
                </Box>
              ))}
          </Box>
        )}

        <Box flexDirection="column" gap={0}>
          {(() => {
            // The Merge card stands in the flow before the Deploy stage (a pull request merges, then it ships); with
            // no Deploy stage it closes the flow. It carries no gate of its own: the card already shows the merge state.
            const deployAt = s.phases.findIndex(n => /deploy|release|ship/i.test(n))
            const mergeAt = gitBar === null ? -1 : deployAt >= 0 ? deployAt : s.phases.length
            const rows: RenderChildren[] = []
            s.phases.forEach((name, k) => {
              if (k === mergeAt) {
                rows.push(<Box flexDirection="column" key="flow-merge">{gitBar}</Box>)
                if (Svg !== undefined) rows.push(svg(flowLineSvg(16), 'Line to the next stage', 16, 'merge-line'))
              }
              // A stage may have several gates: each draws its own chip on the line, one under another.
              const exits = measures.filter(c => c.phase === k && c.when !== undefined)
              const isLast = k === s.phases.length - 1 && mergeAt !== s.phases.length
              const met = stageState(k) === 'done'
              // A finished stage whose gates are all met folds to one line: its badge, name, gates and time. The
              // person's + opens the full card again.
              const hasMore = allItems.some(x => x.phase === k) || s.links.some(l => l.phase === k)
              if (met && !opened.includes(k)) {
                const from = s.starts?.[k] ?? null
                const to = s.ends?.[k] ?? null
                rows.push(
                  <Box flexDirection="column" gap={0} key={`flow-${k}`}>
                    <Box flexDirection="row" alignItems="center" gap={1} paddingX={1}>
                      <Box width={BADGE} flexShrink={0}>
                        {Svg !== undefined ? svg(badgeSvg('done', 0, 14), `${name}: done`, 14) : <Text color="success">✓</Text>}
                      </Box>
                      <Text dimColor>{name}</Text>
                      {exits.length > 0 && <Text color="success" size="caption">{`✓ ${exits.map(x => x.when).join(' · ')}`}</Text>}
                      <Box flexGrow={1}><Text>{''}</Text></Box>
                      {from !== null && to !== null && to >= from && <Text dimColor size="caption">{clockOf(to - from)}</Text>}
                      <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
                        {hasMore ? <Button key={`open-${k}`} label="+" plain dimColor onPress={() => toggle(k)} /> : <Text>{''}</Text>}
                      </Box>
                    </Box>
                    {!isLast && Svg !== undefined && svg(flowLineSvg(8), 'Line to the next stage', 8, `fold-line-${k}`)}
                  </Box>,
                )
                return
              }
              rows.push(
                <Box flexDirection="column" gap={0} key={`flow-${k}`}>
                  {stageRow(name, k)}
                  {exits.map((exit, j) =>
                    Svg !== undefined
                      ? svg(
                          exitSvg(exit.when ?? '', isLast && j === exits.length - 1, met || isMet(exit)),
                          met || isMet(exit) ? `Gate met: ${exit.when}` : `Gate: ${exit.when}`,
                          40,
                          `gate-${k}-${j}`,
                        )
                      : small(`Gate: ${exit.when}`),
                  )}
                  {exits.length === 0 && !isLast && <Box height={1}><Text>{''}</Text></Box>}
                </Box>,
              )
            })
            if (mergeAt === s.phases.length) rows.push(<Box flexDirection="column" key="flow-merge">{gitBar}</Box>)
            return rows
          })()}
        </Box>
      </Box>
    )
}
