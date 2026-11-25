import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'
import {
  CONSENT_CHANGE_LINE,
  CONSENT_LINE,
  DONE_LINE,
  DONT_SHARE_LABEL,
  FIELDS_URL,
  LAST_STEP,
  SCENE,
  SESSION_TYPES,
  SHARE_LABEL,
  STEPS,
  STILL_ALT,
  STILL_SVG,
  WELCOME_LINE,
  WELCOME_PANE,
  WELCOME_TITLE,
  demoFrame,
  typeTileSvg,
} from './onboarding-art'
import type { Step } from './onboarding-art'

// The first-run onboarding, desktop app only: a Welcome pane with five steps, and during the steps a shader backdrop.
// Stored values (types/index.d.ts): `consent` ('yes', 'no' or null) and `onboarded`.
const consent = atom({ plugin: 'mission-status', key: 'consent' } as const, null as 'yes' | 'no' | null)
const onboarded = atom({ plugin: 'mission-status', key: 'onboarded' } as const, false)

// How far the backdrop has settled into its bar at each step: a field at Welcome, the bar at Done.
const SETTLE = [0, 0.25, 0.5, 0.75, 1] as const

// The module's own state. A reload starts it over: the pane then shows the first step again.
let step: Step = 0
let isActive = false
let demoStart = 0
let stopDemo: { cancel: () => void } | null = null
// True while the onboarding's backdrop is the session's theme. A Backdrop drawn for another plugin means that plugin
// set its theme after ours: the end of the onboarding then leaves that theme alone.
let oursStands = false

// For the tests: the module state back to a fresh load.
export function resetOnboarding(): void {
  stopDemo?.cancel()
  step = 0
  isActive = false
  demoStart = 0
  stopDemo = null
  oursStands = false
}

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
  if (step === 1 && stopDemo === null) {
    demoStart = Date.now()
    stopDemo = $.clock.every(1_000, () => $.ui.invalidate('ui.render'))
  }
  if (step !== 1 && stopDemo !== null) {
    stopDemo.cancel()
    stopDemo = null
  }
  $.ui.invalidate('ui.render')
}

async function begin($: EngineInterface): Promise<void> {
  isActive = true
  goTo($, 0)
  await setBackdrop($).catch(() => undefined)
  await $.ui.open({ id: WELCOME_PANE, title: WELCOME_TITLE }).catch(() => undefined)
}

async function finish($: EngineInterface, closePane: boolean): Promise<void> {
  if (stopDemo !== null) {
    stopDemo.cancel()
    stopDemo = null
  }
  isActive = false
  await update($, onboarded, () => true)
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
    const choice = await read($, consent)
    const svg = (source: string, alt: string, key: string, height?: number) =>
      Svg === undefined ? <Text key={key}>{alt}</Text> : <Svg key={key} source={source} alt={alt} height={height} />

    const body = (() => {
      if (step === 0)
        return (
          <Box flexDirection="column" gap={1}>
            <Text wrap="wrap">{WELCOME_LINE}</Text>
          </Box>
        )
      if (step === 1) {
        const f = demoFrame(Date.now() - demoStart)
        return (
          <Box flexDirection="column" gap={1}>
            <Text size="caption" dimColor wrap="wrap">
              A 15 second demo of one session, drawn with the pane's own parts.
            </Text>
            {svg(f.track.source, f.track.alt, 'demo-track', 30)}
            <Box flexDirection="row" gap={2} flexWrap="wrap">
              {f.stages.map(s => (
                <Box key={`demo-stage-${s.name}`} flexDirection="row" alignItems="center" gap={1}>
                  {svg(s.badge, `${s.name}: ${s.state === 'done' ? 'done' : s.state === 'now' ? 'in progress' : 'not started'}`, `demo-badge-${s.name}`, 16)}
                  <Text size="caption" dimColor={s.state === 'next'}>
                    {s.name}
                  </Text>
                </Box>
              ))}
            </Box>
            <Text size="caption" key="demo-action">
              {f.action}
            </Text>
            {svg(f.helper.source, f.helper.alt, 'demo-helper', 22)}
            {svg(f.tests.source, f.tests.alt, 'demo-tests', 6)}
          </Box>
        )
      }
      if (step === 2)
        return (
          <Box flexDirection="column" gap={1}>
            <Text wrap="wrap">Each session picks one of nine types. Each type has its own stages.</Text>
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              {SESSION_TYPES.map(t => (
                <Box key={`type-${t.name}`} flexDirection="column" gap={0} padding={1} borderStyle="round" width={14}>
                  {svg(typeTileSvg(t.stages), `${t.name}: ${t.stages} stages`, `tile-${t.name}`, 14)}
                  <Text size="caption" weight="semibold">
                    {t.name}
                  </Text>
                </Box>
              ))}
            </Box>
          </Box>
        )
      if (step === 3)
        return (
          <Box flexDirection="column" gap={1}>
            <Text wrap="wrap">{CONSENT_LINE}</Text>
            <Text size="caption" dimColor wrap="wrap">
              {CONSENT_CHANGE_LINE} <Link href={FIELDS_URL}>See the field list</Link>
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button
                key="share"
                label={SHARE_LABEL}
                variant={choice === 'yes' ? 'primary' : 'secondary'}
                onPress={async () => {
                  await update($, consent, () => 'yes')
                  goTo($, 4)
                }}
              />
              <Button
                key="dont-share"
                label={DONT_SHARE_LABEL}
                variant={choice === 'no' ? 'primary' : 'secondary'}
                onPress={async () => {
                  await update($, consent, () => 'no')
                  goTo($, 4)
                }}
              />
            </Box>
            {choice !== null && (
              <Text size="caption" dimColor>
                {choice === 'yes' ? 'Your choice: share anonymous usage.' : 'Your choice: do not share.'}
              </Text>
            )}
          </Box>
        )
      return (
        <Box flexDirection="column" gap={1}>
          <Text wrap="wrap">{DONE_LINE}</Text>
        </Box>
      )
    })()

    // On the metrics step, Next shows only once a choice stands: the two choice buttons move on by themselves.
    const showNext = step !== 3 || choice !== null
    return (
      <Box flexDirection="column" gap={1}>
        <Text size="caption" dimColor>{`Step ${step + 1} of ${STEPS.length}`}</Text>
        <Text size="heading" weight="semibold">
          {STEPS[step]}
        </Text>
        {body}
        <Box flexDirection="row" gap={1} justifyContent="flex-end">
          {step > 0 && <Button key="back" label="Back" onPress={() => goTo($, (step - 1) as Step)} />}
          {step < LAST_STEP && showNext && <Button key="next" label="Next" variant="primary" onPress={() => goTo($, (step + 1) as Step)} />}
          {step === LAST_STEP && <Button key="finish" label="Finish" variant="primary" onPress={() => finish($, true)} />}
        </Box>
      </Box>
    )
  })
}

