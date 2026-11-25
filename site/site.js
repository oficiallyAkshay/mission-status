// The demo: the pane drawn with the plugin's own bars.ts, fed sample missions. Every number here comes from this page.
import { badgeSvg, exitSvg, trackSvg, stripSvg, flowLineSvg } from './vendor/bars.js'

// `?motion` in the address forces the moving version, to check it on a machine with reduced motion on.
const FORCE_MOTION = new URLSearchParams(location.search).has('motion')
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches && !FORCE_MOTION
// With `?motion`, drop the stylesheet's reduced-motion rules too, so the moving version can be checked on such a machine.
if (FORCE_MOTION) for (const sheet of document.styleSheets) { try { const rules = sheet.cssRules; for (let i = rules.length - 1; i >= 0; i--) if (rules[i].media && /prefers-reduced-motion/.test(rules[i].media.mediaText)) sheet.deleteRule(i) } catch {} }
// One motion system for the page: one easing curve and one step between parts.
const EASE = 'cubic-bezier(.22, 1, .36, 1)'
const STEP_MS = 650
const $ = id => document.getElementById(id)
// The pane is dark on the site: drop each drawing's light-mode block, rules and all.
const dark = svg => svg.replace(/@media \(prefers-color-scheme:light\)\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
// The clock time a step was done, as the pane writes it (hooks/view.tsx timeOfDay): 2:14 PM EST.
const zone = d => { const n = (/\(([^)]+)\)/.exec(d.toString()) ?? [])[1] ?? ''; const z = n.split(/\s+/).filter(w => !/^(standard|daylight|summer)$/i.test(w)).map(w => w[0] ?? '').join('').toUpperCase(); return z ? ` ${z}` : '' }
const timeOfDay = at => { const d = new Date(at), h = d.getHours(); return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}${zone(d)}` }
// The header's age of the agent's last update (hooks/view.tsx agoOf).
const clockAgo = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago` }
const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

// Stage lists are the plugin's TEMPLATES (plugins/mission-status/hooks/model.ts).
const MISSIONS = [
  { key: 'feature', label: 'Feature', project: 'Saved searches', goal: 'People can save a search and get it back in one click.',
    stages: ['Plan', 'Build', 'Test', 'Deploy', 'Learn'], exits: ['the plan is approved', 'the code is on a branch', 'all tests pass', 'it is live', 'the lessons are written'],
    items: ['Save button', 'Saved list', 'Sync across devices'], use: 'Ship a feature from plan to live.' },
  { key: 'product-loop', label: 'Product loop', project: 'Onboarding v2', goal: 'More new users finish setup on day one.',
    stages: ['Plan', 'Build', 'Review', 'Deploy', 'Monitor', 'Iterate'], exits: ['the bet is written', 'the flow is built', 'design signs off', 'it reaches all users', 'a week of data is in', 'the next bet is picked'],
    items: ['Welcome screen', 'Checklist', 'Nudge email'], use: 'Run build, measure, learn in a loop.' },
  { key: 'bug-fix', label: 'Bug fix', project: 'Login loop on Safari', goal: 'Safari users sign in once and stay signed in.',
    stages: ['Reproduce', 'Find cause', 'Fix', 'Test', 'Deploy'], exits: ['the bug shows on demand', 'the cause is proven', 'the fix is on a branch', 'the bug no longer shows', 'the fix is live'],
    items: ['Cookie flags', 'Redirect chain', 'Session refresh'], use: 'Go from symptom to proven fix.' },
  { key: 'incident', label: 'Incident', project: 'Checkout errors', goal: 'Customers can pay again, and it does not come back.',
    stages: ['Detect', 'Triage', 'Mitigate', 'Root cause', 'Fix', 'Review'], exits: ['the alert is confirmed', 'the impact is known', 'errors are back to normal', 'the cause is proven', 'the fix is live', 'the review is shared'],
    items: ['Roll back', 'Raise the timeout', 'Tell support'], use: 'Stay calm while the fire is out.' },
  { key: 'research', label: 'Research', project: 'Vector databases', goal: 'Pick the store for search, with the reasons written down.',
    stages: ['Question', 'Gather', 'Analyze', 'Synthesize', 'Report'], exits: ['the question is agreed', 'eight sources are read', 'the options are scored', 'one answer is clear', 'the report is sent'],
    items: ['Benchmarks', 'Pricing pages', 'Field reports'], use: 'Turn a question into a clear answer.' },
  { key: 'design', label: 'Design', project: 'Settings page', goal: 'People find every setting in under ten seconds.',
    stages: ['Brief', 'Explore', 'Pick', 'Refine', 'Hand off'], exits: ['the brief is agreed', 'three directions exist', 'one direction is picked', 'every state is drawn', 'the build ticket is filed'],
    items: ['Layout', 'Empty states', 'Dark theme'], use: 'From brief to hand-off, one look.' },
  { key: 'board-batch', label: 'Board batch', project: 'Twelve tickets', goal: 'Clear this week’s ready tickets.',
    stages: ['Intake', 'Plan', 'Build', 'Review', 'Merge'], exits: ['every ticket is read', 'each has a plan', 'each has a pull request', 'each passes review', 'all are merged'],
    items: ['Ticket 4 of 12', 'Ticket 5 of 12', 'Ticket 6 of 12'], use: 'Work a pile of tickets, one view.' },
  { key: 'writing', label: 'Writing', project: 'Launch post', goal: 'A post that explains the launch in five minutes of reading.',
    stages: ['Outline', 'Draft', 'Review', 'Publish'], exits: ['the outline is agreed', 'the draft is complete', 'two reviewers approve', 'it is published'],
    items: ['Intro', 'Demo section', 'Closing'], use: 'Outline to published, no lost drafts.' },
  { key: 'migration', label: 'Migration', project: 'Move to Postgres 17', goal: 'All data moves with no lost rows and no downtime.',
    stages: ['Plan', 'Dry run', 'Migrate', 'Verify', 'Clean up'], exits: ['the plan is reviewed', 'a copy moves cleanly', 'production moves', 'row counts match', 'the old database is gone'],
    items: ['Users table', 'Orders table', 'Search index'], use: 'Move data with proof at each step.' },
  { key: 'plan-review', label: 'Plan review', project: 'Payments redesign plan', goal: 'A plan that three review waves in a row find no major issue in.',
    stages: ['Intake', 'Draft', 'Review waves', 'Your rows', 'Hand off'], exits: ['the requirements are set', 'the draft is checked', 'three waves in a row are clean', 'every open decision is ruled', 'the plan is approved'],
    items: ['Wave 7', 'Facts lens', 'Reviser'], use: 'Review a plan until it holds.' },
  { key: 'custom', label: 'Custom', project: 'Your mission', goal: 'Your stages, in your words.', stages: [], exits: [], items: ['First step', 'Second step'], use: '' },
]

