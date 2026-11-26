import { openPane } from './surface'
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

// A document pane: a card's link to a local Markdown file opens the file here, drawn natively with the app's
// Markdown element. (A mod cannot open the app's own file panel; this is the nearest native view.)
export const DOC_PANE = 'mission-status-doc'
const doc = atom({ plugin: 'mission-status', key: 'doc' } as const, null as { title: string; path: string } | null)

// A card link names the file, and the agent writes the card: the pane opens only Markdown inside the session's
// folder, the app's plan folder (~/.claude) or the temp folder where sessions keep scratch files, never a path that
// climbs with "..".
export const expand = (path: string, home: string): string => (path.startsWith('~/') ? `${home}${path.slice(1)}` : path)

export function isOpenable(path: string, cwd: string, home: string): boolean {
  if (!/\.(md|markdown)$/i.test(path) || path.split('/').includes('..')) return false
  const full = expand(path, home)
  const roots = [cwd, `${home}/.claude`, '/tmp', '/private/tmp'].filter(r => r !== '').map(r => r.replace(/\/+$/, ''))
  return roots.some(r => full === r || full.startsWith(`${r}/`))
}

export async function openDoc($: EngineInterface, title: string, path: string): Promise<void> {
  await update($, doc, () => ({ title, path }))
  // focus asks the app to raise the pane, so the press shows the document at once.
  await openPane($, { id: DOC_PANE, title, focus: true })
}

export function registerDoc(on: On): void {
  on('ui.render', { component: 'Pane', requestId: DOC_PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const d = await read($, doc)
    if (d === null) return <Text dimColor>No document is open.</Text>
    const cwd = await Promise.resolve().then(() => $.session.cwd()).catch(() => '')
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    if (!isOpenable(d.path, cwd, home)) return <Text color="warning">{`The pane opens only Markdown files in this project or its plan folders.`}</Text>
    const text = await $.fs.read(expand(d.path, home)).catch(() => null)
    if (typeof text !== 'string') return <Text color="warning">{`The pane cannot read ${d.path}.`}</Text>
    return (
      <Box flexDirection="column">
        <Markdown text={text} />
      </Box>
    )
  })
}
