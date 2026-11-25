// Pill-track progress bars, agent strips and a heartbeat, drawn as SVG for the desktop pane.
// The look follows plan-progress by Kirill Serditov (MIT, github.com/zycck/claude-mods): a rounded track, a pixel
// dither that fills what is done, the current stage as a pill, and dots for the stages ahead.
// Every drawing is 100% wide with no viewBox, so it fills the pane at any width and its text never stretches.

const ACCENT = '#8B7CF6'
const PILL = '#7462E8'
const GREEN = '#4FA569'
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

const TWINKLE = `<style>.tw{animation:tw 2.4s steps(4) infinite}@keyframes tw{0%{opacity:.15}50%{opacity:.7}100%{opacity:.15}}@media (prefers-reduced-motion:reduce){.tw{animation:none}}</style>`

// The fill: a plain gradient that deepens toward the leading edge. No cells, no motion.
const LIVE = ''
function dither(id: string, width: string, height: number, color: string, from = 0.15, to = 0.9): string {
  return (
    `<defs><linearGradient id="${id}g" x1="0" x2="1"><stop offset="0" stop-color="${color}" stop-opacity="${(from * 0.6).toFixed(2)}"/>` +
    `<stop offset="1" stop-color="${color}" stop-opacity="${(to * 0.6).toFixed(2)}"/></linearGradient></defs>` +
    `<rect width="${width}" height="${height}" fill="url(#${id}g)"/>`
  )
}

export type TrackInput = { total: number; done: number; current: string | null; isDone: boolean; doneLabel?: string; clock?: number; names?: string[]; tips?: string[] }

// The track: each stage is one equal segment. Done segments fill with dither and tick marks; the current segment is a
// full-height pill with the stage name and a shimmer; later segments show a dot at their start.
export function trackSvg({ total, done, current, isDone, doneLabel = 'Done', clock = 0, names = [], tips = [] }: TrackInput): string {
  const H = 30
  const n = Math.max(1, total)
  const id = uid(total,done,current,isDone,doneLabel,clock,names,tips)
  const seg = isDone ? n - 1 : Math.min(done, n - 1)
  const fill = isDone ? 1 : (seg + 0.5) / n
  const label = isDone ? doneLabel : (current ?? '')
  const color = isDone ? GREEN : ACCENT
  // Every other stage names itself in its own segment: done ones in white with a check, later ones in grey.
  let marks = ''
  for (let k = 0; k < n; k++) {
    if (!isDone && k === seg) continue
    if (isDone && k === n - 1) continue
    const name = names[k] ?? ''
    if (k > 0) marks += `<svg x="${pct(k / n)}" overflow="visible"><rect x="-.5" y="9" width="1" height="${H - 18}" fill="#fff" fill-opacity=".12"/></svg>`
    if (name === '') continue
    const isPast = k < seg || isDone
    marks +=
      `<text x="${pct((k + 0.5) / n)}" y="${H / 2 + 4}" text-anchor="middle" style="font:500 11px ${FONT}" ` +
      `class="${isPast ? 'np' : 'nf'}">${esc(isPast ? `✓ ${name}` : name)}</text>`
  }
  const nameStyle = `<style>.np{fill:#fff;fill-opacity:.78}.nf{fill:#A8A69E;fill-opacity:.85}@media (prefers-color-scheme:light){.nf{fill:#6F6D66}}</style>`
  const pill =
    `<svg x="${pct(seg / n)}" width="${pct(1 / n)}" height="${H}">` +
    `<defs><clipPath id="${id}p"><rect width="100%" height="${H}" rx="6"/></clipPath></defs>` +
    `<g clip-path="url(#${id}p)"><rect width="100%" height="${H}" fill="${isDone ? '#3E8E57' : PILL}"/>` +

    `</g><text x="50%" y="${H / 2 + 4}" text-anchor="middle" style="font:600 12px ${FONT}" fill="#fff">${esc(label)}</text></svg>`
  const shimmer = `<defs><pattern id="${id}st" width="15" height="9" patternUnits="userSpaceOnUse"><rect x="3" width="2" height="2" fill="#fff"/><rect x="9" y="3" width="2" height="2" fill="#fff"/><rect y="6" width="2" height="2" fill="#fff"/><rect x="12" y="6" width="2" height="2" fill="#fff"/></pattern></defs>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">${TWINKLE}${LIVE}${shimmer}${nameStyle}` +
    `<defs><clipPath id="${id}k"><rect width="100%" height="${H}" rx="6"/></clipPath></defs>` +
    `<g clip-path="url(#${id}k)"><rect width="100%" height="${H}" fill="#808080" fill-opacity=".16"/>` +
    `<rect width="${pct(fill)}" height="${H}" fill="${color}" fill-opacity=".22"/>${dither(`${id}d`, pct(fill), H, color)}${marks}</g>` +
    `${label === '' ? '' : pill}` +
    tips
      .map((tip, k) => (tip === '' ? '' : `<rect x="${pct(k / n)}" width="${pct(1 / n)}" height="${H}" fill="#000" fill-opacity="0"><title>${esc(tip)}</title></rect>`))
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
      ? `<circle cx="12" cy="${H / 2}" r="3.5" fill="none" stroke="${tint}" stroke-width="1.6" stroke-dasharray="14 8"><animateTransform attributeName="transform" type="rotate" from="0 12 ${H / 2}" to="360 12 ${H / 2}" dur="1.2s" repeatCount="indefinite"/></circle>`
      : `<circle cx="12" cy="${H / 2}" r="3.5" fill="${tint}"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">${TWINKLE}${LIVE}` +
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

// A thin dithered line for a count with a denominator.
export function lineSvg(value: number, max: number): string {
  const H = 6
  const id = uid(value,max)
  const w = pct(max > 0 ? value / max : 0)
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">${TWINKLE}${LIVE}` +
    `<defs><clipPath id="${id}r"><rect width="100%" height="${H}" rx="3"/></clipPath></defs>` +
    `<g clip-path="url(#${id}r)"><rect width="100%" height="${H}" fill="#808080" fill-opacity=".16"/>` +
    `<rect width="${w}" height="${H}" fill="${ACCENT}" fill-opacity=".35"/>${dither(`${id}d`, w, H, ACCENT)}</g></svg>`
  )
}