// More projects for each template, so the texture never repeat one.
const VARIANTS = [
  ['feature', 'Dark mode', 'Every screen works in dark mode.', ['Colour tokens', 'Settings toggle', 'Charts']],
  ['product-loop', 'Referral program', 'Each new user brings one more within a month.', ['Invite link', 'Reward email', 'Dashboard']],
  ['bug-fix', 'CSV export drops rows', 'Exports include every row, every time.', ['Paging bug', 'Encoding', 'Large files']],
  ['incident', 'Search is down', 'Search answers in under a second again.', ['Fail over', 'Rebuild index', 'Status page']],
  ['research', 'Pick a queue: Kafka or SQS', 'A queue choice with the numbers behind it.', ['Throughput test', 'Cost model', 'Ops load']],
  ['design', 'Mobile onboarding', 'New users reach the first win in three taps.', ['Flow', 'Copy', 'Illustrations']],
  ['board-batch', 'Q4 papercuts', 'Close twenty small fixes this sprint.', ['Ticket 9 of 20', 'Ticket 10 of 20', 'Ticket 11 of 20']],
  ['writing', 'API guide', 'A guide a new developer can follow in ten minutes.', ['Quickstart', 'Auth', 'Errors']],
  ['migration', 'New billing system', 'Every account on the new billing, with no double charges.', ['Plans', 'Invoices', 'Refunds']],
  ['plan-review', 'Search rebuild plan', 'A plan the builders can follow with no open question.', ['Wave 3', 'Simplicity lens', 'Directives']],
].map(([key, project, goal, items]) => ({ ...MISSIONS.find(m => m.key === key), project, goal, items }))
const AGENT_MISSION = { key: 'agent', label: 'Let the agent build it', project: 'Rate limits for the public API', goal: 'No customer can overload the API, and fair users never notice. Stages written by the agent.', stages: ['Spike', 'Pick the limits', 'Build', 'Load test', 'Roll out'], exits: ['one approach is proven', 'limits per plan are agreed', 'the limiter is on a branch', 'it holds at ten times the load', 'it is on for everyone'], items: ['Token bucket', 'Redis store', '429 responses'] }
const CUSTOMS = [
  AGENT_MISSION,
  { key: 'custom', label: 'Custom', project: 'Offline mode', goal: 'The app works on a plane.', stages: ['Spike', 'Cache layer', 'Sync engine', 'Conflict tests', 'Ship'], exits: ['one sync approach is proven', 'reads work offline', 'writes sync back', 'no conflict loses data', 'it is live'], items: ['Service worker', 'Local store', 'Retry queue'] },
  { key: 'custom', label: 'Custom', project: 'Upgrade to React 19', goal: 'Every screen runs on React 19 with no regressions.', stages: ['Audit', 'Codemods', 'Fix breakages', 'Visual tests', 'Release'], exits: ['every blocker is listed', 'the codemods ran', 'the build is green', 'no screen changed', 'it is released'], items: ['Forms', 'Charts', 'Router'] },
]

const ACTS = ['Reading a file', 'Running a command', 'Editing a file', 'Searching', 'Running a helper', 'Running tests']
const CHAT = [
  ['Add saved searches: people should get a search back in one click.', 2],
  ['I’ll start by reading how the current flow works, then check what the tests cover.', 0],
  ['Read src/search/index.ts', 1], ['Read src/search/query.ts', 1],
  ['The query builder keeps state in two places. I’ll move it into one store first so the save button has a single source.', 0],
  ['Edited src/search/store.ts (+48 −12)', 1], ['Ran npm test: 41 passed, 2 failed', 1],
  ['Two tests fail because they assumed the old shape. I’ll update the fixtures rather than the code, since the new shape is the intended one.', 0],
  ['Edited test/fixtures/search.json', 1], ['Ran npm test: 43 passed', 1],
  ['Next I’ll add the saved list. It needs pagination for people with many searches, so I’ll reuse the list component from settings.', 0],
  ['Searched for "PagedList": 6 results', 1], ['Edited src/search/SavedList.tsx (+112)', 1],
  ['I also noticed the empty state says nothing useful, so I wrote a short line that tells people how to save their first search.', 0],
  ['Started a helper: check accessibility of the new list', 1], ['Helper finished: 2 contrast fixes', 1],
  ['Both contrast fixes are applied. Now running the full suite again before I open the pull request.', 0],
]

const state = { mission: MISSIONS[0], phase: 0, item: 0, started: Date.now(), done: false, timer: 0, words: 0 }

