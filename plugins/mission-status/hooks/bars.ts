// Pill-track progress bars, agent strips and a heartbeat, drawn as SVG for the desktop pane.
// The look follows plan-progress by Kirill Serditov (MIT, github.com/zycck/claude-mods): a rounded track, a pixel
// dither that fills what is done, the current stage as a pill, and dots for the stages ahead.
// Every drawing is 100% wide with no viewBox, so it fills the pane at any width and its text never stretches.

const ACCENT = '#8B7CF6'
const PILL = '#7462E8'
const GREEN = '#4FA569'
// On a light page the accent, green, amber and grey step darker, so text keeps 4.5:1 and lines keep 3:1 on white.
// The dark values stay as they were.
export const LIGHT = { accent: '#5B4BD6', green: '#2F7D47', amber: '#9A6312', grey: '#6F6D66', ink: '#2A2833', page: '#FAF9F5' }
export const DARK_PAGE = '#1F1E1D'
const LINE = '#8B8A85'
const FONT = "'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif"

// Each drawing's id prefix comes from its own input: two different drawings in one page never share a clip or a
// mask, and the same input always gives the same source, so the app does not rebuild (and flicker) an unchanged one.
const uid = (...input: unknown[]) => {
  const text = JSON.stringify(input)
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return `v${(h >>> 0).toString(36)}`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// A width guess for 12 px semibold text: close enough to size a pill.
export const textWidth = (s: string, px = 12) => Math.ceil([...s].length * px * 0.6)
const pct = (x: number) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(2)}%`


function dither(id: string, width: string, height: number, color: string, from = 0.15, to = 0.9): string {
  return (
    `<defs><linearGradient id="${id}g" x1="0" x2="1"><stop offset="0" stop-color="${color}" stop-opacity="${(from * 0.6).toFixed(2)}"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="${(to * 0.6).toFixed(2)}"/></linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#${id}g)"/>`
  )
}

export type TrackInput = { total: number; done: number; current: string | null; isDone: boolean; doneLabel?: string; clock?: number; names?: string[]; tips?: string[]; checks?: boolean[]; widthPx?: number }

// Does every stage label fit the pane's width? The pane draws the bar when it does, and wrapped stage chips when not.
export function trackFits(t: TrackInput): boolean {
  if (t.widthPx === undefined) return true
  const n = Math.max(1, t.total)
  const seg = t.isDone ? n - 1 : Math.min(t.done, n - 1)
  const names = t.names ?? []
  const label = (k: number) => {
    if (k === seg) return textWidth(t.isDone ? (t.doneLabel ?? 'Done') : (t.current ?? ''), 12)
    const isPast = t.checks !== undefined ? t.checks[k] === true : k < seg || t.isDone
    return textWidth(isPast ? `✓ ${names[k] ?? ''}` : (names[k] ?? ''), 11)
  }
  let sum = 0
  for (let k = 0; k < n; k++) sum += Math.max(36, label(k) + 28)
  return sum <= t.widthPx
}

