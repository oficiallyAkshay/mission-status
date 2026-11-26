import { expect, mock, test } from 'claude-code/testing'

// The layout contract of the pane's building blocks (hooks/blocks.tsx): every row has the same badge and control
// columns, every time sits in a row's meta column, and every time ends on one right edge, whatever region holds it.

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  requestId: 'progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const start = async ($: any, on: any) => {
  const clock = mock.clock(on, { now: Date.now() })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 'turn-1' } as never)
  return clock
}
const send = ($: any, args: Record<string, unknown>) => $.tool.call({ tool: 'mcp__mission-status__update', ...args } as never)

type Node = { type: string; key?: string; props: Record<string, any>; children: unknown[] }
const asNode = (x: unknown): Node | null => {
  if (x === null || typeof x !== 'object' || typeof (x as any).type !== 'string') return null
  const props = ((x as any).props ?? {}) as Record<string, any>
  const raw = (x as any).children ?? props.children ?? []
  const children = (Array.isArray(raw) ? raw : [raw]).flat(Infinity)
  return { type: (x as any).type, key: props.key ?? (x as any).key, props, children }
}
// Each drawn element becomes one Node, made once, so a parent's children are the same objects a path holds.
const made = new WeakMap<object, Node>()
const nodeOf = (x: unknown): Node | null => {
  if (x === null || typeof x !== 'object') return null
  const hit = made.get(x)
  if (hit !== undefined) return hit
  const n = asNode(x)
  if (n !== null) made.set(x, n)
  return n
}
const kidsOf = (n: Node) => n.children.map(nodeOf).filter((x): x is Node => x !== null)
const textOf = (n: Node): string => n.children.map(c => (typeof c === 'string' ? c : nodeOf(c) ? textOf(nodeOf(c) as Node) : '')).join('')
// Every element with the path from the root to it.
const walk = (n: Node, path: Node[] = [], out: { node: Node; path: Node[] }[] = []) => {
  out.push({ node: n, path: [...path, n] })
  for (const k of kidsOf(n)) walk(k, [...path, n], out)
  return out
}
const cells = (v: unknown) => (typeof v === 'number' ? v : v === undefined ? 0 : 1)
// How far an element's right edge sits from the pane's right edge, in cells: the borders and right padding of every
// box around it, and in each row the fixed widths and gaps of the columns after it. NaN when that cannot be known:
// a column after it with no fixed width, or a row that does not push it to the right.
const rightInset = (path: Node[]): number => {
  let sum = 0
  for (let i = path.length - 2; i >= 0; i--) {
    const box = path[i] as Node
    const child = path[i + 1] as Node
    const p = box.props
    // The desktop draws a border as a hairline inside the box's edge, so only padding moves a row in.
    sum += cells(p.paddingRight ?? p.paddingX ?? p.padding)
    // In a column, a child reaches the right edge only when it stretches: its width is 100%, or the column says so.
    if (p.flexDirection !== 'row' && child.type === 'Box' && child.props.width !== '100%' && p.alignItems !== 'stretch') return NaN
    if (p.flexDirection === 'row') {
      const kids = kidsOf(box)
      const at = kids.indexOf(child)
      const later = kids.slice(at + 1)
      const pushed = p.justifyContent === 'flex-end' || p.justifyContent === 'space-between' || kids.slice(0, at + 1).some(k => (k.props.flexGrow ?? 0) > 0)
      if (!pushed && later.length > 0) return NaN
      if (!pushed && later.length === 0 && at > 0 && !kids.slice(0, at).some(k => (k.props.flexGrow ?? 0) > 0)) return NaN
      for (const k of later) {
        if (typeof k.props.width !== 'number') return NaN
        sum += k.props.width + cells(p.columnGap ?? p.gap)
      }
    }
  }
  return sum
}
const TIME = /^(CI (failed |passed )?)?(\d+:\d{2} [AP]M|(\d+h )?(\d+m )?\d+[sm])$/

test('layout: every row has one badge and one control width, and every time sits in the meta column on one right edge', async ($, on) => {
  const clock = await start($, on)
  await send($, { project: 'P', phases: ['Plan', 'Build', 'Test'], phase: 0, items: [{ id: 'p1', phase: 0, name: 'Read the code', status: 'now' }] })
  await clock.advance(65_000)
  await send($, { phase: 1, patch: [{ op: 'change', id: 'p1', status: 'done' }] })
  await send($, { patch: [
    { op: 'add', id: 'a', phase: 1, name: 'Write the blocks', status: 'done' },
    { op: 'add', id: 'b', phase: 1, name: 'Rebuild the view from the blocks', status: 'now', note: 'every region' },
    { op: 'add', id: 'c', phase: 1, name: 'Stage cards', status: 'now', parent: 'b' },
  ] })
  await clock.advance(12_000)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = walk(nodeOf(await ui.drawn()) as Node)

  // Every time on the pane sits in a meta column and ends on one right edge.
  const times = all.filter(x => x.node.type === 'Text' && TIME.test(textOf(x.node).trim()))
  expect(times.length >= 3).toBe(true)
  const insets = times.map(x => rightInset(x.path))
  expect(insets.every(v => Number.isFinite(v))).toBe(true)
  expect(new Set(insets).size).toBe(1)
  for (const x of times) expect(x.path.some(n => String(n.key ?? '').startsWith('col:meta:'))).toBe(true)

  // Every row: badge, title, meta, control, with one badge width and one control width on the whole pane.
  const rows = all.filter(x => x.node.type === 'Box' && String(x.node.key ?? '').startsWith('row:')).map(x => x.node)
  expect(rows.length >= 5).toBe(true)
  const col = (row: Node, name: string) => walk(row).find(x => x.node.key === `col:${name}:${String(row.key).slice(4)}`)?.node
  for (const r of rows) for (const name of ['badge', 'title', 'meta', 'ctl']) expect(col(r, name) !== undefined).toBe(true)
  expect(new Set(rows.map(r => col(r, 'badge')?.props.width)).size).toBe(1)
  expect(new Set(rows.map(r => col(r, 'ctl')?.props.width)).size).toBe(1)
  await ui.unmount()
})
