import { openPane } from './surface'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Job, Summary, Task, Wakeup } from '../types'
import { RULE, UPDATE_TOOL, applyGoal, goalOf, CAP_BYTES, applyPlan, applyUpdate, argsOf, bytesOf, checkUpdate, idOf, normalize, parentLoops, refusalOf, stepsStarted, PR_MAKERS, prRefsIn, prRefsInLines, branchesIn, unionRefs, byteLength, skillSteps, TEMPLATES_KEY, asTemplates, templatesLine } from './model'
import { paneSeen, poll } from './readers'
import { CLOCK_MS, PANE, savedKey, TICK_MS, TITLE, afterToolCall, agentUpdated, addJob, applyWakeup, jobsAtTurnEnd, stopJob, atTurnEnd, noteSteps, noteTurnEnd, noteTurnStart, settle, heldReasons, noteEvent, tick, tickIfTimer } from './store'
import { renderPane } from './view'
import { applyNotifications } from './watches'
import { UPDATE_SCHEMA } from './update-schema'
import { registerMetrics } from './metrics'
import { registerOnboarding } from './onboarding'
import { registerUpdate } from './update'
import { registerDoc } from './doc'
import { registerMarker } from './marker'
import { registerQuiet } from './quiet'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
// Wakeups the session scheduled: the Watching strip shows each until it is due.
const wakeups = atom({ plugin: 'mission-status', key: 'wakeups' } as const, [] as Wakeup[])
// Background jobs in flight: the Watching strip shows them.
const jobs = atom({ plugin: 'mission-status', key: 'jobs' } as const, [] as Job[])
// The live facts the state machine reads (store.ts declares the same keys).
const turnOpen = atom({ plugin: 'mission-status', key: 'turnOpen' } as const, false as boolean)
// Background work (a shell job, a subagent, a workflow) still in flight when the last turn ended: the work goes on.
// A headless run (claude -p, an SDK host, a helper job): no person sees a pane (metrics.tsx writes it at session start).
const headless = atom({ plugin: 'mission-status', key: 'headless' } as const, false as boolean)
const background = atom({ plugin: 'mission-status', key: 'background' } as const, false as boolean)
const waiting = atom({ plugin: 'mission-status', key: 'waiting' } as const, false as boolean)
// The pull requests this session made, read from its gh pr create and Marga calls; the PRs tab lists them.
const prRefs = atom({ plugin: 'mission-status', key: 'prRefs' } as const, [] as string[])
// The branches this session's own tool inputs name: readers.ts keeps a listed pull request whose head is one of them.
const prBranches = atom({ plugin: 'mission-status', key: 'prBranches' } as const, [] as string[])
async function addBranches($: EngineInterface, found: Iterable<string>): Promise<void> {
  const have = await read($, prBranches)
  const add = [...found].filter(b => !have.includes(b))
  if (add.length > 0) await update($, prBranches, list => [...list, ...add.filter(b => !list.includes(b))].slice(-50))
}

// The transcript scan: the byte where it stopped (always a line start), and the calls seen that may make a pull request.
let scanAt = 0
let scanBusy = false
const scanCreates = new Set<string>()
const scanBranches = new Set<string>()
// The transcript the scan position and the calls seen belong to; another path starts the scan again.
let scanPath: string | null = null
const SCAN_PART = 4 * 1024 * 1024

export { unionRefs }

// The 1 s and 5 s clocks the session registered; a new session.start cancels them before it registers again.
let cancels: { cancel: () => void }[] = []

// Reads the session's transcript from where the last scan stopped, in parts of at most 4 MiB (the read limit), and
// adds each pull request a gh pr create or Marga call made to the PRs tab. Deterministic: no model, and nothing is missed
// from before the pane loaded.
async function scanTranscript($: EngineInterface): Promise<void> {
  if (scanBusy) return
  scanBusy = true
  try {
    const path = (await $.session.info()).transcriptPath
    if (path !== scanPath) {
      scanPath = path
      scanAt = 0
      scanCreates.clear()
      scanBranches.clear()
    }
    const size = (await $.fs.stat(path)).size
    if (size < scanAt) scanAt = 0
    const found: string[] = []
    for (let parts = 0; scanAt < size && parts < 20; parts++) {
      const text = (await $.fs.read(path, { offset: scanAt, length: SCAN_PART })) as string
      // Only whole lines are read: the next part starts at the start of a line, so no character is cut in two.
      const end = text.lastIndexOf('\n')
      if (end < 0) {
        // A tail with no newline and less than a whole part is a line still being written: wait for the next tick.
        if (size - scanAt < SCAN_PART) break
        // One line longer than a whole part (a huge tool result) is skipped, so the scan never stalls on it.
        scanAt += byteLength(text)
        continue
      }
      const whole = text.slice(0, end + 1)
      scanAt += byteLength(whole)
      for (const ref of prRefsInLines(whole.split('\n'), scanCreates, scanBranches)) if (!found.includes(ref)) found.push(ref)
    }
    await addBranches($, scanBranches)
    if (found.length > 0) {
      await update($, prRefs, list => unionRefs(list, found))
      void settle($)
      void poll($, true)
    }
  } catch {
    // A transcript that cannot be read leaves the PRs the tool calls showed.
  } finally {
    scanBusy = false
  }
}

