import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'mission-status',
  component: 'Pane',
  props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('a local Markdown link opens the document pane, which draws the file as Markdown', async ($, on) => {
  const opened: string[] = []
  on('tool.register', () => ({ value: {} }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.surfaces', () => ({ value: ['desktop'] }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('agent.list', () => ({ value: [] }))
  on('clock.every', () => ({ value: () => {} }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: '# The plan\n\nOne line.' }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'mcp__mission-status__update', project: 'P', stage: 'build', phase: 1, links: [{ phase: 0, label: 'Plan', href: '/tmp/plan.md' }], items: [{ phase: 0, name: 'a', status: 'done' }] } as never)
  const ui = await $.ui.mount({ ...PANE, requestId: 'progress', surface: 'desktop' })
  // Stage 0 is done and folded: open it first.
  await ui.press({ key: 'open-0' })
  // The document link is a plain button, as the tabs and artifact chips are; a press opens the document pane.
  const link = (await ui.findAll({ type: 'Button' })).find(x => String(x.props?.label ?? '') === '↗ Plan')
  expect(link).toBeTruthy()
  await ui.press({ key: String(link?.key ?? '') })
  expect(opened).toContain('mission-status-doc')
  await ui.unmount()
  const docUi = await $.ui.mount({ ...PANE, requestId: 'mission-status-doc', surface: 'desktop' })
  const md = await docUi.find({ type: 'Markdown' })
  expect(String(md?.props?.text ?? '')).toContain('# The plan')
  await docUi.unmount()
})