// The liveness ring: five sections; one more lights each second, round and round. Amber and still when reads stop.
export function ringSvg(clock: number, isLive: boolean): string {
  const R = 6
  const C = 8
  const color = isLive ? GREEN : '#C0883B'
  const offset = ((clock / 1000) % 5).toFixed(2)
  let arcs = ''
  for (let k = 0; k < 5; k++) {
    const a0 = ((k * 72 + 10 - 90) * Math.PI) / 180
    const a1 = ((k * 72 + 62 - 90) * Math.PI) / 180
    const d = `M${(C + R * Math.cos(a0)).toFixed(2)} ${(C + R * Math.sin(a0)).toFixed(2)} A${R} ${R} 0 0 1 ${(C + R * Math.cos(a1)).toFixed(2)} ${(C + R * Math.sin(a1)).toFixed(2)}`
    arcs += isLive
      ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="butt" opacity=".2">` +
        `<animate attributeName="opacity" values=".2;1;.55;.2;.2" keyTimes="0;.04;.2;.4;1" dur="5s" begin="${(k - Number(offset)).toFixed(2)}s" repeatCount="indefinite"/></path>`
      : `<path d="${d}" fill="none" stroke="${color}" stroke-width="2.6" stroke-linecap="butt" opacity=".7"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${arcs}</svg>`
}

// A value that changed slides in from below while the old one slides out above; after the slide it stands still.
export function slideSvg(from: string, to: string, sinceMs: number, isAccent: boolean): string {
  const H = 22
  const begin = `-${(Math.max(0, sinceMs) / 1000).toFixed(2)}s`
  const ink = isAccent ? ACCENT : 'currentColor'
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">` +
    `<style>.v{font:600 16px ${FONT};fill:${ink === 'currentColor' ? '#F0EEFC' : ink}}@media (prefers-color-scheme:light){.v{fill:${ink === 'currentColor' ? '#222226' : ink}}}</style>` +
    `<text class="v" x="100%" y="17" text-anchor="end" opacity="0">${esc(from)}` +
    `<animate attributeName="y" values="17;-4" dur=".5s" begin="${begin}" fill="freeze"/>` +
    `<animate attributeName="opacity" values="1;0" dur=".5s" begin="${begin}" fill="freeze"/></text>` +
    `<text class="v" x="100%" y="17" text-anchor="end">${esc(to)}` +
    `<animate attributeName="y" values="30;17" dur=".5s" begin="${begin}" fill="freeze"/>` +
    `<animate attributeName="opacity" values="0;1" dur=".5s" begin="${begin}" fill="freeze"/></text></svg>`
  )
}

