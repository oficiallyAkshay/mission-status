import { expect, test } from 'claude-code/testing'
import { age, cap, clockOf } from '../hooks/model'
import { trackSvg } from '../hooks/bars'

test('ages read as plain words', () => {
  expect(age(0, 30_000)).toBe('now')
  expect(age(0, 4 * 60_000)).toBe('4 min')
  expect(age(0, 75 * 60_000)).toBe('1 h 15 min')
})

test('sentence case keeps the rest as written', () => {
  expect(cap('ship to GitHub')).toBe('Ship to GitHub')
})

test('the same input draws the same source, so an unchanged bar does not flicker; different input, different ids', () => {
  const ids = (svg: string) => [...svg.matchAll(/id="([^"]+)"/g)].map(m => m[1])
  const one = trackSvg({ total: 5, done: 2, current: 'Test', isDone: false })
  expect(trackSvg({ total: 5, done: 2, current: 'Test', isDone: false })).toBe(one)
  const other = ids(trackSvg({ total: 5, done: 3, current: 'Deploy', isDone: false }))
  expect(ids(one).filter(x => other.includes(x))).toEqual([])
})

import { actionOf, secondsOf } from '../hooks/model'

test('the live line uses the chat status words', () => {
  expect(actionOf({ tool: 'Bash', command: 'x', description: 'Run the pane tests' })).toBe('Running a command')
  expect(actionOf({ tool: 'Edit', file_path: '/a/b/register.tsx' })).toBe('Editing a file')
  expect(actionOf({ tool: 'mcp__mission-status__update' })).toBeNull()
  expect(secondsOf(12_400)).toBe('12s')
  expect(secondsOf(65_000)).toBe('1m 5s')
})

test('the stage timer reads MM:SS, and H:MM:SS past an hour', () => {
  expect(clockOf(65_000)).toBe('01:05')
  expect(clockOf(3_725_000)).toBe('1:02:05')
})

import { applyPlan, normalize } from '../hooks/model'

test('task-list steps slot into the stage in progress when they first appear, and keep it', () => {
  const one = applyPlan([], { items: [{ content: 'Read the API', status: 'in_progress' }, { content: 'Build it', status: 'pending' }] }, 1)
  expect(one.map(x => [x.name, x.status, x.phase])).toEqual([['Read the API', 'now', 1], ['Build it', 'next', 1]])
  const two = applyPlan(one, { advance: true }, 2)
  expect(two.map(x => [x.status, x.phase])).toEqual([['done', 1], ['now', 2]])
})

test('a state stored by an earlier version keeps its data and gains the new fields', () => {
  const kept = normalize({ project: 'P', stage: 'build', phases: ['A', 'B'], phase: 1, counts: [], items: [{ phase: 1, name: 'X', status: 'now' }] } as never)
  expect(kept?.project).toBe('P')
  expect(kept?.active).toEqual([])
  expect(kept?.items[0]?.after).toBeNull()
})

import { asPr, prFacts } from '../hooks/readers'
import { badgeSvg } from '../hooks/bars'

test('a small badge stays small', () => {
  expect(badgeSvg('done', 0, 16)).toContain('width="16"')
})

test('a pull request reads as state, CI, review and the branch facts', () => {
  const pr = asPr({ number: 7, state: 'OPEN', url: 'u', title: 't', reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }] })
  expect(pr.ci).toBe('running')
  const facts = prFacts(pr, { branch: 'b', ahead: 2, behind: 3, files: 4, added: 10, removed: 2, dirty: 0 }).map(f => f.text)
  expect(facts).toEqual(['Open', 'CI running', 'Review needed', '3 behind main', '+10 −2'])
})