// Sample times for finished stages, in seconds: the demo runs fast, so a done stage shows a plausible time it took.
const TOOK = [214, 388, 162, 301, 245, 190, 276]
// Draws the pane the way the mod draws it (hooks/view.tsx): the title, the goal, the stage bar, then the flow. A done
// stage folds to one line with its met gate and its time; the current stage is a card with the accent border, its
// links, its items as a tree and a running helper; a later stage is a dim card; each open card has its gate under it.
function paneHtml({ mission, phase, done, now, act, starts, extraStage = -1, itemStates = null, lastAt = null }) {
  const n = mission.stages.length
  const st = k => done || k < phase ? 'done' : k === phase ? 'now' : 'next'
  const tips = mission.stages.map((name, k) => `${name}: ${st(k) === 'done' ? 'Done' : st(k) === 'now' ? 'In progress' : 'Not started'}. Gate: ${mission.exits[k] ?? ''}`)
  const track = dark(trackSvg({ total: n, done: done ? n : phase, current: done ? null : mission.stages[phase], isDone: done, clock: 0,
    names: mission.stages, tips, checks: mission.stages.map((_, k) => st(k) === 'done') }))
  const flow = mission.stages.map((name, k) => {
    const s = st(k), isLast = k === n - 1
    if (s === 'done') {
      const gate = mission.exits[k] ? `<span class="f-gate">✓ ${esc(mission.exits[k])}</span>` : ''
      return `<div class="flow fold" data-k="${k}"><div class="fold-row">${dark(badgeSvg('done', 0, 14))}<span class="f-name">${esc(name)}</span>${gate}<span class="f-time">${clock(TOOK[k % TOOK.length] * 1000)}</span><span class="chev">+</span></div>` +
        `${isLast ? '' : `<div class="f-line">${dark(flowLineSvg(8))}</div>`}</div>`
    }
    const t = s === 'now' ? clock(now - starts[k] + 37000) : ''
    let body = ''
    if (s === 'now') {
      // Each stage links what it made: a plan in the first, then a preview and a report in later stages.
      const links = k === 0 ? ['Plan'] : (mission.links ?? ['Preview', 'Report'])
      body += `<div class="card-links">${links.map(x => `<span class="lk">↗ ${esc(x)}</span>`).join('')}</div>`
      // Items as the pane draws them: the one in progress with its timer, a done one with the time it was done, and
      // the running helper under the item in progress, as its child.
      const list = mission.items
      const states = list.map((_, i) => itemStates ? itemStates[i] : i === 0 ? 'done' : i === 1 ? 'now' : 'next')
      const host = states.lastIndexOf('now')
      body += `<div class="items">${list.map((it, i) => {
        const is = states[i]
        const tail = is === 'now' ? `<em class="irt">  ·  ${clock(now - starts[k] + 25000)}</em>` : is === 'done' ? `<em class="itd">  ·  ${timeOfDay(now - (list.length - i) * 7 * 60000)}</em>` : ''
        const row = `<div class="item ${is}">${dark(badgeSvg(is, 0, 16, i > 0, i < list.length - 1))}<span>${esc(it)}${tail}</span></div>`
        const strip = act && i === host ? `<div class="strip">${dark(stripSvg({ title: mission.helper ?? 'Check the tests cover it', detail: 'Haiku', state: 'running', time: `${Math.floor(((now - starts[k]) / 1000) % 60)}s` }))}</div>` : ''
        return row + strip }).join('')}</div>`
    }
    const chev = s === 'now' ? '−' : ''
    const card = `<div class="card ${s}${k === extraStage ? ' added enter' : ''}"><div class="card-row"><span class="badge">${dark(badgeSvg(s, now, 16))}</span>` +
      `<span class="card-name">${esc(name)}</span><span class="card-time">${t}</span><span class="chev">${chev}</span></div>${body}</div>`
    const exit = mission.exits[k] ? `<div class="p-exit">${dark(exitSvg(mission.exits[k], isLast, false))}</div>` : '<div class="p-gap"></div>'
    return `<div class="flow" data-k="${k}">${card}${exit}</div>`
  }).join('')
  const total = done ? `<div class="p-done">All ${n} stages are done.<span>  ·  took ${clock(TOOK.slice(0, n).reduce((a, b) => a + b, 0) * 1000)}</span></div>` : ''
  return `<div class="p-tabs"><span class="p-tab on">Progress</span><span class="p-tab">PRs</span></div>` +
    `<div class="p-head"><div class="p-title">Project: ${esc(mission.project)}</div><span class="p-age">${clockAgo(now - (lastAt ?? now - 4000))}</span></div><div class="p-goal">${esc(mission.goal)}</div>${total}` +
    `<div class="p-track">${track}</div><div class="p-stages">${flow}</div>`
}