export function trackSvg(input: TrackInput): string {
  const { total, done, current, isDone, doneLabel = 'Done', clock = 0, names = [], tips = [], checks } = input
  const H = 30
  const n = Math.max(1, total)
  const id = uid(total,done,current,isDone,doneLabel,clock,names,tips)
  // done may sit outside 0..n-1 for a window of the stages: before it, the window is all ahead; past it, all done.
  const seg = isDone ? n - 1 : Math.max(0, Math.min(done, n - 1))
  const isOut = !isDone && (done < 0 || done >= n)
  // Each segment is as wide as its label plus the same padding on both sides, so every name has equal room.
  const shown = (k: number) => {
    const name = names[k] ?? ''
    const isPast = checks !== undefined ? checks[k] === true : k < seg || isDone
    return isPast ? `✓ ${name}` : name
  }
  const weights = Array.from({ length: n }, (_, k) => Math.max(36, textWidth(k === seg ? (isDone ? doneLabel : (current ?? '')) : shown(k), k === seg ? 12 : 11) + 28))
  const sum = weights.reduce((a, b) => a + b, 0)
  const at = (k: number) => weights.slice(0, k).reduce((a, b) => a + b, 0) / sum
  const span = (k: number) => (weights[k] ?? 0) / sum
  const fill = isDone || done >= n ? 1 : done < 0 ? 0 : at(seg) + span(seg) / 2
  const label = isDone ? doneLabel : isOut ? '' : (current ?? '')
  const color = isDone ? GREEN : ACCENT
  // Every other stage names itself in its own segment: done ones in white with a check, later ones in grey.
  let marks = ''
  for (let k = 0; k < n; k++) {
    if (!isDone && !isOut && k === seg) continue
    if (isDone && k === n - 1) continue
    const name = names[k] ?? ''
    if (k > 0 && (isOut || k !== seg + 1)) marks += `<svg x="${pct(at(k))}" overflow="visible"><rect x="-.5" y="9" width="1" height="${H - 18}" class="dv"/></svg>`
    if (name === '') continue
    // A check only on a stage that is truly done (the pane passes each stage's real state).
    const isPast = checks !== undefined ? checks[k] === true : k < seg || isDone
    marks +=
      `<text x="${pct(at(k) + span(k) / 2)}" y="${H / 2 + 4}" text-anchor="middle" style="font:500 11px ${FONT}" ` +
      `class="${isPast ? 'np' : 'nf'}">${esc(isPast ? `✓ ${name}` : name)}</text>`
  }
  const nameStyle =
    `<style>.np{fill:#fff;fill-opacity:.78}.nf{fill:#A8A69E;fill-opacity:.85}.dv{fill:#fff;fill-opacity:.12}` +
    `@media (prefers-color-scheme:light){.np{fill:${LIGHT.ink};fill-opacity:.85}.nf{fill:${LIGHT.grey};fill-opacity:1}.dv{fill:#000;fill-opacity:.14}}</style>`
  const pill =
    `<svg x="${pct(at(seg))}" width="${pct(span(seg))}" height="${H}">` +
    `<defs><clipPath id="${id}p"><rect width="100%" height="${H}" rx="6"/></clipPath></defs>` +
    `<g clip-path="url(#${id}p)"><rect width="100%" height="${H}" fill="${isDone ? '#3E8E57' : PILL}"/>` +

    `</g><text x="50%" y="${H / 2 + 4}" text-anchor="middle" style="font:600 12px ${FONT}" fill="#fff">${esc(label)}</text></svg>`
  const shimmer = `<defs><pattern id="${id}st" width="15" height="9" patternUnits="userSpaceOnUse"><rect x="3" width="2" height="2" fill="#fff"/><rect x="9" y="3" width="2" height="2" fill="#fff"/><rect y="6" width="2" height="2" fill="#fff"/><rect x="12" y="6" width="2" height="2" fill="#fff"/></pattern></defs>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">${shimmer}${nameStyle}` +
    `<defs><clipPath id="${id}k"><rect width="100%" height="${H}" rx="6"/></clipPath></defs>` +
    `<g clip-path="url(#${id}k)"><rect width="100%" height="${H}" fill="#808080" fill-opacity=".16"/>` +
    `<rect width="${pct(fill)}" height="${H}" fill="${color}" fill-opacity=".22"/>${dither(`${id}d`, pct(fill), H, color)}${marks}</g>` +
    `${label === '' ? '' : pill}` +
    tips
      .map((tip, k) => (tip === '' ? '' : `<rect x="${pct(at(k))}" width="${pct(span(k))}" height="${H}" fill="#000" fill-opacity="0"><title>${esc(tip)}</title></rect>`))
      .join('') +
    `</svg>`
  )
}

export type StripInput = { title: string; detail: string | null; state: 'running' | 'done' | 'failed'; time: string }

// One agent strip: a rounded row; a running one carries the dither and a spinner, a finished one a tint and a dot.
export function stripSvg({ title, detail, state, time }: StripInput): string {
  const H = 22
  const id = uid(title,detail,state,time)
  const tint = state === 'running' ? ACCENT : state === 'done' ? GREEN : '#D67278'
  const mark =
    state === 'running'
      ? // Turns once every 1.2 s, started at the wall clock's place in that turn, so a redraw does not jump.
        `<circle cx="12" cy="${H / 2}" r="3.5" fill="none" stroke="${tint}" stroke-width="1.6" stroke-dasharray="14 8"><animateTransform attributeName="transform" type="rotate" from="0 12 ${H / 2}" to="360 12 ${H / 2}" dur="1.2s" begin="-${((Date.now() % 1200) / 1000).toFixed(2)}s" repeatCount="indefinite"/></circle>`
      : `<circle cx="12" cy="${H / 2}" r="3.5" fill="${tint}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">` +
    `<style>.i{fill:#F0EEFC}.d{fill:#A7A5AE}@media (prefers-color-scheme:light){.i{fill:#222226}.d{fill:#5B5B5E}}</style>` +
    `<defs><clipPath id="${id}r"><rect width="100%" height="${H}" rx="6"/></clipPath></defs>` +
    // the dots fade out toward the right, so the time stays clear
    `<g clip-path="url(#${id}r)"><rect width="100%" height="${H}" fill="${tint}" fill-opacity=".14"/>${state === 'running' ? dither(`${id}d`, '70%', H, tint, 0.55, 0) : ''}</g>` +
    mark +
    `<text x="24" y="${H / 2 + 4}" style="font:500 12px ${FONT}"><tspan class="i">${esc(title)}</tspan>${detail ? `<tspan class="d"> (${esc(detail)})</tspan>` : ''}</text>` +
    `<text x="100%" dx="-10" y="${H / 2 + 4}" text-anchor="end" class="d" style="font:400 11px ${FONT}">${esc(time)}</text>` +
    `</svg>`
  )
}




