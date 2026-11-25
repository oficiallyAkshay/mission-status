import { expect, test } from 'claude-code/testing'

// A holdback session (metrics.tsx sets the key) runs as if the pane were not installed.
test('a holdback session opens no pane and adds no standing rule', async ($, on) => {
  const opened: string[] = []
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('tool.call', () => ({ result: 'ok' }))
  // The stored holdback value reads true; every other stored value passes to the engine.
  on('state.get', async (_: unknown, e: { plugin: string; key: string }, next: (e: unknown) => unknown) =>
    e.plugin === 'mission-status' && e.key === 'holdback' ? { value: { value: true, version: 1 } } : next(e),
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 0 } as never)
  expect(opened.filter(id => id === 'progress')).toEqual([])
  const composed = (await $.prompt.compose({} as never)) as { sections: { id: string }[] }
  expect(composed.sections.some(s => s.id === 'mission-status:progress')).toBe(false)
  // No rule after a compaction, and no held turn end, however stale.
  const after = (await $.classic.SessionStart({ source: 'compact' } as never)) as { additionalContext?: string[] }
  expect((after.additionalContext ?? []).some(x => x.includes('Progress pane'))).toBe(false)
  for (let k = 0; k < 8; k++) await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(((await $.classic.Stop({ stop_hook_active: false } as never)) as { block?: string }).block).toBeUndefined()
})