// Hero: the selected mission plays through its stages, one every few seconds, then starts again.
const heroStarts = []
// When the agent last sent a state: each step of the demo is one update, so the header's age goes back to 0s.
let heroLast = Date.now()
let heroKey = '', heroFull = ''
const roots0 = () => !!$('pane').firstChild
// Each second only the live text changes in place; a stage change glides the cards to their new places.
function paneTick(root, now, act) {
  const k = state.phase, q = s => root.querySelector(s)
  const set = (el, v) => { if (el && el.textContent !== v) el.textContent = v }
  set(q('.card.now .card-time'), clock(now - heroStarts[k] + 37000))
  set(q('.card.now .irt'), `  \u00b7  ${clock(now - heroStarts[k] + 25000)}`)
  set(q('.p-age'), clockAgo(now - heroLast))
}
// A stage change: each stage row keeps its place in the flow, so the old and new rows pair by stage. Each row glides
// from its old top and height to its new ones, and its new content fades in, so a card folds and the next one opens.
// A state change morphs instead of swapping: each stage row, item and the stage bar carry a view-transition name,
// so the browser moves and resizes each one from its old look to its new look and cross-fades the two. The folding
// row moves first; the opening row follows a beat later. Without the API (or with reduced motion) it swaps at once.
const VT = typeof document.startViewTransition === 'function'
let vtBusy = false
function morph(apply, { open = -1, short = false } = {}) {
  if (!VT || REDUCED || vtBusy || document.hidden) return apply()
  const seq = document.getElementById('vt-seq') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'vt-seq' }))
  seq.textContent = (short ? '::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: .45s !important; }' : '') +
    (open >= 0 ? `::view-transition-group(ms-row-${open}), ::view-transition-old(ms-row-${open}), ::view-transition-new(ms-row-${open}) { animation-delay: .38s; }` : '')
  vtBusy = true
  const t = document.startViewTransition(apply)
  t.finished.finally(() => { vtBusy = false })
}
function paneSwap(root, html, glide) {
  if (!glide) { root.innerHTML = html; return }
  morph(() => { root.innerHTML = html }, { open: state.done ? -1 : state.phase })
}
function heroRender(force = false) {
  if (!force && Date.now() < heroHold) return
  const now = Date.now()
  const act = `${ACTS[(state.phase + Math.floor(now / 4000)) % ACTS.length]} ${Math.floor(((now - heroStarts[state.phase]) / 1000) % 60)}s`
  const key = `${state.mission.project}|${state.phase}|${state.done}`, full = `${key}|${state.item}`
  const itemOnly = !force && key === heroKey && full !== heroFull && roots0()
  heroFull = full
  const roots = [$('pane')]
  if (!itemOnly && !force && key === heroKey && roots[0].firstChild) return roots.forEach(r => paneTick(r, now, act))
  const glide = !force && key.split('|')[0] === heroKey.split('|')[0] && !REDUCED
  heroKey = key
  const itemStates = state.mission.items.map((_, i) => i < state.item ? 'done' : i === state.item ? 'now' : 'next')
  const html = paneHtml({ mission: state.mission, phase: state.phase, done: state.done, now, act, starts: heroStarts, itemStates, lastAt: heroLast })
  // Only an item finished: swap that stage's item list in place, so nothing else moves.
  if (itemOnly) {
    const t = document.createElement('div'); t.innerHTML = html
    const fresh = t.querySelector('.card.now .items')
    return morph(() => roots.forEach(r => { if (!r) return; const old = r.querySelector('.card.now .items'); if (old && fresh) old.replaceWith(fresh.cloneNode(true)); paneTick(r, now, act) }), { short: true })
  }
  roots.forEach(r => paneSwap(r, html, glide))
}
function heroReset() {
  const now = Date.now()
  heroStarts.length = 0
  // Earlier stages get plausible sample durations so the done timers read as real work.
  const back = [214, 388, 162, 301, 245, 190]
  let t = now
  heroStarts[0] = now
  state.phase = REDUCED ? Math.min(2, state.mission.stages.length - 1) : 0
  for (let k = state.phase - 1; k >= 0; k--) { t -= back[k % back.length] * 1000; heroStarts[k] = t }
  heroStarts[state.phase] = now
  state.done = false; state.item = 0
  heroRender(true)
}
// Each step finishes one item; the last item of a stage finishes the stage. A finished mission rests a moment, then starts again.
let heroRest = 0, heroCalm = 0
function heroStep() {
  if (Date.now() < heroHold) return
  const n = state.mission.stages.length
  if (state.done) { if (++heroRest < 4) return; heroRest = 0; return heroReset() }
  if (heroCalm > 0) { heroCalm--; return }
  heroLast = Date.now()
  if (state.item < state.mission.items.length - 1) { state.item++; return heroRender() }
  state.item = 0; heroCalm = 2
  if (state.phase >= n - 1) { state.done = true; heroStarts[n] = Date.now() } else { state.phase++; heroStarts[state.phase] = Date.now() }
  heroRender()
}

function pick(m) {
  building++
  $('pane').className = 'pane'
  state.mission = m
  for (const b of $('missions').children) { const on = b.dataset.key === m.key; b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1 }
  if (m.key === 'agent') {
    const t = document.querySelector('[data-key="agent"]')
    t.classList.remove('burst'); void t.offsetWidth; t.classList.add('burst')
    agentBuild(); return
  }
  heroReset()
  swap()
}
function swap(kind = 'swap') {
  const p = $('pane')
  p.classList.remove('swap', 'drop'); void p.offsetWidth; p.classList.add(kind)
  const step = kind === 'drop' ? 0.14 : 0.045
  p.querySelectorAll('.card, .p-exit, .p-gap').forEach((el, i) => { el.style.animationDelay = `${i * step}s` })
  clearTimeout(swap.t); swap.t = setTimeout(() => p.classList.remove(kind), kind === 'drop' ? 2600 : 1400)
  heroHold = Date.now() + (kind === 'drop' ? 2600 : 1400)
}
let heroHold = 0

