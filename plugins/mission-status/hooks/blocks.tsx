import type { ElementConstructor, RenderChildren } from 'claude-code'
import { ACCENT } from './store'
import { pulseWidth, stepPulseSvg, stripSvg } from './bars'
import { cap } from './model'

// The app's own button hover grey, read from the desktop app in dark mode (25 under it becomes 42). The open tab is
// filled with it, and a hover fills the others with it.
const TAB_HOVER = '#2A2A2A'

// The pane's building blocks. Every region of the pane is drawn from these, so every row lines up by construction:
// one badge column, one title column that grows, one meta column on the right (times, CI, the PR chip) and one
// control column (+ or −). The spacing lives here and nowhere else.

// The badge column, in cells. A child item indents by the badge column plus its gap.
export const BADGE = 2
// The control column (+ or −), in cells.
export const CHEV = 3
// The gap between a row's columns, in cells.
export const GAP = 1
// How far a child starts in from its parent's name: the badge column and its gap.
export const INDENT = BADGE + GAP
// The space between sibling items, and between an item's last line and its children.
export const SPACE = 'xs' as const

// Text styles. Subtext reads on dark and light pages (the app's own secondary colour); a note is one step smaller in
// a mid grey; accent text uses the app's purple theme key.
export const SUBTEXT = 'inactive'
export const NOTE = 'rgba(128, 128, 128, 0.75)'
export const ACCENT_TEXT = 'merged'