// A status badge for a stage card: a filled check when done, a pulsing ring when current, a hollow ring when ahead.
// A badge in a 20 px tall cell when up or down is given: the rail runs into the badge from above and leaves it below.
export function badgeSvg(state: 'done' | 'now' | 'next' | 'dot', clock: number, size = 20, up?: boolean, down?: boolean): string {
  if (up !== undefined || down !== undefined) {
    const inner = badgeSvg(state, clock, size)
    const pad = (20 - size) / 2
    const stub = (y1: number, y2: number) => `<path class="wa" d="M8 ${y1} V${y2}" stroke-width="1.5"/>`
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="20">${WAITS_STYLE}` +
      (up === true ? stub(0, pad) : '') +
      (down === true ? stub(20 - pad, 20) : '') +
      `<g transform="translate(${(16 - size) / 2} ${pad})">${inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')}</g></svg>`
    )
  }
  const S = size
  // A card whose border carries the motion: a plain purple dot, no spinner.
  if (state === 'dot')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.3}" fill="${ACCENT}"/></svg>`
  const c = S / 2
  const id = uid(state, clock, size)
  if (state === 'done')
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><defs><linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#5BC07A"/><stop offset="1" stop-color="#2F8A4C"/></linearGradient></defs>` +
      `<circle cx="${c}" cy="${c}" r="${c - 1}" fill="url(#${id}g)"/><path d="M${c - 4} ${c + 0.4}l${S * 0.13} ${S * 0.13} ${S * 0.27}-${S * 0.28}" fill="none" stroke="#fff" stroke-width="${S / 10}" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    )
  if (state === 'now') {
    // A circle spinner: a faint ring with a bright arc that turns once a second. Each redraw starts the turn at the
    // wall clock's place in the second, so a redraw continues the turn instead of jumping back to the top.
    const r = c - 2
    const arc = 2 * Math.PI * r
    const begin = `-${(((clock || Date.now()) % 1000) / 1000).toFixed(2)}s`
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><style>@media (prefers-color-scheme:light){.ba{stroke:${LIGHT.accent}}}</style>` +
      `<circle class="ba" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ACCENT}" stroke-opacity=".22" stroke-width="2"/>` +
      `<circle class="ba" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(arc * 0.28).toFixed(2)} ${arc.toFixed(2)}">` +
      `<animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="1s" begin="${begin}" repeatCount="indefinite"/></circle></svg>`
    )
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><style>.bn{stroke:#A8A69E;stroke-opacity:.55}@media (prefers-color-scheme:light){.bn{stroke:${LIGHT.grey};stroke-opacity:.8}}</style>` +
    `<circle class="bn" cx="${c}" cy="${c}" r="${c - 2.5}" fill="none" stroke-width="1.5"/></svg>`
  )
}




// The line that runs on beside an item's note, from its badge down to the items that wait for it.
// The wait line, in the theme's grey (light theme too); the colour argument is kept for callers and not used.
const WAITS_STYLE = `<style>.wa{stroke:${LINE}}@media (prefers-color-scheme:light){.wa{stroke:${LIGHT.grey}}}</style>`
export function waitsLineSvg(height = 20): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="${height}">${WAITS_STYLE}<path class="wa" d="M8 0 V${height}" stroke-width="1.5"/></svg>`
}


// The gate between two cards: a plain line from one card to the next, with a short label on it, and the clause
// beside the node. It carries no status: the card above holds the figure and the state.
export function exitSvg(text: string, isLast: boolean, isMet = false): string {
  // A gate between two cards, with its state in the chip: met shows a green check and the label ("Plan approved");
  // not met shows a flag and "Needs: <label>". The row is tall enough to leave space above and below the chip.
  const H = 40
  const X = 19
  const id = uid(text, isLast, isMet)
  const PAD = 12
  const ICON = 12
  const label = isMet ? text : `Needs: ${text}`
  const left = X - 10
  const w = Math.min(360, PAD + ICON + 6 + textWidth(label, 11) + PAD)
  const ix = left + PAD
  const iy = H / 2 - ICON / 2
  const icon = isMet
    ? `<path class="g${id}" d="M${ix + 1.5} ${iy + 6.5} l3 3 l6 -6.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path class="i${id}" d="M${ix + 2} ${iy + 11.5} V${iy + 1} M${ix + 2} ${iy + 1.5} H${ix + 10} L${ix + 8} ${iy + 4} L${ix + 10} ${iy + 6.5} H${ix + 2}" fill="none" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`
  const chip = isMet ? `fill:${DARK_PAGE};stroke:${GREEN};stroke-opacity:.8` : `fill:${DARK_PAGE};stroke:${LINE};stroke-opacity:.7`
  const chipLight = isMet ? `fill:${LIGHT.page};stroke:${LIGHT.green}` : `fill:${LIGHT.page};stroke:${LIGHT.grey}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">` +
    `<style>.t${id}{font:500 11px ${FONT};fill:${isMet ? GREEN : '#B9B6C8'}}.c${id}{${chip}}.el{stroke:${LINE};stroke-opacity:.6}` +
    `.i${id}{stroke:#B9B6C8}.g${id}{stroke:${GREEN}}` +
    `@media (prefers-color-scheme:light){.t${id}{fill:${isMet ? LIGHT.green : '#55545C'}}.c${id}{${chipLight}}.el{stroke:${LIGHT.grey};stroke-opacity:.7}.i${id}{stroke:#55545C}.g${id}{stroke:${LIGHT.green}}}</style>` +
    `<line class="el" x1="${X}" y1="0" x2="${X}" y2="${isLast ? H / 2 : H}" stroke-width="1.4"/>` +
    `<rect class="c${id}" x="${left}" y="${H / 2 - 10}" width="${w}" height="20" rx="10" stroke-width="1"/>` +
    icon +
    `<text class="t${id}" x="${ix + ICON + 6}" y="${H / 2 + 4}">${esc(label)}</text></svg>`
  )
}

