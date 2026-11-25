// Builds site/vendor/bars.js from the plugin's own drawing code, so the demo draws the pane with the same functions.
// Run: node site/build.mjs (from the repository root). The output is committed; re-run it after bars.ts changes.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
execFileSync('npx', ['-y', 'esbuild@0.24.2', 'plugins/mission-status/hooks/bars.ts', '--format=esm', '--target=es2020',
  '--outfile=site/vendor/bars.js', '--log-level=warning'], { cwd: root, stdio: 'inherit' })
console.log(`[${new Date().toISOString()}] built site/vendor/bars.js`)
