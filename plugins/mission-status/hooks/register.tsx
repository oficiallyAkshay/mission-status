import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { CardLink, Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'
import { asLink, HYPOTHESIS_STATES, ITEM_STATES, PATCH_OPS, PHASES, RULE, STAGE_KEYS, TEMPLATES, UPDATE_TOOL, CAP_BYTES, actionOf, applyPatch, applyPlan, argsOf, asCount, asHypothesis, asItem, bytesOf, cap, checkUpdate, figureOf, idOf, normalize, num, parentLoops, refusalOf, stepsStarted, str, TEMPLATES_KEY, asTemplates, templatesLine } from './model'
import { poll } from './readers'
import { CLOCK_MS, PANE, TICK_MS, TITLE, afterToolCall, agentUpdated, agentVersionOf, atTurnEnd, noteSteps, noteTurnEnd, noteTurnStart, say, tick } from './store'
import { renderPane } from './view'
import { registerMetrics } from './metrics'
import { registerOnboarding } from './onboarding'
import { registerUpdate } from './update'
import { registerDoc } from './doc'

// The holdback (metrics.tsx decides it): a measurement session with no pane and no standing rule.
const holdback = atom({ plugin: 'mission-status', key: 'holdback' } as const, false as boolean)

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const summary = atom({ plugin: 'mission-status', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'mission-status', key: 'tasks' } as const, [] as Task[])
// The narrow bar's window: a new current stage brings it back to follow the current stage.
const barStart = atom({ plugin: 'mission-status', key: 'barStart' } as const, null as number | null)

export const register: Register = on => {
  // Each wave-1 part keeps its hooks in its own file.
  registerOnboarding(on)
  registerMetrics(on)
  registerUpdate(on)
  registerDoc(on)

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'update',
      description:
        'Progress pane: send the whole state; the pane redraws it in place. Call it at every meaningful change, in ' +
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
              'The work inside each stage, drawn as nested cards. parent names the item that holds this one (cards nest to any depth). after names the sibling this one waits for. Siblings with no after run in parallel. when is the item\'s own exit clause, with n and m, n, or text as for counts.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'A stable id, kept for the life of the item; absent, the name in lower case with dashes for spaces' },
                phase: { type: 'number' },
                name: { type: 'string', description: 'One to four words' },
                status: { type: 'string', enum: ITEM_STATES },
                after: { type: 'string' },
                parent: { type: 'string' },
                note: { type: 'string', description: 'The rough scope, cut or area, in a few words, shown under the name' },
                when: { type: 'string', description: 'The gate to leave this stage, as an ultra short label of two or three words: Plan approved, Build done, Tests pass, PR merged, Look approved' },
                n: { type: 'number' },
                m: { type: 'number' },
                text: { type: 'string' },
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
              properties: { op: { type: 'string', enum: PATCH_OPS }, id: { type: 'string' } },
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
    await $.command.register({ name: 'mission-status', description: 'Open the progress pane' })
    $.clock.every(CLOCK_MS, () => void tick($))
    $.clock.every(TICK_MS, () => void poll($))
    void poll($)
    if ((await read($, summary)) !== null && !(await read($, holdback))) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
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
    // Between tool calls the model thinks, as the chat shows.
    if (words !== null) await say($, 'Thinking').catch(() => undefined)
    // Freshness triggers count the main loop's tool calls, not the pane's own update or a helper's calls.
    if (String(e.tool) === UPDATE_TOOL || e.agentId !== undefined || result.deny !== undefined) return result
    const line = await afterToolCall($).catch(() => null)
    return line === null ? result : { ...result, context: [...(result.context ?? []), line] }
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
    } catch {
      // The task list is a nicety: a failed read never holds up the call.
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // After each context compaction the standing rule goes back into the agent's context.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'compact' || (await read($, holdback))) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), RULE] }
  }).catch(($, e, next) => next(e))

  // A turn ends while the state is stale: hold the end once and ask the agent for an update.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block !== undefined || (await read($, holdback))) return result
    const hold = await atTurnEnd($, e.stop_hook_active)
    return hold === null ? result : { ...result, block: hold }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
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
    // A holdback session runs as if the pane were not installed: no standing rule.
    if (await read($, holdback)) return result
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
    await $.ui.open({ id: PANE, title: TITLE })
    void poll($)
    return { text: 'The progress pane is open.' }
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
      out.errors = checkUpdate(args, old, agentVersion, personal)
      if (out.errors.length > 0) return stored
      const next = build(old)
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
    if (written !== null && before?.phase !== written.phase) await update($, barStart, () => null)
    await agentUpdated($, num(args.version))
    await tick($)
    // With no surface attached there is nowhere to open the pane; the state is kept for the next surface.
    if (!(await read($, holdback))) await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    void poll($)
    // A saved template: the stages this update left, under the person's name for them.
    let saved = ''
    if (typeof args.saveTemplate === 'string' && written !== null) {
      await $.store.set(TEMPLATES_KEY, { ...personal, [args.saveTemplate]: written.phases }).catch(() => undefined)
      saved = ` Saved the stages as template ${args.saveTemplate}.`
    }
    return { result: `The pane shows the new state (version ${written?.version ?? 0}).${saved}` }

    function build(old: Summary): NonNullable<Summary> {
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
      const items = (
        Array.isArray(args.patch)
          ? applyPatch(old?.items ?? [], args.patch)
          : args.items === undefined
            ? (old?.items ?? [])
            : (Array.isArray(args.items) ? args.items : []).map(asItem).filter((x): x is Item => x !== undefined)
      )
        // An item in progress keeps the time it went in progress, for its runtime timer; a full list and a patch alike.
        .map(x => {
          const was = old?.items.find(y => (y.id ?? idOf(y.name)) === (x.id ?? idOf(x.name)))
          return { ...x, since: x.status === 'now' ? (was?.status === 'now' ? (was.since ?? at) : at) : null }
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
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, e))
}