// A status badge for a stage card: a filled check when done, a pulsing ring when current, a hollow ring when ahead.
export function badgeSvg(state: 'done' | 'now' | 'next', clock: number, size = 20): string {
  const S = size
  const c = S / 2
  const id = uid(state, clock, size)
  if (state === 'done')
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><defs><linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="#5BC07A"/><stop offset="1" stop-color="#2F8A4C"/></linearGradient></defs>` +
      `<circle cx="${c}" cy="${c}" r="${c - 1}" fill="url(#${id}g)"/><path d="M${c - 4} ${c + 0.4}l${S * 0.13} ${S * 0.13} ${S * 0.27}-${S * 0.28}" fill="none" stroke="#fff" stroke-width="${S / 10}" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    )
  if (state === 'now') {
    // A circle spinner: a faint ring with a bright arc that turns once a second. The begin offset from the clock keeps
    // the turn smooth when the desktop redraws the picture.
    const r = c - 2
    const arc = 2 * Math.PI * r
    const begin = `-${((clock / 1000) % 1).toFixed(2)}s`
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">` +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ACCENT}" stroke-opacity=".22" stroke-width="2"/>` +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(arc * 0.28).toFixed(2)} ${arc.toFixed(2)}">` +
      `<animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="1s" begin="${begin}" repeatCount="indefinite"/></circle></svg>`
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><circle cx="${c}" cy="${c}" r="${c - 2.5}" fill="none" stroke="#A8A69E" stroke-opacity=".55" stroke-width="1.5" stroke-dasharray="3 2.4"/></svg>`
}

// A thin gradient line whose colours drift along it: the accent under the project heading.
export function glowLineSvg(clock: number): string {
  const id = uid(clock)
  const begin = `-${((clock / 1000) % 6).toFixed(2)}s`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="3">` +
    `<defs><linearGradient id="${id}" x1="0" x2="1" spreadMethod="reflect">` +
    `<stop offset="0" stop-color="${PILL}"/><stop offset=".5" stop-color="#E58BC9"/><stop offset="1" stop-color="${GREEN}"/>` +
    `<animate attributeName="x1" values="0;1;0" dur="6s" begin="${begin}" repeatCount="indefinite"/>` +
    `<animate attributeName="x2" values="1;2;1" dur="6s" begin="${begin}" repeatCount="indefinite"/></linearGradient></defs>` +
    `<rect width="100%" height="3" rx="1.5" fill="url(#${id})" opacity=".85"/></svg>`
  )
}

