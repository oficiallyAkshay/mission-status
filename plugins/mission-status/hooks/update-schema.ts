import type { EngineInterface } from 'claude-code'
import { HYPOTHESIS_STATES, ITEM_STATES, PATCH_OPS, STAGE_KEYS, TEMPLATES } from './model'

// The update tool the agent calls: its description and input schema (register.tsx registers it).
export const UPDATE_SCHEMA: Parameters<EngineInterface['tool']['register']>[0] = {
  name: 'update',
  description:
    'Mission status pane: send the whole state; the pane redraws it in place. Call it at every meaningful change, in ' +
    'place of a count line in the chat. Write all text in ASD-STE100 Simplified Technical English: each sentence has a ' +
    'subject and a verb, in the active voice and the present tense, about 20 words at most. Labels are one to four words. ' +
    'Every count has a denominator m where one exists. The first call sends project, stage and phase; later calls send only what changed. ' +
    'The cap is 32 KB; an update that fails keeps the last good view and returns the errors.',
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
      watches: {
        type: 'array',
        description:
          "Watches: background work that waits for something (CI, a deploy, an alert feed, a trend). They show in the pane's Watching section, never on the stage cards. Send one by id to add or change it; {id, remove: true} drops it. A background shell or Monitor already shows by itself: send job (its task id) only to name or shape it. Its script can also print WATCH: <shape> <name>, HIT: <text>, VALUE: <number>, PROGRESS: <text> or DONE: <text> lines.",
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A stable id' },
            name: { type: 'string', description: 'What it watches, two to six words' },
            shape: { type: 'string', enum: ['until', 'stream', 'trend'], description: 'until: ends at its first hit. stream: reports every hit. trend: tracks a number.' },
            status: { type: 'string', enum: ['running', 'hit', 'ended'] },
            hits: { type: 'number' },
            last: { type: 'string', description: 'The last hit, a few words' },
            value: { type: 'number', description: 'The newest reading of a trend' },
            progress: { type: 'string', description: 'How far it is, for example: 4 of 6 checks' },
            job: { type: 'string', description: 'The background task id it names' },
            remove: { type: 'boolean' },
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
        // Kept for one release: template replaces it.
        description: 'Replaced by template, and kept for one release. plan, build, review or ship picks the feature template; fix picks bug-fix; cause: Reproduce, Test causes, Confirm cause, Fix, Learn.',
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
            status: { type: 'string', enum: ITEM_STATES },
            stepsParallel: { type: 'boolean' },
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
}
