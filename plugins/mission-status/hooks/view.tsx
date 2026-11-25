import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ElementConstructor, ProgressProps, RenderChildren, RenderInput, SvgProps } from 'claude-code'
import type { Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'
import { badgeSvg, exitSvg, waitsArrowSvg, slideSvg, stripSvg, trackSvg } from './bars'
import { age, cap, clockOf, figureOf, normalize, secondsOf } from './model'
import { prFacts } from './readers'
import { ACCENT } from './store'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const activity = atom({ plugin: 'mission-status', key: 'activity' } as const, null as Activity)
const live = atom({ plugin: 'mission-status', key: 'live' } as const, null as Live | null, { shape: 'live' })
const now = atom({ plugin: 'mission-status', key: 'now' } as const, 0)
const open = atom({ plugin: 'mission-status', key: 'open' } as const, null as string[] | null)
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])

export async function renderPane($: EngineInterface, e: Extract<RenderInput, { component: 'Pane' }>) {
    const ui = $.ui.resolve(e)
    const { Box, Text, Link, Button } = ui
    // Svg draws the bars; Progress stands in where Svg is missing, and a surface with neither shows the figures only.
    const extra = ui as unknown as { Progress?: ElementConstructor<ProgressProps>; Svg?: ElementConstructor<SvgProps> }
    const { Progress, Svg } = extra
    const s = normalize(await read($, summary))
    const l = await read($, live)
    const t = Math.max(await read($, now), s?.at ?? 0, l?.at ?? 0)

    // The Update button asks the model for a fresh state: it starts a turn, as a message from the person would.
    const askUpdate = () =>
      void $.prompt
        .submit({ text: 'Update the progress pane: look again at the stages and the work, then send the whole state.' })
        .catch(() => undefined)
    const { Button: UpdateButton } = $.ui.resolve(e)
    if (s === null)
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>The pane has no progress data yet.</Text>
          <UpdateButton key="update-empty" label="Update" variant="primary" onPress={askUpdate} />
        </Box>
      )
    const steps = await read($, tasks)
    // The model's items plus the task list's steps, each in its stage. A step the model also names shows once.
    const allItems: Item[] = [
      ...s.items,
      ...steps
        // A stage the model fills with its own items shows those; the task list fills only stages it leaves empty.
        .filter(x => !s.items.some(y => y.phase === x.phase))
        .filter(x => !s.items.some(y => y.name.toLowerCase() === x.name.toLowerCase()))
        .map(x => ({ phase: x.phase, name: cap(x.name), status: x.status, after: null, parent: null, when: null }) as Item),
    ]

    // isInteractive draws the picture in a sandboxed frame, where its <title> tooltips show on hover.
    const svg = (source: string, alt: string, height: number, key?: string, isInteractive?: boolean) =>
      Svg === undefined ? null : <Svg key={key} source={source} alt={alt} height={height} isInteractive={isInteractive === true ? true : undefined} />
    const row = (left: RenderChildren, right: RenderChildren, key?: string) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2} key={key}>
        {left}
        {right}
      </Box>
    )
    const small = (text: string, color?: string) => (
      <Text size="caption" dimColor={color === undefined} color={color}>
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
    // Subtext (notes, the status line): a slightly transparent mid gray that reads on dark and light.
    const SUBTEXT = 'rgba(150, 148, 160, 0.78)'
    const INDENT = BADGE + 1
    const MARK = 2
    const FIG = 12
    // What is open, by key: a stage by its index, an item by its name. By default every stage and item in progress.
    const defaultOpen = [
      `stage-${s.phase}`,
      ...allItems.filter(x => x.status === 'now').map(x => `item-${x.name}`),
    ]
    const openList = (await read($, open)) ?? defaultOpen
    const opened = s.phases.map((_, k) => k).filter(k => openList.includes(`stage-${k}`))
    const isOpenKey = (key: string) => openList.includes(key)
    const toggleKey = (key: string) =>
      update($, open, list => {
        const now = list ?? defaultOpen
        return now.includes(key) ? now.filter(x => x !== key) : [...now, key]
      })
    const toggle = (k: number) => toggleKey(`stage-${k}`)

    // The figure on a card follows the kind of exit clause: a status word, x of y, a plain x, or nothing.
    const isMet = (c: Count) =>
      c.text !== undefined ? /^(met|yes|done|approved|merged|passed)$/i.test(c.text) : c.m !== undefined && c.n !== undefined && c.n >= c.m
    const figureCell = (c: Count, isDim: boolean) => {
      if (c.text === undefined && c.n === undefined) return null
      const figure = figureOf(c)
      const change = s.change !== null && s.change.label === c.label ? s.change : null
      const isRecent = change !== null && t - change.at < 10 * 60_000
      if (c.href !== undefined)
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
        <Text size="heading" weight="semibold" dimColor={isDim && !isRecent} color={isRecent ? ACCENT : isMet(c) ? 'success' : undefined}>
          {figure}
        </Text>
      )
    }

    const itemMark: Record<ItemStatus, string> = { done: '✓', now: '●', next: '○', failed: '✕' }
    const itemColor: Record<ItemStatus, string> = { done: 'success', now: ACCENT, next: 'subtle', failed: 'error' }
    // The items of a stage as a tree: an item that waits for another sits indented under it; items side by side run in parallel.
    // Items are cards, nested to any depth by parent. Siblings in order: an item that waits for another follows it
    // after the other's gate; siblings with no wait between them run in parallel.
    const itemState = (x: Item): 'done' | 'now' | 'next' => (x.status === 'done' ? 'done' : x.status === 'now' ? 'now' : 'next')
    const orderSiblings = (list: Item[]) => {
      const out: Item[] = []
      const left = [...list]
      let guard = 0
      while (left.length > 0 && guard++ < 64) {
        const k = left.findIndex(x => x.after === null || !left.some(y => y.name === x.after))
        out.push(...left.splice(k < 0 ? 0 : k, 1))
      }
      return out
    }
    // One item: its row, its children when open, and its gate. Items that wait for it follow, indented under it.
    // Link chips on a card. A plain file path opens as a file link.
    const linkRow = (links: { label: string; href: string }[], key: string) =>
      links.length === 0 ? null : (
        <Box flexDirection="row" gap={2} key={key}>
          {links.map((l, k) => (
            <Text size="caption" key={`${key}-${k}`}>
              <Link href={l.href.startsWith('/') ? `file://${l.href}` : l.href}>{`↗ ${l.label}`}</Link>
            </Text>
          ))}
        </Box>
      )
    const itemCards = (list: Item[], depth: number): RenderChildren => {
      const names = new Set(list.map(x => x.name))
      const roots = list.filter(x => x.after === null || !names.has(x.after))
      // Running in parallel: items in progress at the same time among these siblings.
      const running = list.filter(x => x.status === 'now').length
      const row1 = (x: Item, waits: number): RenderChildren => {
        const kids = allItems.filter(y => y.parent === x.name && y.phase === x.phase)
        const key = `item-${x.name}`
        const isOpen = kids.length > 0 && isOpenKey(key)
        const state = itemState(x)
        const exit: Count | null = x.when === null ? null : { label: x.name, when: x.when, n: x.n, m: x.m, text: x.text }
        const followers = list.filter(y => y.after === x.name)
        return (
          <Box flexDirection="column" gap={0} key={key}>
            <Box flexDirection="row" alignItems="center" gap={1}>
              {waits > 0 && (
                <Box width={BADGE} flexShrink={0}>
                  {Svg !== undefined ? svg(waitsArrowSvg('#8B8A85'), `${x.name} waits for ${x.after ?? 'the item above'}.`, 18) : <Text dimColor>└</Text>}
                </Box>
              )}
              <Box width={BADGE} flexShrink={0}>
                {Svg !== undefined
                  ? svg(badgeSvg(state, 0, 16), `${x.name}: ${state === 'done' ? 'done' : state === 'now' ? 'in progress' : 'not started'}`, 16)
                  : <Text color={itemColor[x.status]}>{itemMark[x.status]}</Text>}
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text weight={state === 'now' ? 'semibold' : 'regular'} dimColor={state === 'done'} color={state === 'next' ? 'subtle' : undefined} wrap="wrap">
                  {x.name}
                </Text>
                {(x.note ?? null) !== null && (
                  <Text size="caption" color={SUBTEXT} wrap="wrap">
                    {x.note}
                  </Text>
                )}
              </Box>
              {kids.length > 0 && (
                <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
                  <Button key={`open-${key}`} label={isOpen ? '−' : '+'} plain dimColor onPress={() => toggleKey(key)} />
                </Box>
              )}
            </Box>
            {(() => {
              const mine = s.links.filter(l => l.item !== null && l.item.toLowerCase() === x.name.toLowerCase())
              return mine.length === 0 ? null : <Box paddingLeft={INDENT}>{linkRow(mine, `links-${key}`)}</Box>
            })()}
            {isOpen && depth < 5 && <Box paddingLeft={BADGE}>{itemCards(kids, depth + 1)}</Box>}
            {exit !== null && Svg !== undefined && svg(exitSvg(exit.when ?? '', followers.length === 0), `Done when ${exit.when}.`, 28)}
            {followers.length > 0 && waits < 6 && (
              <Box flexDirection="column" gap={0} paddingLeft={waits > 0 ? 1 : 0}>
                {followers.map(y => row1(y, waits + 1))}
              </Box>
            )}
          </Box>
        )
      }
      return (
        <Box flexDirection="column" gap={0}>
          {running > 1 && small(`${running} items run in parallel.`)}
          {roots.map(x => row1(x, 0))}
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
      const state = k < s.phase && !s.active.includes(k) ? 'done' : k === s.phase || s.active.includes(k) ? 'now' : 'next'
      const mine = measures.filter(c => c.phase === k && c.m !== 0)
      const hasItems = allItems.some(x => x.phase === k)
      const isOpen = hasItems && opened.includes(k)
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
              {Svg !== undefined ? svg(badgeSvg(state, 0), `${name}: ${state === 'done' ? 'done' : state === 'now' ? 'in progress' : 'not started'}`, 20) : <Text>{state === 'done' ? '✓' : state === 'now' ? '●' : '○'}</Text>}
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
                  <Text weight="semibold" color={state === 'now' ? ACCENT : undefined} dimColor={state === 'done'}>
                    {clockOf(to - from)}
                  </Text>
                )
              })()}
            </Box>
            <Box width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
              {hasItems ? (
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
          {state === 'now' && act !== null && Date.now() - act.at < 30 * 60_000 && (
            // The live line has the card's full width and ends in an ellipsis when it is too long.
            <Box paddingLeft={INDENT} paddingRight={1}>
              {/* Always text, at one size: a drawn slide used a smaller font than the text after it. */}
              <Text color={SUBTEXT} wrap="truncate-end">{`${act.text}  ${secondsOf(Date.now() - act.at)}`}</Text>
            </Box>
          )}
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
    const hypoColor: Record<HypothesisState, string> = { open: 'subtle', testing: ACCENT, 'ruled out': 'subtle', confirmed: 'success' }
    const confirmed = s.hypotheses.find(x => x.state === 'confirmed')
    const act = await read($, activity)
    // The characters a full-width line holds in this pane, at about 7 px for each 12 px character.
    const room = Math.max(20, Math.floor(((e.props.bodyColumns || 50) * 8 - 64) / 7))
    const fit = (text: string) => (text.length > room ? `${text.slice(0, room - 1)}…` : text)

    // Tooltips on the stage bar: for each stage, its state, its time and its exit clause.
    // Tooltips on the stage bar: state, the time a done stage took, and the clause. Nothing in them changes each
    // second, so the drawing stays the same between redraws and does not flicker.
    const tips = s.phases.map((name, k) => {
      const isNow = k === s.phase || s.active.includes(k)
      const from = s.starts?.[k] ?? null
      const to = !isNow && k < s.phase ? (s.ends?.[k] ?? null) : null
      const exit = measures.find(c => c.phase === k && c.when !== undefined)
      const state = isNow ? 'In progress' : k < s.phase ? 'Done' : 'Not started'
      return [
        `${name}: ${state}${from !== null && to !== null ? `, took ${clockOf(to - from)}` : ''}.`,
        exit !== undefined ? `Done when ${exit.when}.` : '',
      ].filter(Boolean).join(' ')
    })
    // The git bar: one line, closed by default; open, it lists the facts behind the line.
    const g = l?.git ?? null
    const isGitOpen = isOpenKey('git')
    // Merge state: done once the pull request merges, in progress while one is open or work is committed, else ahead.
    const mergeState: 'done' | 'now' | 'next' =
      prs[0]?.state === 'MERGED' ? 'done' : prs[0]?.state === 'OPEN' || (g !== null && g.ahead > 0) ? 'now' : 'next'
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
                ? svg(badgeSvg(mergeState, 0), `Merge: ${mergeState === 'done' ? 'done' : mergeState === 'now' ? 'in progress' : 'not started'}`, 20)
                : <Text>{mergeState === 'done' ? '✓' : mergeState === 'now' ? '●' : '○'}</Text>}
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Text weight="semibold" dimColor={mergeState === 'next'}>Merge</Text>
              <Box flexDirection="row" gap={2}>
                {prFacts(prs[0], g).map((f, k) => (
                  <Text key={`gf-${k}`} size="caption" color={f.tone === 'dim' ? undefined : f.tone} dimColor={f.tone === 'dim'}>
                    {f.text}
                  </Text>
                ))}
              </Box>
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
                    <Text size="caption" dimColor wrap="truncate-middle">{g.branch}</Text>
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
                  <Text size="caption">
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
      <Box flexDirection="column" gap={2}>
        {/* The header: the title and the Update button share one centred row; the goal sits one line below it. */}
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
            <Box flexGrow={1} flexShrink={1}>
              <Text size="heading" weight="semibold" wrap="truncate-end">{`Project: ${s.project}`}</Text>
            </Box>
            <Box flexShrink={0}>
              <UpdateButton key="update" label="Update" variant="secondary" onPress={askUpdate} />
            </Box>
          </Box>
          {s.ticket !== null && (
            <Text>
              {s.ticket.url !== null ? <Link href={s.ticket.url}>{s.ticket.ref}</Link> : s.ticket.ref}
              {s.ticket.title !== null ? <Text dimColor>{`  ${s.ticket.title}`}</Text> : null}
            </Text>
          )}
          {s.goalLine !== null && <Text dimColor>{s.goalLine}</Text>}
        </Box>

        {Svg !== undefined
          ? svg(
              trackSvg({ total, done: Math.min(s.phase, total), current, isDone, clock: 0, names: s.phases, tips }),
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
          {s.phases.map((name, k) => {
            const exit = measures.find(c => c.phase === k && c.when !== undefined) ?? null
            const isLast = k === s.phases.length - 1 && gitBar === null
            return (
              <Box flexDirection="column" gap={0} key={`flow-${k}`}>
                {stageRow(name, k)}
                {exit !== null &&
                  (Svg !== undefined
                    ? svg(
                        exitSvg(exit.when ?? '', isLast),
                        `Done when ${exit.when}.`,
                        28,
                      )
                    : small(`Done when ${exit.when}.`))}
                {exit === null && !isLast && <Box height={1}><Text>{''}</Text></Box>}
              </Box>
            )
          })}
          {gitBar}
          {gitBar !== null && Svg !== undefined && svg(exitSvg('the pull request merges', true), 'Done when the pull request merges.', 28)}
        </Box>
      </Box>
    )
}