let building = 0
const sleep = ms => new Promise(r => setTimeout(r, ms))
// The agent writes its stages: the old pane fades down, then the new one settles in part by part, each a beat after the last.
async function agentBuild() {
  const id = ++building, p = $('pane')
  heroHold = Date.now() + 60000
  const ease = EASE
  await p.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(6px)' }],
    { duration: 360, easing: EASE, fill: 'forwards' }).finished.catch(() => {})
  if (id !== building) return
  state.mission = AGENT; heroHold = 0; heroReset()
  p.getAnimations().forEach(a => a.cancel())
  const parts = [...p.querySelectorAll('.p-head, .p-goal, .p-track, .p-stages > *')]
  parts.forEach((e, i) => e.animate(
    [{ opacity: 0, transform: 'translateY(10px)', filter: 'blur(3px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: 700, delay: 60 + i * 85, easing: ease, fill: 'backwards' }))
}

const AGENT = AGENT_MISSION
const HERO_TABS = ['feature', 'bug-fix', 'incident', 'research'].map(k => MISSIONS.find(m => m.key === k)).concat(AGENT)
for (const m of HERO_TABS) {
  const b = document.createElement('button')
  b.type = 'button'; b.role = 'radio'; b.dataset.key = m.key
  const MI = { feature: '<path d="M12 5v14M5 12h14"/>', 'bug-fix': '<path d="M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0zM12 9v9M4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 19l3-2M19 19l-3-2"/>', incident: '<path d="M12 4 2.5 20h19zM12 10v4M12 17v.5"/>', research: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>' }
  const ico = MI[m.key] ? `<svg class="mi" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MI[m.key]}</svg>` : ''
  const spark = m.key === 'agent' ? '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l2.3 7.7L22 12l-7.7 2.3L12 22l-2.3-7.7L2 12l7.7-2.3z"/></svg>' : ''
  b.innerHTML = `${spark}${ico}<span>${esc(m.label)}</span>`
  b.style.animationDelay = `${0.45 + HERO_TABS.indexOf(m) * 0.05}s`
  b.setAttribute('aria-checked', 'false')
  b.addEventListener('click', () => pick(m))
  $('missions').append(b)
}
// The missions are one radio group: Tab reaches the chosen one, and the arrow keys move the choice, as a radio group does.
$('missions').addEventListener('keydown', e => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
  if (step === undefined) return
  e.preventDefault()
  const all = [...$('missions').children], at = all.indexOf(document.activeElement)
  const next = all[(at + step + all.length) % all.length]
  next.focus(); next.click()
})

// The chat beside the pane: the agent's wall of text. Each line that scrolls past adds its words to the counter.
const roll = $('chat-roll')
let chatIdx = 0
function chatLine() {
  let [text, kind] = CHAT[chatIdx % CHAT.length]
  chatIdx++
  // One skeleton block per message: tool lines fold into their message.
  while (kind === 1) { [text, kind] = CHAT[chatIdx % CHAT.length]; chatIdx++ }
  const el = line(text, kind); el.classList.add('typing'); roll.append(el)
  // Push the older messages up smoothly: start the column down by the new message's height, then let it rise.
  if (!REDUCED) {
    const h = el.offsetHeight + parseFloat(getComputedStyle(el).marginBottom || '0')
    roll.style.transition = 'none'; roll.style.transform = `translateY(${h}px)`
    void roll.offsetHeight
    roll.style.transition = `transform 1.1s ${EASE}`; roll.style.transform = 'translateY(0)'
    el.animate([{ opacity: 0, transform: 'translateY(14px) scale(.97)' }, { opacity: 1, transform: 'none' }],
      { duration: 900, delay: 120, easing: EASE, fill: 'backwards' })
  }
  while (roll.children.length > 40) roll.firstChild.remove()
  roll.parentElement.scrollTop = roll.parentElement.scrollHeight
}
function line(text, kind) {
  const p = document.createElement('p')
  if (kind === 1) p.className = 'tool'
  if (kind === 2) p.className = 'user'
  p.textContent = text
  return p
}

// The wall: three claims count from the old figure to the new one once when the section scrolls into view (end state when motion is reduced).
function wallCount() {
  const nums = [...document.querySelectorAll('#wall [data-to]')]
  const fmt = (el, v) => { el.textContent = Math.round(v).toLocaleString('en-US') }
  const end = () => nums.forEach(el => fmt(el, Number(el.dataset.to)))
  if (REDUCED || !('IntersectionObserver' in window)) return end()
  nums.forEach(el => fmt(el, Number(el.dataset.from)))
  const io = new IntersectionObserver(es => {
    if (!es.some(e => e.isIntersecting)) return
    io.disconnect()
    nums.forEach(el => {
      const from = Number(el.dataset.from), to = Number(el.dataset.to), delay = Number(el.dataset.delay || 0), t0 = performance.now() + delay
      const step = t => {
        const k = Math.max(0, Math.min(1, (t - t0) / 1400))
        fmt(el, from + (to - from) * (1 - (1 - k) ** 4))
        if (k < 1) requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  }, { threshold: 0.35 })
  io.observe($('wall'))
}
wallCount()

// Sections fade up as they enter the view.
if (!REDUCED && 'IntersectionObserver' in window) {
  document.documentElement.classList.add('motion')
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } }), { threshold: 0.15 })
  document.querySelectorAll('section.wrap, .foot').forEach(el => { el.classList.add('reveal'); io.observe(el) })

}

// Glance: scroll moves through six features. Each one is its own part of the pane, drawn large, swiping in and out.
const GS_NAMES = ['Plan', 'Build', 'Test', 'Deploy', 'Learn']
const big = (inner, cls = '') => `<div class="gs ${cls}"><div class="gs-inner">${inner}</div></div>`
function glanceSlides() {
  const exits = ['the plan is approved', 'the code is on a branch', 'all tests pass']
  const card = (st, name, extra = '') => `<div class="card ${st}"><div class="card-row"><span class="badge">${dark(badgeSvg(st, 0))}</span><span class="card-name">${name}</span><span class="card-time">${st === 'now' ? '<b class="gs-clock">00:00</b>' : st === 'done' ? '04:20' : ''}</span></div>${extra}</div>`
  // Items as the pane writes them: a done one with the time it was done, the one in progress with its timer.
  const tail = st => st === 'done' ? `<em class="itd">  ·  ${timeOfDay(Date.now() - 9 * 60000)}</em>` : st === 'now' ? '<em class="irt">  ·  <b class="gs-clock">00:00</b></em>' : ''
  const items = `<div class="items">${[['done', 'Save button'], ['now', 'Saved list'], ['next', 'Sync across devices']].map(([st, x], i) => `<div class="item ${st}">${dark(badgeSvg(st, 0, 16, i > 0, i < 2))}<span>${x}${tail(st)}</span></div>`).join('')}</div>`
  // The helpers the agent runs now, under the item in progress, as the pane draws them.
  const helpers = `<div class="items"><div class="item now">${dark(badgeSvg('now', 0, 16))}<span>Saved list tests</span></div>` +
    ['Run the test suite', 'Check the tests cover it'].map((t, i) => `<div class="strip">${dark(stripSvg({ title: t, detail: i ? 'Haiku' : 'Sonnet', state: 'running', time: `${12 + i * 9}s` }))}</div>`).join('') + '</div>'
  return [
    big(`<div class="p-track">${dark(trackSvg({ total: 5, done: 2, current: 'Test', isDone: false, names: GS_NAMES }))}</div>`, 'gs-wide'),
    big(exits.map((e, i) => `<div class="p-exit">${dark(exitSvg(e, i === 2))}</div>`).join('')),
    big(card('now', 'Test', helpers)),
    big(card('now', 'Build', items)),
    big(card('now', 'Build', `<div class="card-links">${['Plan', 'Spec', 'Preview', 'Test report'].map(x => `<span class="lk">↗ ${x}</span>`).join('')}</div>`)),
    big(`<div class="gs-adapt" id="gs-adapt"></div>`),
    big(`<div class="quiet2"><div class="qc"><p class="qh">Without the pane</p><p class="qm">Still running the tests.</p><p class="qm">Halfway through the saved list.</p><p class="qm">Here is where things stand: the list renders; sync has not started.</p><p class="qm buried">Moving on to sync. One question: on a conflict, keep the last write, or merge both?</p><p class="qm">Tests pass. Starting the review.</p></div><div class="qc calm"><p class="qh">With the pane</p><p class="q-msg"><em>Needs you</em>Sync conflict: keep the last write, or merge both?</p></div></div>`, 'gs-quiet'),
  ].join('')
}
let feat = -1, adaptTimer = 0
// "That it adapts" as a story: a note from the agent, a stage grows in and pushes the rest down, the track gains a
// segment; then another note, a stage shrinks away, the track loses it. It loops while this step is on screen.
const ADAPT_BASE = ['Plan', 'Build', 'Test', 'Deploy', 'Learn']
function adaptTrack(names) { return `<div class="p-track">${dark(trackSvg({ total: names.length, done: 1, current: 'Build', isDone: false, names }))}</div>` }
// A done stage folds to one line, as in the pane; the stage in progress and the later ones are cards.
function adaptCard(n, k) {
  const st = k < 1 ? 'done' : k === 1 ? 'now' : 'next'
  if (st === 'done') return `<div class="flow fold" data-n="${n}"><div class="fold-row">${dark(badgeSvg('done', 0, 14))}<span class="f-name">${n}</span><span class="f-gate">✓ the plan is approved</span></div></div>`
  return `<div class="card ${st}" data-n="${n}"><div class="card-row"><span class="badge">${dark(badgeSvg(st, 0))}</span><span class="card-name">${n}</span></div></div>`
}
function adaptRender() {
  $('gs-adapt').innerHTML = `<div class="a-track">${adaptTrack(ADAPT_BASE)}</div><div class="a-cards">${ADAPT_BASE.map(adaptCard).join('')}</div>`
}
async function adaptStory(token) {
  const root = $('gs-adapt'); if (!root) return
  adaptRender()
  const cards = root.querySelector('.a-cards'), track = root.querySelector('.a-track')
  const SPARK = '<svg class="a-spark" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M12 2l2.3 7.7L22 12l-7.7 2.3L12 22l-2.3-7.7L2 12l7.7-2.3z"/></svg>'
  await sleep(900); if (token !== adaptTimer) return
  const sec = document.createElement('div'); sec.innerHTML = adaptCard('Security', 2); const el = sec.firstChild
  el.classList.add('grow', 'added'); el.insertAdjacentHTML('beforeend', `<div class="a-why">${SPARK}Found an auth change. Adding a security review.</div>`); cards.children[1].after(el)
  track.innerHTML = adaptTrack(['Plan', 'Build', 'Security', 'Test', 'Deploy', 'Learn'])
  await sleep(2200); if (token !== adaptTimer) return
  const learn = cards.querySelector('[data-n="Learn"]')
  learn.insertAdjacentHTML('beforeend', `<div class="a-why">${SPARK}Not needed for this one.</div>`)
  await sleep(1300); if (token !== adaptTimer) return
  learn.classList.add('shrink')
  track.innerHTML = adaptTrack(['Plan', 'Build', 'Security', 'Test', 'Deploy'])
  await sleep(1800); if (token !== adaptTimer) return
  adaptStory(token)
}
function glanceSet(k) {
  if (k === feat) return
  feat = k
  ;[...$('gs-stage').children].forEach((g, i) => { g.classList.toggle('on', i === k); g.classList.toggle('past', i < k) })
  ;[...$('feats').children].forEach((g, i) => g.classList.toggle('on', i === k))
  adaptTimer++
  if (k === 5) { if (REDUCED) adaptRender(); else adaptStory(adaptTimer) }
}
function glanceScroll() {
  const sec = $('shape'), r = sec.getBoundingClientRect()
  const p = Math.min(1, Math.max(0, -r.top / Math.max(1, sec.offsetHeight - innerHeight)))
  $('glance-fill').style.width = `${(p * 100).toFixed(1)}%`
  glanceSet(Math.min(6, Math.floor(p * 7)))
}
addEventListener('scroll', glanceScroll, { passive: true })
const gsStart = Date.now()
setInterval(() => { document.querySelectorAll('.gs-clock').forEach(x => { x.textContent = clock(Date.now() - gsStart) }) }, 1000)

// A still pane for a mission at a stage, with sample start times.
function still(m, phase, i) {
  const n = m.stages.length, now = Date.now()
  const starts = m.stages.map((_, k) => now - (n - k) * 260000 - i * 7000)
  return paneHtml({ mission: m, phase: Math.min(phase, n - 1), done: phase >= n, now, act: `${ACTS[(i + phase) % ACTS.length]} 12s`, starts })
}
// The texture: twenty different projects across the templates, each at its own stage, in drifting columns.
// Columns and tiles are counted from the section's size (the strip is rotated 14 degrees), so every column
// reaches past the edges of the view and loops with no gap.
let texW = 0
function texture() {
  const all = [...MISSIONS.filter(x => x.key !== 'custom'), ...VARIANTS, ...CUSTOMS]
  const tiles = all.map((m, i) => ({ m, html: still(m, i % 4 === 3 ? m.stages.length : (i * 2) % m.stages.length, i) }))
  const tex = $('tex'), sec = tex.parentElement
  const W = sec.clientWidth, H = sec.clientHeight, rad = 14 * Math.PI / 180
  const across = W * Math.cos(rad) + H * Math.sin(rad), along = H * Math.cos(rad) + W * Math.sin(rad)
  const cols = Math.ceil(across / 362) + 2
  texW = W
  tex.style.height = `${Math.round(along)}px`
  tex.replaceChildren()
  for (let c = 0; c < cols; c++) {
    const col = document.createElement('div'); col.className = 'tex-col'
    tex.append(col)
    let k = (c * 3) % tiles.length, n = 0
    // One half of the loop: enough tiles to cover the view along the strip, with a margin.
    do {
      const el = document.createElement('div'); el.className = 'pane'; el.innerHTML = tiles[k % tiles.length].html
      col.append(el); k++; n++
    } while (col.offsetHeight < along + 400 && n < tiles.length)
    const half = col.offsetHeight
    for (const el of [...col.children]) col.append(el.cloneNode(true))
    col.style.animationDuration = `${Math.round(half / 22)}s`
  }
}
addEventListener('resize', () => { const w = $('tex').parentElement.clientWidth; if (w !== texW) { clearTimeout(texTimer); texTimer = setTimeout(texture, 200) } })
let texTimer = 0

// Ships with ten: one row per template as the tile scrolls into view, its stage cells cascading in after the name.
{
  $('shapes').innerHTML = MISSIONS.filter(x => x.key !== 'custom').map((m, r) => {
    const now = (r * 2 + 1) % m.stages.length
    const cells = m.stages.map((x, k) => `<u class="${k < now ? 'done' : k === now ? 'now' : 'next'}" style="--i:${k}" title="${esc(x)}"></u>`).join('')
    return `<div class="tshape" style="--r:${r}"><span>${esc(m.label)}</span><i>${cells}</i></div>`
  }).join('')
  if ('IntersectionObserver' in window) {
    const io3 = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io3.unobserve(e.target) } }), { threshold: 0.35 })
    io3.observe($('shapes'))
  } else $('shapes').classList.add('in')
}
// Or its own: the old stages fade down, the project name writes in, then each stage rises in.
const OWN_SETS = [
  [AGENT_MISSION.project, AGENT_MISSION.stages],
  [CUSTOMS[1].project, CUSTOMS[1].stages],
  [CUSTOMS[2].project, CUSTOMS[2].stages],
  ['Accessibility pass', ['Scan', 'Triage', 'Fix contrast', 'Keyboard pass', 'Verify']],
  ['Payments cut-over', ['Contract', 'Sandbox', 'Webhooks', 'Shadow traffic', 'Cut over']],
]
let ownIdx = 0, ownTimer = 0
async function ownLoop() {
  const id = ++ownTimer, el = $('own'), live = () => id === ownTimer
  for (;;) {
    const [title, stages] = OWN_SETS[ownIdx % OWN_SETS.length]
    const old = el.querySelectorAll('.own-card')
    if (old.length && !REDUCED) { old.forEach(c => c.classList.add('out')); el.querySelector('.own-name')?.classList.add('out'); await sleep(520); if (!live()) return }
    // You give the mission (it appears whole); the agent writes the stages under it, one after another.
    el.innerHTML = `<p class="own-name"><em>Your mission</em><span>${esc(title)}</span></p>`
    if (!REDUCED) { el.querySelector('.own-name').animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 520, easing: EASE }); await sleep(560); if (!live()) return }
    const cards = stages.map(name => { const c = document.createElement('div'); c.className = 'own-card'; c.textContent = name; el.append(c); return c })
    if (REDUCED) { cards.forEach(c => c.classList.add('in')); return }
    await sleep(200); if (!live()) return
    for (const c of cards) { c.classList.add('in'); await sleep(90); if (!live()) return }
    await sleep(3000); if (!live()) return
    ownIdx++
  }
}
$('own-next').addEventListener('click', () => { ownIdx++; ownLoop() })
ownLoop()
// Install: copy the two commands to paste into Claude Code. One copy for both install buttons: a clipboard that does
// not answer in 800 ms counts as blocked, so a press always gets an answer.
const INSTALL = ['/plugin marketplace add oficiallyAkshay/mission-status', '/plugin install mission-status@mission-status']
async function copyInstall() {
  try { return await Promise.race([navigator.clipboard.writeText(INSTALL.join('\n')).then(() => true), sleep(800).then(() => false)]) } catch { return false }
}
$('install').addEventListener('click', async () => {
  const ok = await copyInstall()
  $('install-note').textContent = ok ? 'Copied both commands. Paste them into Claude Code in the desktop app.' : `In Claude Code, run: ${INSTALL[0]}, then ${INSTALL[1]}`
})
pick(HERO_TABS[0])
texture()
$('gs-stage').innerHTML = glanceSlides()
glanceSet(0)
glanceScroll()
for (let i = 0; i < 22; i++) chatLine()
setInterval(() => { if (!REDUCED) heroRender() }, 1000)
if (!REDUCED) {
  setInterval(heroStep, STEP_MS)
  setInterval(chatLine, 3200)
}

