import { expect, test } from 'claude-code/testing'
import { applyUpdate, checkUpdate, normalize } from '../hooks/model'

// The old stage field is replaced by template: each old value gives its template's stages, and names that template.

test('an old stage value gives the same stages as its template', () => {
  for (const [stage, template] of [['plan', 'feature'], ['ship', 'feature'], ['fix', 'bug-fix']]) {
    const byStage = applyUpdate(null, { project: 'P', phase: 0, stage }, 1)
    const byTemplate = applyUpdate(null, { project: 'P', phase: 0, template }, 1)
    expect(byStage.phases).toEqual(byTemplate.phases)
    expect(byStage.template).toBe(template)
    expect(normalize({ ...byStage, template: undefined } as any)?.template).toBe(template)
  }
  expect(checkUpdate({ project: 'P', phase: 0, stage: 'fix', items: [{ phase: 0, name: 'Reproduce', status: 'now' }] }, null)).toHaveLength(1)
})
