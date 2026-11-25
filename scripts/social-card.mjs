// Draws the social preview cards from the site's own hero: the headline beside the live pane, with no controls.
// Run from the repository root while the site is served (for example `python3 -m http.server 8765 -d site`):
//   PLAYWRIGHT=/path/to/package.json/of/a/project/with/playwright node scripts/social-card.mjs http://127.0.0.1:8765/
// Writes site/og.png (1200 x 630, link previews) and docs/assets/social-preview.png (1280 x 640, the repository's
// social preview, uploaded by hand under Settings, General, Social preview). Re-run after the hero changes.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const url = process.argv[2] || 'http://127.0.0.1:8765/'
if (!process.env.PLAYWRIGHT) throw new Error('Set PLAYWRIGHT to the package.json of a project that has playwright.')
const { chromium } = createRequire(process.env.PLAYWRIGHT)('playwright')

// The card keeps the mark, the headline, the sub-line and the pane; it drops every control and the repository numbers.
const CARD_CSS = `
  section.hero .pick, section.hero .access { display: none !important; }
  section.hero h1 { font-size: 66px !important; line-height: 1.02 !important; }
  section.hero .subhead { font-size: 26px !important; margin: 18px 0 0 !important; }
  section.hero .hero-copy { justify-content: center !important; }
`
const cards = [
  { out: 'site/og.png', width: 1200, height: 630 },
  { out: 'docs/assets/social-preview.png', width: 1280, height: 640 },
]
const browser = await chromium.launch()
for (const c of cards) {
  const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: CARD_CSS })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(root, c.out) })
  console.log(`[${new Date().toISOString()}] wrote ${c.out} (${c.width} x ${c.height})`)
  await ctx.close()
}
await browser.close()