// The repository numbers, in the hero and the footer: stars and forks from GitHub, clones and views from the
// clonometer files on the badges branch. A small count shows as a floor ("< 10"), never as an exact low number.
// A source that does not answer keeps the floor already in the page.
const REPO_API = 'https://api.github.com/repos/oficiallyAkshay/mission-status'
const BADGES = 'https://raw.githubusercontent.com/oficiallyAkshay/mission-status/badges/'
const floorOf = (n, floor) => (n < floor ? `< ${floor}` : n.toLocaleString('en-US'))
async function getJson(url) { try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : null } catch { return null } }
async function repoNumbers() {
  const [repo, clones, views] = await Promise.all([getJson(REPO_API), getJson(`${BADGES}clones.json`), getJson(`${BADGES}views.json`)])
  const got = {
    stars: typeof repo?.stargazers_count === 'number' ? floorOf(repo.stargazers_count, 10) : null,
    forks: typeof repo?.forks_count === 'number' ? floorOf(repo.forks_count, 10) : null,
    clones: typeof clones?.total === 'number' ? floorOf(clones.total, 50) : null,
    views: typeof views?.total === 'number' ? floorOf(views.total, 50) : null,
  }
  for (const [k, v] of Object.entries(got)) { const dd = document.querySelector(`#hero-meta [data-k="${k}"] dd`); if (dd && v !== null) dd.textContent = v }
  const bar = document.querySelector('.ff-bar')
  for (const d of document.querySelectorAll('#hero-meta > div')) {
    const cell = document.createElement('div'); cell.className = 'm'
    const label = document.createElement('span'); label.className = 'l'; label.append(document.createElement('i'), d.querySelector('dt').textContent)
    const value = document.createElement('b'); value.textContent = d.querySelector('dd').textContent
    cell.append(label, value); bar.append(cell)
  }
  bar.hidden = bar.children.length === 0
}
repoNumbers()