// A duration reads as one, never like a clock time: 12s, 3m 54s, 1h 02m. A clock time always carries AM or PM.
export function durationOf(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// Chip colours: running work is purple, done work green. The active chip solid purple with white text; a done chip a
// purple tint; a quiet chip grey; a link chip a lighter purple tint with purple ink.
const CHIP = {
  on: { bg: ACCENT, ink: '#FFFFFF' },
  done: { bg: 'rgba(139, 124, 246, 0.22)', ink: '#B7ADFF' },
  quiet: { bg: 'rgba(128, 128, 128, 0.16)', ink: undefined },
  link: { bg: 'rgba(139, 124, 246, 0.18)', ink: '#B7ADFF' },
} as const
export type ChipTone = keyof typeof CHIP

// The desktop draws a border as a hairline, not a cell: a flat card pads exactly as a bordered one does, so its rows
// line up with a bordered card's rows, and it adds no line above or below.

type Els = {
  Box: ElementConstructor<any>
  Text: ElementConstructor<any>
  Button: ElementConstructor<any>
  Link: ElementConstructor<any>
}
// Draws one picture: source, description, height, key, width (pixels). Null on a surface with no pictures.
export type Draw = (source: string, alt: string, height: number, key?: string, width?: number) => RenderChildren

export function blocks(els: Els, draw: Draw) {
  const { Box, Text, Button, Link } = els

  // Caption: small text in the note grey, or in a colour given (a status word, an error).
  const Caption = (p: { children: RenderChildren; color?: string; wrap?: 'wrap' | 'truncate-end'; key?: string; weight?: 'bold' | 'semibold' }) => (
    <Text key={p.key} size="caption" color={p.color ?? NOTE} wrap={p.wrap} weight={p.weight}>
      {p.children}
    </Text>
  )
  // Note: a caption that wraps, under a name. It stops short of the control column, as the name does.
  const Note = (p: { children: RenderChildren; color?: string; key?: string; maxLines?: number }) => (
    <Box key={p.key} paddingRight={CHEV} minWidth={0}>
      <Text size="caption" color={p.color ?? NOTE} wrap="wrap" maxLines={p.maxLines}>
        {p.children}
      </Text>
    </Box>
  )
  // A time in the meta column: always the quiet caption style, running or done.
  const Time = (p: { children: string; color?: string; key?: string }) => <Caption key={p.key} color={p.color}>{p.children}</Caption>

  // Helper: one running helper as a strip with its spinner, and its timer as text beside the strip. The timer stays
  // out of the picture, so the picture's source never changes while the helper runs and its spinner never restarts;
  // the spinner starts at the wall clock's place in its turn, so a rebuild lands on the same angle.
  const Helper = (p: { id: string; description: string; model: string | null; time: string; paddingRight?: number }) => (
    <Box key={`helper-${p.id}`} flexDirection="row" alignItems="center" gap={GAP} paddingRight={p.paddingRight} minWidth={0}>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        {draw(stripSvg({ title: cap(p.description), detail: p.model, state: 'running', now: Date.now() }), `Helper ${p.description}: running`, 22, `strip-${p.id}`)}
      </Box>
      <Time key={`helper-time-${p.id}`}>{p.time}</Time>
    </Box>
  )

  // Shimmer: names that run at the same time, side by side; while they run, a light band sweeps each from left to
  // right, a quarter second later for each name. Each name is sized to its letters, so the gaps match.
  const Shimmer = (p: { id: string; names: readonly string[]; running: boolean }) =>
    ChipRow({
      id: p.id,
      children: p.names.map((name, j) => draw(stepPulseSvg(name, j, p.running, Date.now()), name, 16, `${p.id}-${j}`, pulseWidth(name))),
    })

  // The + or − that opens and closes a card or an item; an empty cell where nothing opens.
  const Control = (p: { id: string; open: boolean; onPress?: () => void }) =>
    p.onPress === undefined ? <Text>{''}</Text> : <Button key={`open-${p.id}`} label={p.open ? '−' : '+'} plain dimColor onPress={p.onPress} />

  // Every block takes the full width of what holds it (width 100%), never only its content's width, so a nested
// row's meta column ends on the same right edge as its parent's, at any depth.
// Row: badge | title (grows) | meta (right-aligned) | control. The badge column stretches to the row's whole height
  // and can carry a line under the badge (the tree's trunk); the body sits under the title, inside the title column,
  // so notes, tabs and children start where the name starts. space: room after the body, inside the stretched row,
  // so a trunk runs through it.
  const Row = (p: {
    id: string
    badge?: RenderChildren
    // Drawn under the badge, filling the rest of the badge column's height.
    rail?: RenderChildren
    title: RenderChildren
    meta?: RenderChildren
    control?: RenderChildren
    body?: RenderChildren
    space?: boolean
    align?: 'center' | 'flex-start'
  }) => (
    <Box key={`row:${p.id}`} width="100%" flexDirection="row" alignItems="stretch" gap={GAP}>
      <Box key={`col:badge:${p.id}`} width={BADGE} flexShrink={0} flexDirection="column">
        {p.badge ?? <Text>{''}</Text>}
        {p.rail}
      </Box>
      <Box key={`col:main:${p.id}`} flexDirection="column" gap={0} flexGrow={1} flexShrink={1} minWidth={0} paddingBottom={p.space === true ? SPACE : 0}>
        <Box width="100%" flexDirection="row" alignItems={p.align ?? 'flex-start'} gap={GAP}>
          <Box key={`col:title:${p.id}`} flexGrow={1} flexShrink={1} minWidth={0}>
            {p.title}
          </Box>
          <Box key={`col:meta:${p.id}`} flexShrink={0} flexDirection="row" justifyContent="flex-end" alignItems="center" gap={GAP}>
            {p.meta}
          </Box>
          <Box key={`col:ctl:${p.id}`} width={CHEV} flexShrink={0} flexDirection="row" justifyContent="flex-end">
            {p.control ?? <Text>{''}</Text>}
          </Box>
        </Box>
        {p.body}
      </Box>
    </Box>
  )

  // Card: a border (the accent while it runs), one cell of padding, a header row and a body. A flat card draws no
  // border and pads as a bordered card does, so a folded stage lines up with an open one and stays one line tall.
  const Card = (p: { id: string; active?: boolean; flat?: boolean; children: RenderChildren }) => (
    p.flat === true ? (
      <Box key={p.id} width="100%" flexDirection="column" gap={0} paddingX={1}>
        {p.children}
      </Box>
    ) : (
      <Box
        key={p.id}
        width="100%"
        flexDirection="column"
        gap={0}
        borderStyle="single"
        borderColor={p.active === true ? ACCENT : 'subtle'}
        borderDimColor={p.active !== true}
        paddingX={1}
      >
        {p.children}
      </Box>
    )
  )

  // Chip: one text row tall, a tinted background with side padding. One shape for every chip on the pane: the stage
  // bar, the tab bar, a pull request card's tabs, link chips. A chip with onPress is a plain button inside the shape;
  // with href, a web link.
  // shrink: the chip may narrow and cut its label when its row runs out of room (a one-line bar).
  const Chip = (p: { id: string; label: string; tone: ChipTone; onPress?: () => void; href?: string; buttonKey?: string; shrink?: boolean }) => {
    const c = CHIP[p.tone]
    const strong = p.tone !== 'quiet'
    return (
      <Box key={`chip:${p.id}`} backgroundColor={c.bg} paddingX={1} flexShrink={p.shrink === true ? 1 : 0} minWidth={p.shrink === true ? 0 : undefined}>
        {p.onPress !== undefined ? (
          <Button key={p.buttonKey ?? p.id} label={p.label} plain dimColor={!strong} onPress={p.onPress} />
        ) : (
          <Text weight={strong ? 'semibold' : undefined} color={c.ink} dimColor={!strong} wrap={p.shrink === true ? 'truncate-end' : undefined}>
            {p.href !== undefined ? <Link href={p.href}>{p.label}</Link> : p.label}
          </Text>
        )}
      </Box>
    )
  }
  // ChipRow: chips side by side, wrapping onto more lines when the pane is narrow; oneLine keeps them on one line,
  // where shrinking chips narrow instead.
  const ChipRow = (p: { id: string; children: RenderChildren; oneLine?: boolean }) => (
    <Box key={p.id} width="100%" flexDirection="row" gap={GAP} flexWrap={p.oneLine === true ? 'nowrap' : 'wrap'} alignItems="center" overflow={p.oneLine === true ? 'hidden' : undefined}>
      {p.children}
    </Box>
  )

  // Tabs: one chip per tab, an icon before each label; the open tab a solid purple chip, the others quiet grey chips
  // that switch the view on a press. The app's own grey button is kept for links that open in Claude itself.
  // Tabs: a tab strip. Each tab is a plain button in a keyed Box whose hover fills a square behind it; the open tab
  // is full strength with an accent underline, the others dim. A drawn hairline under the strip runs the full width
  // (a bordered empty Box draws a box on the desktop, not a line).
  // inset: tabs inside a card; the divider stays within the card's content instead of reaching the pane's edges.
  const Tabs = (p: { id: string; inset?: boolean; tabs: { key: string; label: string; icon: string; on: boolean; onPress: () => void }[] }) => (
    <Box key={p.id} width="100%" flexDirection="column" gap={0}>
      {/* No gap: the tabs' hovers touch. */}
      <Box key={`${p.id}:row`} width="100%" flexDirection="row" flexWrap="wrap" alignItems="flex-end" gap={0}>
        {p.tabs.map(t => {
          // En spaces on each side widen the button, so its hover covers the whole tab: the app's button takes no
          // padding, size or corner setting. Plain spaces may be trimmed.
          const label = `\u2002\u2002${t.icon} ${t.label}\u2002\u2002`
          return (
            <Box key={`tab:${t.key}`} flexShrink={0} flexDirection="column" alignItems="center" backgroundColor={t.on ? TAB_HOVER : undefined} hover={{ backgroundColor: TAB_HOVER }}>
              {/* The open tab is the filled square, so its mark is exactly the tab's width (a drawn underline could
                  only guess the button's width). A square hover fills the other tabs, padding above and below the
                  button included; the app's own rounded highlight still draws on top of the button. */}
              <Box key={`tab-pad:${t.key}`} paddingY="sm">
                <Button key={t.key} label={label} plain dimColor={!t.on} onPress={t.on ? () => undefined : t.onPress} />
              </Box>
            </Box>
          )
        })}
      </Box>
      {/* The divider reaches past the content as far as the app lets the pane draw: the app pads the pane's body and
          clips 8 px beyond the content (a margin of -4 and of -20 both stopped there), so no mod setting reaches the edge. */}
      <Box key={`${p.id}:line`} marginLeft={p.inset ? 0 : -4} marginRight={p.inset ? 0 : -4} flexDirection="column">
        {draw(`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="1"><rect width="100%" height="1" fill="#808080" fill-opacity=".35"/></svg>`, 'Tab divider', 1, `${p.id}:line-svg`)}
      </Box>
    </Box>
  )

  // A line that fills its cell whatever the cell's height: the cell stretches with its row and clips a drawing taller
  // than any row, so a wrapped name, a note or open children never leave a gap and no height is guessed.
  const TALL = 4000
  const Trunk = (p: { id: string; on: boolean; source: (height: number) => string }) => (
    <Box key={p.id} position="relative" overflow="hidden" flexGrow={1} width={BADGE}>
      {p.on && (
        <Box position="absolute" top={0} left={0}>
          {draw(p.source(TALL), 'Wait line', TALL, undefined, 16)}
        </Box>
      )}
    </Box>
  )

  // Tree: siblings in one column, each a Row whose badge column carries the trunk to the next sibling. A stub above
  // and below each badge is its own drawing, so a sibling that comes or goes never restarts a running spinner.
  // Children sit in the row's body, one space below its last line, the same space as between siblings.
  type TreeNode = { id: string; badge: string; alt: string; title: RenderChildren; meta?: RenderChildren; control?: RenderChildren; body?: RenderChildren; fallback?: RenderChildren }
  const Tree = (p: { id: string; nodes: TreeNode[]; line: (height: number) => string; none: string }) => (
    <Box key={p.id} width="100%" flexDirection="column" gap={0}>
      {p.nodes.map((n, i) => {
        const up = i > 0
        const down = i < p.nodes.length - 1
        const pic = draw(n.badge, n.alt, 16, `${n.id}-badge`, 16)
        return Row({
          id: n.id,
          badge:
            pic === null
              ? n.fallback
              : [
                  draw(up ? p.line(2) : p.none, 'Line from the item above', 2, `${n.id}-up`, 16),
                  pic,
                  draw(down ? p.line(2) : p.none, 'Line to the item below', 2, `${n.id}-down`, 16),
                ],
          rail: pic === null ? undefined : Trunk({ id: `${n.id}-line`, on: down, source: p.line }),
          title: n.title,
          meta: n.meta,
          control: n.control,
          body: n.body,
          space: down,
        })
      })}
    </Box>
  )

  return { Row, Card, Chip, ChipRow, Tabs, Tree, Trunk, Control, Caption, Note, Time, Helper, Shimmer }
}
