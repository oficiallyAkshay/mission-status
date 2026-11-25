import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import {
  AUTO_LABEL,
  AUTO_LINE,
  CONSENT_CHANGE_LINE,
  CONSENT_LINE,
  FIELDS_URL,
  SCENE,
  SHARE_LABEL,
  STEPS,
  STILL_ALT,
  STILL_SVG,
  WELCOME_LINE,
  WELCOME_PANE,
  WELCOME_TITLE,
  demoFrame,
  switchSvg,
} from './onboarding-art'
import type { Step } from './onboarding-art'
import { tick } from './store'
import { CONSENT_KEY, NOTICE_KEY } from './metrics'
import { AUTO_KEY, setAutoUpdate } from './update'

// $.store key: the onboarding ended once on this install. $.state lasts one session; these choices last.
export const ONBOARDED_KEY = 'onboarded'

// The onboarding shows once for each signed-in account. The store keeps a one-way hash of the account, never the
// account itself, and nothing about it leaves this machine.
export function accountHash(text: string): string {
  let h = 0x811c9dc5
  for (let k = 0; k < text.length; k++) {
    h ^= text.charCodeAt(k)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

async function onboardedKey($: EngineInterface): Promise<string> {
  try {
    const id = (await $.session.identity()) as { kind?: string; organizationId?: string; email?: string }
    return `${ONBOARDED_KEY}:${accountHash(`${id.kind ?? ''}|${id.organizationId ?? ''}|${id.email ?? ''}`)}`
  } catch {
    return ONBOARDED_KEY
  }
}

// The first-run onboarding, desktop app only: a Welcome pane with two steps (Welcome with a live demo, then Metrics),
// and while it is open a shader backdrop.
// Stored values (types/index.d.ts): `consent` ('yes', 'no' or null) and `onboarded`. The demo reads the pane clock
// `now` (store.ts): each write redraws its readers, so the demo moves one frame a second.
const consent = atom({ plugin: 'mission-status', key: 'consent' } as const, null as 'yes' | 'no' | null)
const onboarded = atom({ plugin: 'mission-status', key: 'onboarded' } as const, false)
// True once the Metrics step has shown the notice; the switch starts on only then.
const noticeShown = atom({ plugin: 'mission-status', key: 'metricsNoticeShown' } as const, false)
// The pane clock, the same stored value as store.ts's `now`, declared here so the scan reads its key.
const now = atom({ plugin: 'mission-status', key: 'now' } as const, 0)
// Auto-update: on unless the person turns it off here or later.
const autoUpdate = atom({ plugin: 'mission-status', key: 'autoUpdate' } as const, null as boolean | null)

// How far the backdrop has settled into its bar at each step.
const SETTLE = [0, 0.6] as const

// The module's own state. A reload starts it over: the pane then shows the first step again.
let step: Step = 0
let isActive = false
let demoStart = 0
let demoClock: { cancel: () => void } | null = null
// True while the onboarding's backdrop is the session's theme. A Backdrop drawn for another plugin means that plugin
// set its theme after ours: the end of the onboarding then leaves that theme alone.
let oursStands = false

async function setBackdrop($: EngineInterface): Promise<void> {
  await $.theme.set({ backdrop: { scene: SCENE }, overrideColorScheme: 'dark' })
  oursStands = true
}

// Puts back the person's own background: the app's own look. The API has no read of the theme that stood before, so a
// theme another mod set before the onboarding is not put back; that mod sets it again at its next session start. A
// theme another mod set after ours is left alone.
async function restoreBackdrop($: EngineInterface): Promise<void> {
  if (!oursStands) return
  oursStands = false
  await $.theme.clear()
}

function goTo($: EngineInterface, next: Step): void {
  step = next
  $.ui.invalidate('ui.render')
}

// The demo clock runs while the Welcome pane is open: each second it writes the pane clock, which redraws the demo.
function startDemo($: EngineInterface): void {
  demoStart = Date.now()
  if (demoClock === null) demoClock = $.clock.every(1_000, () => void tick($))
  void tick($)
}

function stopDemo(): void {
  demoClock?.cancel()
  demoClock = null
}

// The Metrics step shows: the first time, the switch is on, so consent is 'yes' and the notice is recorded as shown.
// Later visits keep the person's own choice.
async function showMetrics($: EngineInterface): Promise<void> {
  if (!(await read($, noticeShown))) {
    await setConsent($, 'yes')
    await update($, noticeShown, () => true)
    await keep($, NOTICE_KEY, true)
  }
  goTo($, 1)
}

// Keeps a choice for later sessions; a store that cannot be written leaves the session's own value.
async function keep($: EngineInterface, key: string, value: unknown): Promise<void> {
  await $.store.set(key, value).catch(() => undefined)
}

async function setConsent($: EngineInterface, value: 'yes' | 'no'): Promise<void> {
  await update($, consent, () => value)
  await keep($, CONSENT_KEY, value)
}

// The session's values start from what this install kept: the onboarding, the consent and the notice.
async function hydrate($: EngineInterface): Promise<void> {
  if ((await $.store.get(await onboardedKey($))) === true) await update($, onboarded, () => true)
  const kept = await $.store.get(CONSENT_KEY)
  if ((kept === 'yes' || kept === 'no') && (await read($, consent)) === null) await update($, consent, () => kept)
  if ((await $.store.get(NOTICE_KEY)) === true) await update($, noticeShown, () => true)
  const auto = await $.store.get(AUTO_KEY)
  if (typeof auto === 'boolean') await update($, autoUpdate, () => auto)
}

async function begin($: EngineInterface): Promise<void> {
  isActive = true
  goTo($, 0)
  startDemo($)
  await setBackdrop($).catch(() => undefined)
  await $.ui.open({ id: WELCOME_PANE, title: WELCOME_TITLE }).catch(() => undefined)
}

async function finish($: EngineInterface, closePane: boolean): Promise<void> {
  stopDemo()
  isActive = false
  await update($, onboarded, () => true)
  await keep($, await onboardedKey($), true)
  await restoreBackdrop($).catch(() => undefined)
  if (closePane) await $.ui.close({ id: WELCOME_PANE }).catch(() => undefined)
}

async function isDesktop($: EngineInterface, surface: string | null): Promise<boolean> {
  if (surface === 'desktop') return true
  try {
    return (await $.session.surfaces()).includes('desktop')
  } catch {
    return false
  }
}

export function registerOnboarding(on: On): void {
  // The matcher keeps this hook apart from register.tsx's own session.start hook: a desktop session, or one whose
  // surface attaches later (the desktop app starts the session first).
  on('session.start', { surface: ['desktop', null] }, async ($, e, next) => {
    await $.command.register({ name: 'mission-status-welcome', description: 'Show the mission-status welcome again' }).catch(() => undefined)
    // A store that cannot be read leaves the session's own values.
    await hydrate($).catch(() => undefined)
    try {
      if (!(await read($, onboarded)) && (await isDesktop($, e.surface))) await begin($)
    } catch {
      // The onboarding is a nicety: a failure never holds up the session.
    }
    return next(e)
  })

  // The desktop app can attach after the session starts.
  on('session.attach', { surface: 'desktop' }, async ($, e, next) => {
    try {
      if (!isActive && !(await read($, onboarded))) await begin($)
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'mission-status-welcome' }, async $ => {
    await begin($)
    return { text: 'The welcome pane is open.' }
  })

  // The person closes the pane: the onboarding ends where it stands.
  on('ui.close', { id: WELCOME_PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person' && isActive) await finish($, false).catch(() => undefined)
    else stopDemo()
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)) as never)

  on('ui.render', { component: 'Backdrop', surface: ['desktop', 'mobile'] }, ($, e, next) => {
    if (e.props.plugin !== 'mission-status' || e.props.scene !== SCENE) {
      oursStands = false
      return next(e)
    }
    const { Shader, Svg } = $.ui.resolve(e)
    return (
      <Shader module="./shader.ts" values={{ settle: SETTLE[step] }}>
        <Svg source={STILL_SVG} alt={STILL_ALT} />
      </Shader>
    )
  })

  on('ui.render', { component: 'Pane', requestId: WELCOME_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const svg = (source: string, alt: string, key: string, height: number) =>
      Svg === undefined ? <Text key={key}>{alt}</Text> : <Svg key={key} source={source} alt={alt} height={height} />

    if (step === 0) {
      const clock = await read($, now)
      const f = demoFrame(Math.max(0, clock - demoStart))
      return (
        <Box flexDirection="column" gap={1}>
          <Text size="heading" weight="semibold">
            {STEPS[0]}
          </Text>
          <Text wrap="wrap">{WELCOME_LINE}</Text>
          {svg(f.track.source, f.track.alt, 'demo-track', 30)}
          <Text size="caption" dimColor>
            {f.action}
          </Text>
          {svg(f.helper.source, f.helper.alt, 'demo-helper', 22)}
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="next" label="Next" variant="primary" onPress={() => showMetrics($)} />
          </Box>
        </Box>
      )
    }

    // Metrics: one switch, on at first. Each turn writes the consent value at once.
    const isOn = (await read($, consent)) !== 'no'
    const flip = () => setConsent($, isOn ? 'no' : 'yes')
    const isAuto = (await read($, autoUpdate)) !== false
    const flipAuto = () => setAutoUpdate($, !isAuto)
    return (
      <Box flexDirection="column" gap={1}>
        <Text size="heading" weight="semibold">
          {STEPS[1]}
        </Text>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {svg(switchSvg(isOn), `${SHARE_LABEL}: ${isOn ? 'on' : 'off'}`, 'share-switch', 20)}
          <Button key="share" label={SHARE_LABEL} plain onPress={flip} />
        </Box>
        <Text wrap="wrap">{CONSENT_LINE}</Text>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {svg(switchSvg(isAuto), `${AUTO_LABEL}: ${isAuto ? 'on' : 'off'}`, 'auto-switch', 20)}
          <Button key="auto" label={AUTO_LABEL} plain onPress={flipAuto} />
        </Box>
        <Text wrap="wrap">{AUTO_LINE}</Text>
        <Text size="caption" dimColor wrap="wrap">
          {CONSENT_CHANGE_LINE} <Link href={FIELDS_URL}>See the field list</Link>
        </Text>
        <Box flexDirection="row" justifyContent="space-between">
          <Button key="back" label="Back" onPress={() => goTo($, 0)} />
          <Button key="done" label="Done" variant="primary" onPress={() => finish($, true)} />
        </Box>
      </Box>
    )
  })
}