// The end: fit the wordmark to the page width, and ease the closing parts in.
function theEnd() {
  const end = document.querySelector('.tex-end')
  const word = document.querySelector('.foot-word span'), fit = () => {
    word.style.fontSize = '100px'
    const box = word.parentElement, cs = getComputedStyle(box), room = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    word.style.fontSize = `${Math.floor(100 * room / word.getBoundingClientRect().width)}px`
  }
  fit(); addEventListener('resize', fit); document.fonts?.ready.then(fit)
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) } }), { threshold: 0.2 })
    io.observe(end)
  } else end.classList.add('in')
}
theEnd()

// FAQ: an answer opens and closes with a height animation instead of a jump.
for (const d of document.querySelectorAll('.qa')) {
  const s = d.querySelector('summary'), a = d.querySelector('.qa-a')
  s.addEventListener('click', e => {
    if (REDUCED) return
    e.preventDefault()
    if (d.open) {
      const h = a.offsetHeight
      a.animate([{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 380, easing: EASE }).onfinish = () => { d.open = false }
    } else {
      d.open = true
      const h = a.offsetHeight
      a.animate([{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 1 }], { duration: 480, easing: EASE })
    }
  })
}

// Works with: the tiles rise in one after another when the wall scrolls into view.
{
  const wall = document.querySelector('.logos')
  document.querySelectorAll('.lw').forEach((t, i) => { t.style.transitionDelay = `${i * 70}ms` })
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { wall.classList.add('in'); io.disconnect() } }, { threshold: 0.25 })
    io.observe(wall)
  } else wall.classList.add('in')
}