// The pane's state lives in $.state, which the app holds in memory: an app quit loses it. So each write also goes to
// $.store under the session's transcript file name, and a session that starts with no state (an app restart, a
// resume) takes it back from there (store.ts saves it, from settle).
export async function restorePane($: EngineInterface): Promise<boolean> {
  if ((await read($, summary)) !== null) return false
  const key = await savedKey($)
  if (key === null) return false
  const kept = (await $.store.get(key).catch(() => undefined)) as { summary?: Summary; tasks?: Task[]; prRefs?: unknown; prBranches?: unknown } | undefined
  const back = normalize(kept?.summary ?? null)
  if (back === null) return false
  await update($, summary, now => (now === null ? back : now))
  if (Array.isArray(kept?.tasks)) await update($, tasks, now => (now.length === 0 ? (kept?.tasks ?? []) : now))
  // The PRs tab keeps the pull requests the session made before the restart.
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const refs = strings(kept?.prRefs)
  await addBranches($, strings(kept?.prBranches))
  if (refs.length > 0) {
    await update($, prRefs, now => unionRefs(refs, now))
    void poll($, true)
  }
  return true
}

// A background job the session starts (a Bash call in the background, a Monitor) joins the Watching strip; a TaskStop
// takes it out. Main-loop calls only.
async function trackJob($: EngineInterface, e: { tool: unknown; agentId?: string }, result: unknown): Promise<void> {
  try {
    const args = e as unknown as Record<string, unknown>
    if (e.agentId !== undefined) return
    if (String(e.tool) === 'TaskStop') {
      const id = String(args.task_id ?? args.shell_id ?? '')
      await update($, jobs, list => stopJob(list ?? [], id, Date.now()))
    } else {
      await update($, jobs, list => addJob(list ?? [], String(e.tool), args, JSON.stringify(result ?? ''), Date.now()))
    }
  } catch {}
}

