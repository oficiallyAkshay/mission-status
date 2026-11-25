import { expect, test } from 'claude-code/testing'
import { LIGHT, badgeSvg, exitSvg, slideSvg, stripSvg, trackSvg, waitsLineSvg } from '../hooks/bars'

// WCAG relative luminance and contrast ratio of two six-digit hex colours.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)
}
// The light pages the drawings sit on: white and the app's light page.
const PAGES = ['#FFFFFF', LIGHT.page]

const drawings: [string, string][] = [
  ['stage bar', trackSvg({ total: 5, done: 2, current: 'Test', isDone: false, names: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'] })],
  ['stage bar, all done', trackSvg({ total: 3, done: 3, current: null, isDone: true, names: ['Plan', 'Build', 'Test'] })],
  ['helper strip', stripSvg({ title: 'Scan tests', detail: 'haiku', state: 'running', time: '2 min' })],
  ['figure slide', slideSvg('10', '11', 100, true)],
  ['badge ahead', badgeSvg('next', 0)],
  ['badge current', badgeSvg('now', 0)],
  ['wait line', waitsLineSvg()],
  ['exit clause', exitSvg('all tests pass', false)],
]

test('light theme: every drawing with text or thin lines has a light rule', () => {
  for (const [name, svg] of drawings) expect(`${name}: ${svg.includes('@media (prefers-color-scheme:light)')}`).toBe(`${name}: true`)
})

test('light theme: light text colours reach 4.5:1 and line colours 3:1 on a light page', () => {
  for (const page of PAGES) {
    for (const ink of [LIGHT.accent, LIGHT.green, LIGHT.amber, LIGHT.grey, LIGHT.ink]) expect(contrast(ink, page)).toBeGreaterThanOrEqual(4.5)
  }
})

test('light theme: the dark look keeps its colours', () => {
  const track = trackSvg({ total: 5, done: 2, current: 'Test', isDone: false, names: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'] })
  expect(track).toContain('.np{fill:#fff;fill-opacity:.78}.nf{fill:#A8A69E;fill-opacity:.85}.dv{fill:#fff;fill-opacity:.12}')
  expect(track).toContain('fill="#7462E8"')
  const exit = exitSvg('all tests pass', true)
  expect(exit).toContain('fill:#1F1E1D;stroke:#8B8A85;stroke-opacity:.7}.el{stroke:#8B8A85;stroke-opacity:.6}')
  expect(badgeSvg('now', 0)).toContain('stroke="#8B7CF6"')
  expect(badgeSvg('next', 0)).toContain('.bn{stroke:#A8A69E;stroke-opacity:.55}')
  expect(waitsLineSvg()).toContain('.wa{stroke:#8B8A85}')
})

test('light theme: classes whose colour differs per drawing carry the drawing id', () => {
  const cls = (svg: string) => svg.match(/class="([^"]+)"/)?.[1]
  expect(cls(slideSvg('1', '2', 0, true))).not.toBe(cls(slideSvg('1', '2', 0, false)))
})