// The install, played: one press copies both commands, then the block types them and shows what Claude Code answers.
// The site installs nothing; the reader pastes the commands into Claude Code.
{
  const btn = $('end-install'), label = $('end-install-l'), code = $('end-cmd'), note = $('end-note')
  const CMDS = INSTALL
  const SAYS = ['Marketplace added', 'mission-status installed']
  let run = 0
  btn.addEventListener('click', async () => {
    const id = ++run, live = () => id === run
    const ok = await copyInstall()
    btn.classList.add('going'); label.textContent = ok ? 'Copied. Watch it install' : 'Select the commands and copy them'
    code.innerHTML = ''
    const line = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; code.append(s); return s }
    for (let i = 0; i < CMDS.length; i++) {
      const s = line('ti-cmd', '')
      if (REDUCED) s.textContent = CMDS[i]
      else for (let k = 1; k <= CMDS[i].length; k++) { s.textContent = CMDS[i].slice(0, k); await sleep(18); if (!live()) return }
      await sleep(REDUCED ? 0 : 380); if (!live()) return
      const r = line('ti-ok', `✓ ${SAYS[i]}`)
      if (!REDUCED) r.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE })
      await sleep(REDUCED ? 0 : 420); if (!live()) return
    }
    const last = line('ti-next', '→ Open the pane: /mission-status')
    if (!REDUCED) last.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, easing: EASE })
    btn.classList.remove('going'); if (ok) btn.classList.add('done')
    else { const r = document.createRange(); r.selectNodeContents(code); const s = getSelection(); s.removeAllRanges(); s.addRange(r) }
    label.textContent = ok ? 'Copied. Paste into Claude Code.' : 'Select the commands and copy them'
    note.textContent = 'This played what Claude Code shows. The site installs nothing.'
  })
}
