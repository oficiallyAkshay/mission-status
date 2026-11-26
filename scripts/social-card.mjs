// Draws the social preview cards from the site's own hero: the headline beside the Claude window with the live pane.
// Run from the repository root while the site is served (for example `python3 -m http.server 8765 -d site`):
//   PLAYWRIGHT=/path/to/package.json/of/a/project/with/playwright node scripts/social-card.mjs http://127.0.0.1:8765/
// Writes site/og.png (1200 x 630, link previews) and docs/assets/social-preview.png (1280 x 640, the repository's
// social preview, uploaded by hand under Settings, General, Social preview) and docs/assets/progress-tab.png (1600 x
// 1075, the README picture). Re-run after the hero or the demo pane changes.
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const url = process.argv[2] || 'http://127.0.0.1:8765/'
if (!process.env.PLAYWRIGHT) throw new Error('Set PLAYWRIGHT to the package.json of a project that has playwright.')
const { chromium } = createRequire(process.env.PLAYWRIGHT)('playwright')

// The card keeps the mark, the headline, the sub-line and the Claude desktop window: the chat on the left and the whole
// pane beside it, so the card reads as a plugin inside the app, not a standalone app. It drops every control and the
// repository numbers.
const CARD_CSS = `
  section.hero { grid-template-columns: 470px minmax(0, 1fr) !important; height: 100vh !important; min-height: 0 !important; }
  section.hero .pick, section.hero .access { display: none !important; }
  section.hero .hero-copy { justify-content: center !important; padding: 0 24px 0 56px !important; width: auto !important; margin: 0 !important; }
  section.hero h1 { font-size: 54px !important; line-height: 1.02 !important; }
  section.hero .subhead { font-size: 22px !important; margin: 18px 0 0 !important; }
  section.hero .desk { height: 100vh !important; min-height: 0 !important; }
  section.hero .window { left: 36px !important; right: 32px !important; top: 60px !important; width: auto !important; zoom: 1 !important; }
  section.hero .window-body { grid-template-columns: minmax(0, 1fr) 420px !important; }
  section.hero .chat-scroll { padding: 14px 16px 8px !important; font-size: 11px !important; }
  section.hero .chat-scroll p { max-width: 92% !important; }
  section.hero .chat-scroll p.user { max-width: 70% !important; }
  section.hero .chat-head .share, section.hero .chat-head .sep { display: none !important; }
`
// The README picture: the Claude window alone, the chat beside the pane, on the hero's field.
const WINDOW_CSS = `
  section.hero { grid-template-columns: minmax(0, 1fr) !important; height: 100vh !important; min-height: 0 !important; }
  section.hero .hero-copy, .nav { display: none !important; }
  section.hero .desk { height: 100vh !important; min-height: 0 !important; }
  section.hero .window { left: 80px !important; right: 80px !important; top: 80px !important; width: auto !important; zoom: 1.2 !important; }
  section.hero .window-body { grid-template-columns: minmax(0, 1fr) 440px !important; }
  section.hero .chat-head .share, section.hero .chat-head .sep { display: none !important; }
`
const cards = [
  { out: 'site/og.png', width: 1200, height: 630, css: CARD_CSS },
  { out: 'docs/assets/social-preview.png', width: 1280, height: 640, css: CARD_CSS },
  { out: 'docs/assets/progress-tab.png', width: 1600, height: 1075, css: WINDOW_CSS },
]
const browser = await chromium.launch()
for (const c of cards) {
  const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height }, deviceScaleFactor: c.scale ?? 1, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto(url, { waitUntil: 'networkidle' })
  if (c.css) await page.addStyleTag({ content: c.css })
  await page.waitForTimeout(1500)
  await (c.selector ? page.locator(c.selector) : page).screenshot({ path: path.join(root, c.out) })
  console.log(`[${new Date().toISOString()}] wrote ${c.out} (${c.width} x ${c.height})`)
  await ctx.close()
}
await browser.close()
