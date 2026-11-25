import { expect, test } from 'claude-code/testing'
import { trackFits } from '../hooks/bars'

// The stage bar shows while every stage name fits the pane; a narrower pane draws wrapped stage chips instead.
const names = ['Plan', 'Repo setup', 'Build', 'Website', 'Review', 'Fix findings', 'Deploy']
const base = { total: 7, done: 5, current: 'Fix findings', isDone: false, names, checks: [true, true, true, false, true, false, false] }

test('a wide pane fits the bar', () => {
  expect(trackFits({ ...base, widthPx: 2000 })).toBe(true)
  expect(trackFits({ ...base })).toBe(true)
})

test('a narrow pane does not fit the bar', () => {
  expect(trackFits({ ...base, widthPx: 320 })).toBe(false)
})