// An empty drawing of a set height: it holds a row's space where no line runs through.
export function spaceSvg(height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="${height}"></svg>`
}


// A plain line in the flow column, from one card to the next, with no gate on it.
export function flowLineSvg(height: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}">${WAITS_STYLE}<line class="wa" x1="19" y1="0" x2="19" y2="${height}" stroke-width="1.4"/></svg>`
}

// The window of stages a narrow bar shows: as many as fit, from start. With no start, the window that holds the
// current stage, grown to the right first.
export function barWindow(t: TrackInput, start: number | null): { from: number; to: number } {
  const n = Math.max(1, t.total)
  const fits = (from: number, to: number) =>
    trackFits({
      ...t,
      total: to - from + 1,
      done: t.done - from,
      names: (t.names ?? []).slice(from, to + 1),
      checks: t.checks?.slice(from, to + 1),
    })
  if (start === null) {
    const cur = t.isDone ? n - 1 : Math.max(0, Math.min(t.done, n - 1))
    let from = cur
    let to = cur
    for (let grew = true; grew; ) {
      grew = false
      if (to + 1 < n && fits(from, to + 1)) (to += 1), (grew = true)
      if (from - 1 >= 0 && fits(from - 1, to)) (from -= 1), (grew = true)
    }
    return { from, to }
  }
  const from = Math.max(0, Math.min(start, n - 1))
  let to = from
  while (to + 1 < n && fits(from, to + 1)) to += 1
  return { from, to }
}

// A runbook's rail: one short segment for each step, in its state's colour. It shows how far the runbook is, at a
// glance, with no labels; the steps below carry the words.
export function stepsRailSvg(states: readonly ('done' | 'now' | 'next' | 'failed' | 'blocked')[]): string {
  const n = Math.max(1, states.length)
  const gap = 0.6
  const w = (100 - gap * (n - 1)) / n
  const fill = { done: GREEN, now: ACCENT, next: '#808080', failed: '#D9534F', blocked: '#D4A13A' } as const
  const op = { done: '1', now: '1', next: '.3', failed: '1', blocked: '.85' } as const
  const bars = states
    .map((st, k) => `<rect x="${(k * (w + gap)).toFixed(3)}%" y="0" width="${w.toFixed(3)}%" height="6" rx="3" fill="${fill[st]}" fill-opacity="${op[st]}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="6">${bars}</svg>`
}

// A pull request's state as one small mark: merged purple with a check, open green, draft grey and hollow, conflict
// amber with a bar, closed red with a cross.
export function prIconSvg(state: 'merged' | 'open' | 'draft' | 'conflict' | 'closed'): string {
  const fill = { merged: ACCENT, open: GREEN, draft: '#808080', conflict: '#D4A13A', closed: '#D9534F' }[state]
  const glyph = {
    merged: '<path d="M5 8.2l2 2 4-4.2" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    open: '<circle cx="8" cy="8" r="2.2" fill="#fff"/>',
    draft: '',
    conflict: '<path d="M8 4.6v4.2" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.2" r="1" fill="#fff"/>',
    closed: '<path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>',
  }[state]
  const disc = state === 'draft' ? `<circle cx="8" cy="8" r="6.2" fill="none" stroke="${fill}" stroke-width="1.6" stroke-dasharray="2.4 2"/>` : `<circle cx="8" cy="8" r="7" fill="${fill}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${disc}${glyph}</svg>`
}