export const register: Register = on => {
  // Each wave-1 part keeps its hooks in its own file.
  registerOnboarding(on)
  registerMetrics(on)
  registerUpdate(on)
  registerDoc(on)
  registerMarker(on)
  registerQuiet(on)

  on('session.start', async ($, e, next) => {
    // A new or resumed session starts with no turn running, no background work and no question open.
    await update($, turnOpen, () => false).catch(() => undefined)
    await update($, background, () => false).catch(() => undefined)
    await update($, waiting, () => false).catch(() => undefined)
    await $.tool.register(UPDATE_SCHEMA)
    await $.command.register({ name: 'mission-status', description: 'Open the Mission status pane' })
    for (const handle of cancels) handle.cancel()
    cancels = [
      $.clock.every(CLOCK_MS, () => void tickIfTimer($)),
      $.clock.every(TICK_MS, () => {
        // The reads, then a settle: a helper that ended or a CI read that went old changes a status with no event.
        void poll($).then(() => settle($))
        void scanTranscript($)
      }),
    ]
    // The PRs tab: every pull request this session made, from its transcript, read from the start and then as it grows.
    void scanTranscript($)
    void poll($)
    // An app restart or a resume starts with no state: take back the last saved one.
    await restorePane($).catch(() => false)
    if ((await read($, summary)) !== null) {
      await paneSeen($).catch(() => undefined)
      void openPane($, { id: PANE, title: TITLE })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A tool call on the main loop proves a turn runs, even when this module loaded after the turn's start (a reload,
    // an update, a restore), so the state machine never mistakes a working session for an idle one.
    if (e.agentId === undefined && !(await read($, turnOpen).catch(() => true))) {
      await update($, turnOpen, () => true).catch(() => undefined)
      void noteEvent($)
      void settle($)
    }
    if (e.agentId === undefined) void noteEvent($)
    const result = await next(e)
    // A pull request the session made joins the PRs tab; a branch its input names lets the PR list find one.
    try {
      const args = e as unknown as { command?: unknown }
      const command = String(e.tool) === 'Bash' && typeof args.command === 'string' ? args.command : ''
      await addBranches($, branchesIn(command))
      // Only a pull-request maker's result is turned into text: most results are large and name none.
      const made = PR_MAKERS.test(command) ? prRefsIn(command, JSON.stringify(result ?? '')) : []
      if (made.length > 0) {
        await update($, prRefs, list => unionRefs(list, made))
        void settle($)
        void poll($, true)
      }
    } catch {}
    // A skill the session runs, with numbered steps, joins the tabs as a runbook; the agent marks its steps as it goes.
    try {
      if (String(e.tool) === 'Skill') {
        const name = String((e as unknown as { skill?: unknown }).skill ?? '').trim()
        const dir = /Base directory for this skill:\s*(\S[^\n"]*)/.exec(JSON.stringify(result ?? '').replace(/\\n/g, '\n'))?.[1]?.trim()
        if (name !== '' && dir !== undefined) {
          const steps = skillSteps(await $.fs.read(`${dir}/SKILL.md`).catch(() => ''))
          if (steps.length >= 2) {
            const id = `skill-${idOf(name)}`
            await update($, summary, stored => {
              const old = normalize(stored)
              if (old === null || (old.runbooks ?? []).some(r => r.id === id)) return stored
              const book = { id, title: `Skill: ${name}`, href: `${dir}/SKILL.md`, steps: steps.map(n => ({ name: n, status: 'next' as const, note: null, waitsOn: null })) }
              return { ...old, runbooks: [...(old.runbooks ?? []), book].slice(-4), version: (old.version ?? 0) + 1 } as Summary
            })
            await settle($)
          }
        }
      }
    } catch {}
    // Freshness triggers count the main loop's tool calls, not the pane's own update or a helper's calls.
    if (String(e.tool) === UPDATE_TOOL || e.agentId !== undefined || result.deny !== undefined) return result
    const line = await afterToolCall($).catch(() => null)
    return line === null ? result : { ...result, context: [...(result.context ?? []), line] }
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // The live facts the state machine reads: a main-loop turn runs from its start to its end, whatever ends it.
  // A matcher of its own (any turn id), so it stands beside the other modules' turn.start hooks.
  on('turn.start', { turnId: /(?:)/ }, async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turnOpen, () => true).catch(() => undefined)
      void settle($)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('session.end', { reason: /(?:)/ }, async ($, e, next) => {
    await update($, turnOpen, () => false).catch(() => undefined)
    await update($, waiting, () => false).catch(() => undefined)
    await settle($)
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A question to the person: the turn waits on them, so nothing the agent does runs meanwhile.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    await update($, waiting, () => true).catch(() => undefined)
    void settle($)
    try {
      return await next(e)
    } finally {
      await update($, waiting, () => false).catch(() => undefined)
      void settle($)
    }
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // Wrap-up checks off the app's task list, so the pane's copy closes every step too (a denied call changes nothing).
  on('tool.call', { tool: 'mcp__ccd_turn__wrap_up' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      const at = Date.now()
      await update($, tasks, list => (list ?? []).map(t => (t.status === 'done' ? t : { ...t, status: 'done' as const, since: null, doneAt: at }))).catch(() => undefined)
      void noteEvent($)
      await settle($)
    }
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // Slotting: the pane reads the session's task list itself. A step goes into the stage that is in progress when the
  // step first appears; it stays there.
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    try {
      const args = e as unknown as Record<string, unknown>
      const sum = await read($, summary)
      const at = sum === null ? 0 : Math.min(sum.phase, Math.max(0, sum.phases.length - 1))
      const before = await read($, tasks)
      const after = await update($, tasks, list => applyPlan(list, args, at))
      await noteSteps($, stepsStarted(before, after))
      void noteEvent($)
      await settle($)
    } catch {
      // The task list is a nicety: a failed read never holds up the call.
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A background job the session starts (a Bash call in the background, a Monitor) joins the Watching strip; a
  // TaskStop takes it out.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    await trackJob($, e, result)
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const result = await next(e)
    await trackJob($, e, result)
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const result = await next(e)
    await trackJob($, e, result)
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A wakeup the session schedules shows in the Watching strip until it is due.
  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    try {
      const args = e as unknown as Record<string, unknown>
      await update($, wakeups, list => applyWakeup(list ?? [], args, Date.now()))
      void noteEvent($)
    } catch {}
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // After each context compaction the standing rule goes back into the agent's context.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'compact' || (await read($, headless))) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), RULE] }
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A turn ends while the state is stale: hold the end once and ask the agent for an update.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const inFlight = ((e as { background_tasks?: unknown[] }).background_tasks ?? []).length > 0
    await update($, background, () => inFlight).catch(() => undefined)
    const tasks = (e as { background_tasks?: { id?: unknown; type?: unknown; description?: unknown; command?: unknown }[] }).background_tasks ?? []
    await update($, jobs, list => jobsAtTurnEnd(list ?? [], tasks, Date.now())).catch(() => undefined)
    if (result.block !== undefined || (await read($, headless))) return result
    const hold = await atTurnEnd($, e.stop_hook_active)
    return hold === null ? result : { ...result, block: hold }
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turnOpen, () => false).catch(() => undefined)
      await update($, waiting, () => false).catch(() => undefined)
      void noteEvent($)
      void settle($)
    }
    await noteTurnEnd($).catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await noteTurnStart($).catch(() => undefined)
    // A task notification that names a job: a hit on a running watch, or its end (C).
    await update($, jobs, list => applyNotifications(list ?? [], String((e as unknown as { text?: unknown }).text ?? ''), Date.now())).catch(() => undefined)
    // A /goal starts the pane with that goal, or sets the goal line of the one that runs.
    try {
      const ev = e as unknown as { text?: unknown; command?: unknown }
      const goal = goalOf(String(ev.text ?? ''), typeof ev.command === 'string' ? ev.command : undefined)
      if (goal !== null && !(await read($, headless))) {
        const steps = await read($, tasks)
        let made: Task[] | null = null
        await update($, summary, stored => {
          const out = applyGoal(stored, goal, steps ?? [], Date.now())
          made = out.steps
          return out.summary
        })
        if (made !== null) await update($, tasks, () => made as Task[])
        await settle($)
        void openPane($, { id: PANE, title: TITLE })
      }
    } catch {}
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A standing rule for the model: keep the pane current and look again at its stages.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    // A headless session runs as if the pane were not installed: no standing rule.
    if (await read($, headless)) return result
    return {
      sections: [
        ...result.sections,
        {
          id: 'mission-status:progress',
          scope: 'session' as const,
          text: RULE + templatesLine(asTemplates(await $.store.get(TEMPLATES_KEY).catch(() => undefined))),
        },
      ],
    }
  })

  on('command.run', { command: 'mission-status' }, async $ => {
    if (!(await openPane($, { id: PANE, title: TITLE }))) return { text: 'The Mission status pane opens in the Claude desktop app; no app window is attached here.' }
    await paneSeen($).catch(() => undefined)
    void poll($)
    return { text: 'The Mission status pane is open.' }
  })

  on('tool.call', { tool: 'mcp__mission-status__update' }, async ($, e) => {
    const args = argsOf(e as unknown as Record<string, unknown>)
    const at = Date.now()
    // Validation: a state that fails writes nothing, so the pane keeps the last good view; the errors go back to the agent.
    const before = normalize(await read($, summary))
    const personal = asTemplates(await $.store.get(TEMPLATES_KEY).catch(() => undefined))
    const out = { errors: [] as string[] }
    const written = await update($, summary, stored => {
      const old = normalize(stored)
      // Checked inside the write, so the check sees a write that landed since the read above.
      const seen = old?.agentVersion ?? 0
      out.errors = checkUpdate(args, old, seen, personal)
      if (out.errors.length > 0) return stored
      const next = applyUpdate(old, args, at, personal)
      out.errors = parentLoops(next.items)
      if (out.errors.length > 0) return stored
      if (bytesOf(next) > CAP_BYTES) {
        out.errors = ['the state would pass the 32 KB cap; send fewer or shorter items']
        return stored
      }
      return next
    })
    if (out.errors.length > 0) return { deny: refusalOf(out.errors) }
    // The stage list changed: each task step keeps its stage by name, else goes to the current stage.
    if (written !== null && before !== null && before.phases.join('|') !== written.phases.join('|')) {
      const names = before.phases
      const now = written
      await update($, tasks, list =>
        list.map(t => {
          const k = now.phases.indexOf(names[t.phase] ?? '')
          return { ...t, phase: k >= 0 ? k : Math.min(now.phase, now.phases.length - 1) }
        }),
      )
    }
    await agentUpdated($)
    await tick($)
    // With no surface attached there is nowhere to open the pane; the state is kept for the next surface.
    await openPane($, { id: PANE, title: TITLE })
    await paneSeen($).catch(() => undefined)
    // Each agent update reads GitHub at once: pull requests, CI and merges.
    void poll($, true)
    // A saved template: the stages this update left, under the person's name for them.
    let saved = ''
    if (typeof args.saveTemplate === 'string' && written !== null) {
      await $.store.set(TEMPLATES_KEY, { ...personal, [args.saveTemplate]: written.phases }).catch(() => undefined)
      saved = ` Saved the stages as template ${args.saveTemplate}.`
    }
    void noteEvent($)
    await settle($)
    // A parent the agent called done shows open while a child or a dependency is open: say which, so it can close it.
    const held = await heldReasons($)
    return { result: `The pane shows the new state (version ${written?.version ?? 0}).${saved}${held}` }
  })

  // A draw of the pane marks it open: git and GitHub are read only while it is.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await paneSeen($, true).catch(() => undefined)
    return renderPane($, e)
  })
}
