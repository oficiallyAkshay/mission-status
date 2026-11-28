import { expect, mock, test } from 'claude-code/testing'
import { watchRows } from '../hooks/watches'
import { type Job } from '../types'

// A watch job's output, read by the 5 s poll: a job that ends before the next poll keeps the result it printed, and
// a line longer than one read never stalls the reading.

const OUT = '/tmp/bjob0001.output'
// A session with one background job; its output file is what the test writes. ASCII only, so a byte is a character.
const boot = async ($: any, on: any) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const file = { text: '' }
  const jobs = { value: [] as Job[] }
  on('state.set', (_: unknown, e: { plugin: string; key: string; value: unknown }, next: any) => {
    const v = e.value as any
    if (e.plugin === 'mission-status' && e.key === 'jobs') jobs.value = v !== null && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v
    return next(e)
  })
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'mission-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('agent.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  on('tool.call', { tool: 'Bash' }, () => ({ result: `Command running in background with ID: bjob0001. Output is being written to: ${OUT}` }))
  on('tool.call', { tool: 'TaskStop' }, () => ({ result: 'stopped' }))
  on('fs.read', (_: unknown, e: { path: string; offset?: number; length?: number }) => {
    const at = e.offset ?? 0
    return { value: e.path === OUT ? file.text.slice(at, at + (e.length ?? file.text.length)) : '' }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'make build', description: 'Build', run_in_background: true } as never)
  // The first poll finds the file empty.
  await clock.advance(5_000)
  await clock.settle()
  const row = () => watchRows({ jobs: jobs.value, helpers: [], agent: [], items: [], wakeups: [], at: 2_000_000 }).find(r => r.id === 'job-bjob0001')
  return { clock, file, jobs, row }
}

const ENDS: [string, ($: any) => Promise<unknown>][] = [
  ['its completed notification', $ => $.prompt.submit({ text: '<task-notification><task-id>bjob0001</task-id><status>completed</status></task-notification>' } as never).catch(() => undefined)],
  ['the turn-end job list', $ => $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never).catch(() => undefined)],
  ['a stop', $ => $.tool.call({ tool: 'TaskStop', task_id: 'bjob0001' } as never)],
]
for (const [path, end] of ENDS)
  test(`a job ended by ${path} before any poll read its output still shows the result it printed`, async ($, on) => {
    const w = await boot($, on)
    // The script prints its result and exits before the next poll; its last line has no newline.
    w.file.text = 'PROGRESS: compiling\nDONE: built'
    await end($)
    const endedAt = w.jobs.value.find(j => j.id === 'bjob0001')?.endedAt
    expect(endedAt).toBeTruthy()
    await w.clock.advance(5_000)
    await w.clock.settle()
    await w.clock.advance(5_000)
    await w.clock.settle()
    expect(w.row()?.last).toBe('built')
    expect(w.row()?.outcome).toBe('hit')
    expect(w.row()?.endedAt).toBe(endedAt)
  })

test('a watch line after a line longer than one 256 KiB read reaches the pane', async ($, on) => {
  const w = await boot($, on)
  w.file.text = `${'x'.repeat(256 * 1024 + 10)}\nHIT: next\n`
  for (let k = 0; k < 3; k++) {
    await w.clock.advance(5_000)
    await w.clock.settle()
  }
  expect(w.row()?.hits).toBe(1)
  expect(w.row()?.last).toBe('next')
})
