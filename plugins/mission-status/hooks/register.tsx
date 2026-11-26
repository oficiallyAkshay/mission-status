import { openPane } from './surface'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { CardLink, Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'
import { asLink, HYPOTHESIS_STATES, ITEM_STATES, PATCH_OPS, PHASES, RULE, STAGE_KEYS, TEMPLATES, UPDATE_TOOL, CAP_BYTES, actionOf, applyPatch, applyPlan, linkRefs, argsOf, asCount, asHypothesis, asItem, bytesOf, cap, checkUpdate, figureOf, idOf, normalize, num, parentLoops, refusalOf, stepsStarted, str, prRefsIn, prRefsInLines, branchesIn, unionRefs, byteLength, skillSteps, mergeRunbooks, TEMPLATES_KEY, asTemplates, templatesLine } from './model'
import { paneSeen, poll } from './readers'
import { CLOCK_MS, PANE, TICK_MS, TITLE, afterToolCall, agentUpdated, agentVersionOf, atTurnEnd, noteSteps, noteTurnEnd, noteTurnStart, say, settle, heldReasons, noteEvent, tick, tickIfTimer } from './store'
import { renderPane } from './view'
import { registerMetrics } from './metrics'
import { registerOnboarding } from './onboarding'
import { registerUpdate } from './update'
import { registerDoc } from './doc'
import { registerMarker } from './marker'
import { registerQuiet } from './quiet'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
// The live facts the state machine reads (store.ts declares the same keys).
const turnOpen = atom({ plugin: 'mission-status', key: 'turnOpen' } as const, false as boolean)
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
// The agent's own version kept in the stored summary (normalize leaves it out, so it is read from the raw value).
const seenVersion = (stored: Summary): number => (stored as { agentVersion?: number } | null)?.agentVersion ?? 0
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
      await savePane($).catch(() => undefined)
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
// resume) takes it back from there. The store keeps the last SAVED_MAX sessions.
const SAVED_INDEX = 'savedPanes'
const SAVED_MAX = 20
async function savedKey($: EngineInterface): Promise<string | null> {
  const path = (await $.session.info().catch(() => null))?.transcriptPath ?? ''
  const name = path.split('/').pop()?.replace(/\.jsonl$/, '') ?? ''
  return /^[\w-]{8,80}$/.test(name) ? `pane-${name}` : null
}
export async function savePane($: EngineInterface): Promise<void> {
  const key = await savedKey($)
  if (key === null) return
  const value = { summary: await read($, summary), tasks: await read($, tasks), prRefs: await read($, prRefs), prBranches: await read($, prBranches), at: Date.now() }
  if (value.summary === null) return
  await $.store.set(key, value)
  const index = ((await $.store.get(SAVED_INDEX).catch(() => undefined)) as string[] | undefined) ?? []
  if (index[index.length - 1] === key) return
  const next = [...index.filter(k => k !== key), key]
  for (const old of next.slice(0, Math.max(0, next.length - SAVED_MAX))) await $.store.delete(old).catch(() => undefined)
  await $.store.set(SAVED_INDEX, next.slice(-SAVED_MAX))
}
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

export const register: Register = on => {
  // Each wave-1 part keeps its hooks in its own file.
  registerOnboarding(on)
  registerMetrics(on)
  registerUpdate(on)
  registerDoc(on)
  registerMarker(on)
  registerQuiet(on)

  on('session.start', async ($, e, next) => {
    // A new or resumed session starts with no turn running and no question open.
    await update($, turnOpen, () => false).catch(() => undefined)
    await update($, waiting, () => false).catch(() => undefined)
    await $.tool.register({
      name: 'update',
      description:
        'Mission status pane: send the whole state; the pane redraws it in place. Call it at every meaningful change, in ' +
        'place of a count line in the chat. Write all text in ASD-STE100 Simplified Technical English: each sentence has a ' +
        'subject and a verb, in the active voice and the present tense, about 20 words at most. Labels are one to four words. ' +
        'Every count has a denominator m where one exists. The pane itself reads the task list, git, pull requests and helpers. ' +
        'At every update, look again at the stages: keep a template only while it fits, and change the stages when the work changes. ' +
        'The first call sends project, stage and phase; later calls send only what changed. Give each item a stable id; ' +
        'send a small change to items as patch, not the whole list. The cap is 32 KB; an update that fails keeps the last good view and returns the errors.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'The project name, for example: Checkout redesign' },
          links: {
            type: 'array',
            description:
              'Links on cards to documents and made artifacts: a plan, a spec, a review, a page, a file. phase puts the link on that stage card; item puts it on that item. href is a URL or a file path; label is one to three words.',
            items: {
              type: 'object',
              properties: { phase: { type: 'number' }, item: { type: 'string' }, label: { type: 'string' }, href: { type: 'string' } },
              required: ['href'],
            },
          },
          ticket: {
            type: ['object', 'null'],
            description: 'The ticket this work answers, when there is one: its reference, its title and its link.',
            properties: { ref: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } },
            required: ['ref'],
          },
          template: {
            type: 'string',
            description: `A quick choice of stages: ${Object.entries(TEMPLATES).map(([k, v]) => `${k} (${v.join(', ')})`).join('; ')}, or one of the person's own templates. Pick one only when it fits; otherwise send phases.`,
          },
          repo: {
            type: ['string', 'null'],
            description: "The repository folder the work is in, as an absolute path, when it is not the session's own folder. The Merge card reads git and pull requests there. null goes back to the session folder.",
          },
          runbooks: {
            type: 'array',
            description:
              "Runbooks the session follows (a numbered procedure, a checklist, a release or setup guide). Each one shows on its own tab beside Progress. Send a whole runbook to add or replace it by id; send {id, remove: true} to drop it. At most 4.",
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A stable id, for example open-source-release' },
                title: { type: 'string', description: 'The tab name, one to three words' },
                href: { type: 'string', description: 'The runbook itself: a link or a file path' },
                remove: { type: 'boolean' },
                steps: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: 'The step, three to eight words' },
                      status: { type: 'string', enum: ['done', 'now', 'next', 'failed', 'blocked'] },
                      note: { type: 'string', description: 'What was done or what is left, a few words' },
                      waitsOn: { type: 'string', description: 'Who or what the step waits on, for example: your yes' },
                    },
                    required: ['name'],
                  },
                },
              },
              required: ['id'],
            },
          },
          saveTemplate: {
            type: 'string',
            description: "Saves this update's stages as the person's own template under this name (lower-case letters, digits and dashes), for any later session. Send it when the person asks to keep a set of stages.",
          },
          active: {
            type: 'array',
            items: { type: 'number' },
            description: 'Indexes of stages that are in progress at the same time as phase, when stages run in parallel.',
          },
          phases: {
            type: 'array',
            items: { type: 'string' },
            description: 'Your own stage names, 2 to 8, in order, when the stage kind does not fit: for example Plan, Build, Review, Deploy, Monitor, Iterate.',
          },
          goalLine: {
            type: ['string', 'null'],
            description:
              'One or two full sentences on the goal, for example: The pane shows the live counts beside the chat. The chat shows only the items that need you.',
          },
          stage: {
            type: 'string',
            enum: STAGE_KEYS,
            description: 'plan or build or review or ship: stages Plan, Build, Test, Deploy, Learn. fix: Reproduce, Find cause, Fix, Test, Deploy. cause: Reproduce, Test causes, Confirm cause, Fix, Learn.',
          },
          phase: { type: 'number', description: 'Index of the current stage, from 0. The count of stages means all are done.' },
          symptom: { type: ['string', 'null'], description: 'For fix and cause: one sentence on what goes wrong.' },
          hypotheses: {
            type: 'array',
            description: 'For cause: each suspected cause and its state.',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, state: { type: 'string', enum: HYPOTHESIS_STATES } },
              required: ['text', 'state'],
            },
          },
          waitingOn: { type: ['string', 'null'], description: 'A wait on something other than the owner, for example: the CI gate check' },
          items: {
            type: 'array',
            description:
              'The steps inside each card (stage). parent names the step that holds this one, by its id or name: this one is then a sub-step. after names the sibling this one waits for, by its id or name. Siblings run one after another in the order sent unless an item sets parallel. Items show in the order sent.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A stable id, kept for the life of the item; absent, the name in lower case with dashes for spaces' },
                phase: { type: 'number' },
                name: { type: 'string', description: 'One to four words' },
                status: { type: 'string', enum: ITEM_STATES, description: 'needs = the item waits on the person (an approval, a sign-off, an answer).' },
                after: { type: 'string' },
                parent: { type: 'string' },
                note: { type: 'string', description: 'The rough scope, cut or area, in a few words, shown under the name' },
                steps: {
                  type: ['array', 'null'],
                  items: {
                    anyOf: [
                      { type: 'string' },
                      {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          steps: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
                          status: { type: 'string', enum: ITEM_STATES },
                          note: { type: 'string' },
                        },
                        required: ['name'],
                      },
                    ],
                  },
                  description: "The sub-sub-steps: one to three words each, at most 8, on one line under the name, in place of nested rows. Use it for the phases inside one sub-step, for example the passes of a review. null clears it. An entry that has its own steps is sent as { name, steps } and becomes its own nested row, one level down.",
                },
                stepsParallel: { type: 'boolean', description: 'True when the sub-sub-steps run at the same time, not one after another: each pulses while its sub-step runs.' },
                step: { type: ['number', 'null'], description: 'Index of the sub-sub-step that runs now, from 0. The pane shows it bold and the others faint.' },
                taskStep: { type: 'string', description: "The task-list step this item stands for, by its text. The item is done when that step is marked done." },
                parallel: { type: 'boolean', description: 'Siblings run one after another in the order sent: an item runs only once the one before it is done. true lets this item run beside the one before it.' },
                pr: { type: ['string', 'number'], description: "The item's pull request: a number in the work's repository, or owner/name#number. The pane shows its CI state and run time under the item." },
              },
              required: ['phase', 'name', 'status'],
            },
          },
          patch: {
            type: 'array',
            description:
              'Item changes in place of the whole items list: {op:"add", id, phase, name, status, ...}, {op:"remove", id}, or {op:"change", id, and only the fields that change}.',
            items: {
              type: 'object',
              properties: {
                op: { type: 'string', enum: PATCH_OPS },
                id: { type: 'string' },
                status: { type: 'string', enum: ITEM_STATES, description: 'needs = the item waits on the person (an approval, a sign-off, an answer).' },
                stepsParallel: { type: 'boolean', description: 'True when the sub-sub-steps run at the same time, not one after another: each pulses while its sub-step runs.' },
              },
              required: ['op'],
            },
          },
          version: {
            type: 'number',
            description: 'Optional: your own write counter, 1, 2, 3 and so on. The pane refuses a version that is not newer than the last one.',
          },
          counts: {
            type: 'array',
            description:
              'The gate of each stage: what must be true to leave it, and how far it is. when is an ultra short label of two or three words, for example: Plan approved; Build done; PR merged. Give n and m for x of y (only when a fixed total exists), n alone for a plain count, text for a status word (Waiting, Met), or none of them.',
            items: {
              type: 'object',
              properties: {
                phase: { type: 'number', description: 'Index of the stage this exit clause belongs to' },
                when: { type: 'string', description: 'The gate to leave this stage, as an ultra short label of two or three words: Plan approved, Build done, Tests pass, PR merged, Look approved' },
                label: { type: 'string', description: 'A short name for the figure, for example: Tests' },
                n: { type: 'number' },
                text: { type: 'string', description: 'A word in place of a number, for example: Waiting, Yes, No' },
                m: { type: 'number' },
                href: { type: 'string' },
                hrefLabel: { type: 'string' },
              },
              required: ['when'],
            },
          },
        },
      },
      isDeferred: false,
    })
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
    const words = (() => {
      try {
        return actionOf(e as unknown as Record<string, unknown>)
      } catch {
        return null
      }
    })()
    // The action line is a nicety: a failed write never holds up the call.
    if (words !== null) await say($, words).catch(() => undefined)
    const result = await next(e)
    // A pull request the session made joins the PRs tab; a branch its input names lets the PR list find one.
    try {
      const args = e as unknown as { command?: unknown }
      const command = String(e.tool) === 'Bash' && typeof args.command === 'string' ? args.command : ''
      await addBranches($, branchesIn(command))
      const made = prRefsIn(command, JSON.stringify(result ?? ''))
      if (made.length > 0) {
        await update($, prRefs, list => unionRefs(list, made))
        await savePane($).catch(() => undefined)
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
              return { ...old, agentVersion: seenVersion(stored), runbooks: [...(old.runbooks ?? []), book].slice(-4), version: (old.version ?? 0) + 1 } as Summary
            })
          }
        }
      }
    } catch {}
    // Between tool calls the model thinks, as the chat shows.
    if (words !== null) await say($, 'Thinking').catch(() => undefined)
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
      await savePane($).catch(() => undefined)
      void noteEvent($)
      void settle($)
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
      await savePane($).catch(() => undefined)
      void noteEvent($)
      void settle($)
    } catch {
      // The task list is a nicety: a failed read never holds up the call.
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // After each context compaction the standing rule goes back into the agent's context.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'compact') return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), RULE] }
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A turn ends while the state is stale: hold the end once and ask the agent for an update.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block !== undefined) return result
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
    await say($, 'Waiting for you').catch(() => undefined)
    await noteTurnEnd($).catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await say($, 'Thinking').catch(() => undefined)
    await noteTurnStart($).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A standing rule for the model: keep the pane current and look again at its stages.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
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
    const agentVersion = await agentVersionOf($)
    const before = normalize(await read($, summary))
    const personal = asTemplates(await $.store.get(TEMPLATES_KEY).catch(() => undefined))
    const first = checkUpdate(args, before, agentVersion, personal)
    if (first.length > 0) return { deny: refusalOf(first) }
    const out = { errors: [] as string[] }
    const written = await update($, summary, stored => {
      const old = normalize(stored)
      // Checked again inside the write: another writer may have changed the state since the check above.
      // The agent's version is kept in the stored summary, so the check sees a write that landed since the read above.
      const seen = seenVersion(stored)
      out.errors = checkUpdate(args, old, seen, personal)
      if (out.errors.length > 0) return stored
      const next = build(old, seen)
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
    await savePane($).catch(() => undefined)
    await agentUpdated($, num(args.version))
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
    void settle($)
    // A parent the agent called done shows open while a child or a dependency is open: say which, so it can close it.
    const held = await heldReasons($)
    return { result: `The pane shows the new state (version ${written?.version ?? 0}).${saved}${held}` }

    function build(old: Summary, seen: number): NonNullable<Summary> {
      const stage = STAGE_KEYS.find(k => k === args.stage) ?? old?.stage ?? 'build'
      const custom = (Array.isArray(args.phases) ? args.phases : []).map(str).filter((x): x is string => x !== null).map(cap)
      const picked = typeof args.template === 'string' ? (TEMPLATES[args.template] ?? personal[args.template]) : undefined
      const phases =
        custom.length >= 2 && custom.length <= 8
          ? custom
          : picked !== undefined
            ? picked
            : args.phases === undefined && old !== null && (args.stage === undefined || args.stage === old.stage)
              ? old.phases
              : PHASES[stage]
      const template = custom.length >= 2 ? null : typeof args.template === 'string' && picked !== undefined ? args.template : args.stage !== undefined && args.stage !== old?.stage ? null : (old?.template ?? null)
      const active = (Array.isArray(args.active) ? args.active : old?.active ?? [])
        .map(num)
        .filter((k): k is number => k !== undefined && k >= 0 && k < phases.length)
        .map(k => Math.round(k))
      const phase = Math.max(0, Math.min(phases.length, Math.round(num(args.phase) ?? old?.phase ?? 0)))
      const counts =
        args.counts === undefined
          ? (old?.counts ?? [])
          : (Array.isArray(args.counts) ? args.counts : []).map(asCount).filter((c): c is Count => c !== undefined)
      const movedPair = counts
        .map(c => ({ c, was: old?.counts.find(x => x.label === c.label) }))
        .find(({ c, was }) => was !== undefined && figureOf(was) !== figureOf(c))
      // Agent items only: the task list's steps are the pane's own items, kept in tasks, so no agent write deletes them.
      const patched = new Set((Array.isArray(args.patch) ? (args.patch as unknown[]) : []).map(p => str((p as { id?: unknown } | null)?.id) ?? idOf(str((p as { name?: unknown } | null)?.name) ?? '')))
      const items = linkRefs(
        Array.isArray(args.patch)
          ? applyPatch(old?.items ?? [], args.patch)
          : args.items === undefined
            ? (old?.items ?? [])
            : (Array.isArray(args.items) ? args.items : []).map(asItem).filter((x): x is Item => x !== undefined)
      )
        // An item in progress keeps the time it went in progress, for its runtime timer; a full list and a patch alike.
        .map(x => {
          const was = old?.items.find(y => (y.id ?? idOf(y.name)) === (x.id ?? idOf(x.name)))
          // A done item keeps the time it was first seen done; an item sent already done gets the time of this update.
          const doneAt = x.status === 'done' ? (was?.status === 'done' ? (was.doneAt ?? at) : at) : null
          // When the agent last named the item: a whole list names every item it holds, a patch only the items it adds or
          // changes. A merged pull request closes an item only when the agent has not named it since the merge.
          const named = Array.isArray(args.items) || patched.has(x.id ?? idOf(x.name))
          const touchedAt = named ? at : (was?.touchedAt ?? null)
          return { ...x, since: x.status === 'now' ? (was?.status === 'now' ? (was.since ?? at) : at) : null, doneAt, touchedAt }
        })
      // An update that leaves waitingOn out keeps the wait; null clears it.
      const waitingRaw = args.waitingOn === undefined ? (old?.waitingOn ?? null) : str(args.waitingOn)
      // Stage times: a stage starts when the phase first reaches it and ends when the phase passes it. Stages passed
      // before the pane first saw the work have no times.
      const starts = phases.map((_, k) => old?.starts?.[k] ?? null)
      const ends = phases.map((_, k) => old?.ends?.[k] ?? null)
      if (old === null || old.phases.join('|') !== phases.join('|')) {
        starts.fill(null)
        ends.fill(null)
      }
      for (let k = 0; k < phases.length; k++) {
        if ((k === phase || active.includes(k)) && starts[k] === null) starts[k] = at
        if (k < phase && ends[k] === null && starts[k] !== null) ends[k] = at
        if (k >= phase || active.includes(k)) ends[k] = null
        if (k > phase && !active.includes(k)) starts[k] = null
      }
      const ticketRaw = args.ticket as Record<string, unknown> | null | undefined
      const ticket: Ticket | null =
        ticketRaw === undefined
          ? (old?.ticket ?? null)
          : ticketRaw === null || str(ticketRaw.ref) === null
            ? null
            : { ref: str(ticketRaw.ref) ?? '', title: str(ticketRaw.title), url: str(ticketRaw.url) }
      return {
        active,
        template,
        ticket,
        links:
          args.links === undefined
            ? (old?.links ?? [])
            : (Array.isArray(args.links) ? args.links : []).map(asLink).filter((x): x is CardLink => x !== undefined),
        starts,
        ends,
        project: str(args.project) ?? old?.project ?? 'Project',
        repo: args.repo === undefined ? (old?.repo ?? null) : str(args.repo),
        runbooks: Array.isArray(args.runbooks) ? mergeRunbooks(old?.runbooks ?? [], args.runbooks) : (old?.runbooks ?? []),
        goalLine: args.goalLine === undefined ? (old?.goalLine ?? null) : str(args.goalLine),
        stage,
        phases,
        phase,
        symptom: args.symptom === undefined ? (old?.symptom ?? null) : str(args.symptom),
        hypotheses:
          args.hypotheses === undefined
            ? (old?.hypotheses ?? [])
            : (Array.isArray(args.hypotheses) ? args.hypotheses : []).map(asHypothesis).filter((x): x is Hypothesis => x !== undefined),
        waitingOn: waitingRaw,
        waitingSince: waitingRaw !== null && waitingRaw === old?.waitingOn ? old.waitingSince : at,
        counts,
        items,
        change: movedPair !== undefined && movedPair.was !== undefined ? { label: movedPair.c.label, from: figureOf(movedPair.was), at } : (old?.change ?? null),
        at,
        version: (old?.version ?? 0) + 1,
        waitingForAgent: false,
        mayBeOutOfDate: false,
        agentVersion: Math.max(seen, num(args.version) ?? 0),
      } as NonNullable<Summary>
    }
  })

  // A draw of the pane marks it open: git and GitHub are read only while it is.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await paneSeen($, true).catch(() => undefined)
    return renderPane($, e)
  })
}
