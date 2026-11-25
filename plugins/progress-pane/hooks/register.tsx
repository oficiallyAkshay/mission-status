import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { CardLink, Activity, Count, Git, Helper, Hypothesis, HypothesisState, Item, ItemStatus, Live, Pr, StageKey, StepStatus, Summary, Task, Ticket } from '../types'
import { asLink, HYPOTHESIS_STATES, ITEM_STATES, PHASES, STAGE_KEYS, TEMPLATES, actionOf, applyPlan, arrivalOf, asCount, asHypothesis, asItem, cap, figureOf, normalize, num, str } from './model'
import { poll } from './readers'
import { CLOCK_MS, PANE, PR_EVERY, TICK_MS, TITLE, say, tick } from './store'
import { renderPane } from './view'
import { registerMetrics } from './metrics'
import { registerOnboarding } from './onboarding'
import { registerUpdate } from './update'

// The stored values this file reads and writes, declared here by plugin and key (the same storage as store.ts).
const summary = atom({ plugin: 'progress-pane', key: 'summary' } as const, null as Summary, { shape: 'summary' })
const tasks = atom({ plugin: 'progress-pane', key: 'tasks' } as const, [] as Task[])

let ticks = 0

export const register: Register = on => {
  // Each wave-1 part keeps its hooks in its own file.
  registerOnboarding(on)
  registerMetrics(on)
  registerUpdate(on)

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'update',
      description:
        'Progress pane: send the whole state; the pane redraws it in place. Call it at every meaningful change, in ' +
        'place of a count line in the chat. Write all text in ASD-STE100 Simplified Technical English: each sentence has a ' +
        'subject and a verb, in the active voice and the present tense, about 20 words at most. Labels are one to four words. ' +
        'Every count has a denominator m where one exists. The pane itself reads the task list, git, pull requests and helpers. ' +
        'At every update, look again at the stages: keep a template only while it fits, and change the stages when the work changes.',
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
            enum: Object.keys(TEMPLATES),
            description: `A quick choice of stages: ${Object.entries(TEMPLATES).map(([k, v]) => `${k} (${v.join(', ')})`).join('; ')}. Pick one only when it fits; otherwise send phases.`,
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
                phase: { type: 'number' },
                name: { type: 'string', description: 'One to four words' },
                status: { type: 'string', enum: ITEM_STATES },
                after: { type: 'string' },
                parent: { type: 'string' },
                note: { type: 'string', description: 'The rough scope, cut or area, in a few words, shown under the name' },
                when: { type: 'string', description: 'The end of the sentence: Done when ...' },
                n: { type: 'number' },
                m: { type: 'number' },
                text: { type: 'string' },
              },
              required: ['phase', 'name', 'status'],
            },
          },
          counts: {
            type: 'array',
            description:
              'The exit clause of each stage: when the stage is done, and how far it is. when is the end of the sentence "Done when ...", for example: all pane tests pass; you approve the look; the pull request merges. Give n and m for x of y (only when a fixed total exists), n alone for a plain count, text for a status word (Waiting, Met), or none of them.',
            items: {
              type: 'object',
              properties: {
                phase: { type: 'number', description: 'Index of the stage this exit clause belongs to' },
                when: { type: 'string', description: 'The end of the sentence: Done when ...' },
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
        required: ['project', 'stage', 'phase'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'progress-pane', description: 'Open the progress pane' })
    $.clock.every(CLOCK_MS, () => void tick($))
    $.clock.every(TICK_MS, () => {
      ticks += 1
      void poll($, ticks % PR_EVERY === 0)
    })
    void poll($)
    if ((await read($, summary)) !== null) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
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
    return result
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // Slotting: the pane reads the session's task list itself. A step goes into the stage that is in progress when the
  // step first appears; it stays there.
  on('tool.call', { tool: 'mcp__ccd_turn__update_plan' }, async ($, e, next) => {
    try {
      const args = e as unknown as Record<string, unknown>
      const sum = await read($, summary)
      const at = sum === null ? 0 : Math.min(sum.phase, Math.max(0, sum.phases.length - 1))
      await update($, tasks, list => applyPlan(list, args, at))
    } catch {
      // The task list is a nicety: a failed read never holds up the call.
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('turn.complete', async ($, e, next) => {
    await say($, 'Waiting for you').catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await say($, arrivalOf(String((e as unknown as { text?: unknown }).text ?? ''))).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  // A standing rule for the model: keep the pane current and look again at its stages.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    return {
      sections: [
        ...result.sections,
        {
          id: 'progress-pane:progress',
          scope: 'session' as const,
          text:
            '# Progress pane\nKeep the progress pane current with mcp__progress-pane__update at every meaningful change. ' +
            'At each update, look again at the stages: keep a template only while it fits the work, and send new stages when the work changes. ' +
            'Stages may run in parallel (active). The pane reads the task list, git, pull requests and helpers itself: do not send those.',
        },
      ],
    }
  })

  on('command.run', { command: 'progress-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    void poll($)
    return { text: 'The progress pane is open.' }
  })

  on('tool.call', { tool: 'mcp__progress-pane__update' }, async ($, e) => {
    const args = e as unknown as Record<string, unknown>
    const at = Date.now()
    await update($, summary, stored => {
      const old = normalize(stored)
      const stage = STAGE_KEYS.find(k => k === args.stage) ?? old?.stage ?? 'build'
      const custom = (Array.isArray(args.phases) ? args.phases : []).map(str).filter((x): x is string => x !== null).map(cap)
      const picked = typeof args.template === 'string' ? TEMPLATES[args.template] : undefined
      const phases =
        custom.length >= 2 && custom.length <= 8
          ? custom
          : picked !== undefined
            ? picked
            : args.phases === undefined && old !== null
              ? old.phases
              : PHASES[stage]
      const template = custom.length >= 2 ? null : typeof args.template === 'string' && picked !== undefined ? args.template : (old?.template ?? null)
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
      const items =
        args.items === undefined
          ? (old?.items ?? [])
          : (Array.isArray(args.items) ? args.items : []).map(asItem).filter((x): x is Item => x !== undefined)
      const waitingRaw = str(args.waitingOn)
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
      }
    })
    await tick($)
    // With no surface attached there is nowhere to open the pane; the state is kept for the next surface.
    await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
    void poll($)
    return { result: 'The pane shows the new state.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => renderPane($, e))
}