// A ticker: each line shows for a few seconds, then slides up as the next slides in. Round and round.
export function tickerSvg(lines: { lead: string; text: string; tone: 'accent' | 'dim' | 'green' }[], clock: number): string {
  const H = 20
  const SHOW = 3.2
  const n = Math.max(1, lines.length)
  const cycle = SHOW * n
  const begin = `-${((clock / 1000) % cycle).toFixed(2)}s`
  const tone = { accent: ACCENT, dim: '#A8A69E', green: GREEN }
  const cid = uid(lines,clock)
  let body = ''
  lines.forEach((l, k) => {
    // key times: in at k, hold, out at k+1
    const a = k / n
    const b = (k + 0.12) / n
    const c = (k + 0.88) / n
    const d = (k + 1) / n
    const kt = [0, a, b, c, d, 1].map(v => Math.min(1, Math.max(0, v)).toFixed(4))
    // keep keyTimes strictly ordered
    for (let i = 1; i < kt.length; i++) if (Number(kt[i]) < Number(kt[i - 1])) kt[i] = kt[i - 1] as string
    const ys = n === 1 ? `14;14;14;14;14;14` : `34;34;14;14;-6;-6`
    const op = n === 1 ? `1;1;1;1;1;1` : `0;0;1;1;0;0`
    body +=
      `<text x="0" y="14" style="font:500 12px ${FONT}" opacity="${n === 1 ? 1 : 0}">` +
      `<tspan fill="${tone[l.tone]}" style="font-weight:600">${esc(l.lead)}</tspan><tspan class="tk"> ${esc(l.text)}</tspan>` +
      `<animate attributeName="y" values="${ys}" keyTimes="${kt.join(';')}" dur="${cycle}s" begin="${begin}" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="${op}" keyTimes="${kt.join(';')}" dur="${cycle}s" begin="${begin}" repeatCount="indefinite"/></text>`
  })
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">` +
    `<style>.tk{fill:#E8E6F0}@media (prefers-color-scheme:light){.tk{fill:#2A2A2E}}</style>` +
    `<defs><clipPath id="${cid}"><rect width="100%" height="${H}"/></clipPath></defs><g clip-path="url(#${cid})">${body}</g></svg>`
  )
}

// The connector for an item that waits for the one above it: a plain elbow down and right, no arrowhead.
export function waitsArrowSvg(color: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="18">` +
    `<path d="M4 1 V7 Q4 10 7 10 H14" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/></svg>`
  )
}

// The live action line on the current card: a new action slides in from below while the last one slides out above.
export function actionSvg(from: string | null, to: string, sinceMs: number): string {
  const H = 18
  const begin = `-${(Math.max(0, sinceMs) / 1000).toFixed(2)}s`
  const style = `<style>.a{font:400 12px ${FONT};fill:#B9B6C8}@media (prefers-color-scheme:light){.a{fill:#55545C}}</style>`
  const old =
    from === null || from === to
      ? ''
      : `<text class="a" x="0" y="13" opacity="0">${esc(from)}` +
        `<animate attributeName="y" values="13;-4" dur=".45s" begin="${begin}" fill="freeze"/>` +
        `<animate attributeName="opacity" values="1;0" dur=".45s" begin="${begin}" fill="freeze"/></text>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">${style}${old}` +
    `<text class="a" x="0" y="13">${esc(to)}` +
    (from === null || from === to
      ? ''
      : `<animate attributeName="y" values="26;13" dur=".45s" begin="${begin}" fill="freeze"/>` +
        `<animate attributeName="opacity" values="0;1" dur=".45s" begin="${begin}" fill="freeze"/>`) +
    `</text></svg>`
  )
}

// The exit clause between two cards: a plain line from one card to the next, a node at its middle, and the clause
// beside the node. It carries no status: the card above holds the figure and the state.
export function exitSvg(text: string, isLast: boolean): string {
  const H = 28
  const X = 19
  const id = uid(text,isLast)
  const line = '#8B8A85'
  const node = isLast
    ? `<rect x="${X - 4.5}" y="${H / 2 - 4.5}" width="9" height="9" rx="1.5" transform="rotate(45 ${X} ${H / 2})" fill="#1F1E1D" stroke="${line}" stroke-width="1.4"/>`
    : `<circle cx="${X}" cy="${H / 2}" r="4" fill="#1F1E1D" stroke="${line}" stroke-width="1.4"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">` +
    `<style>.x${id}{font:400 12px ${FONT};fill:#A7A5AE}@media (prefers-color-scheme:light){.x${id}{fill:#5B5B5E}}</style>` +
    `<line x1="${X}" y1="0" x2="${X}" y2="${isLast ? H / 2 : H}" stroke="${line}" stroke-opacity=".6" stroke-width="1.4"/>` +
    node +
    `<text class="x${id}" x="${X + 14}" y="${H / 2 + 4}">${esc(`Done when ${text}`)}</text></svg>`
  )
}
