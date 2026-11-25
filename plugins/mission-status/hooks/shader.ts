// The onboarding backdrop, played on the GPU behind the conversation: a slow field of soft purple light on a dark
// ground that settles into a horizontal bar. `settle` rises with each onboarding step; time also settles it over
// about 12 s. Under Reduce Motion (`still`) it shows the settled bar. The still Svg in onboarding-art.ts is its last
// frame. This file is the shader language of 'claude-code/shader', never run as a module.
import { clamp, exp, max, mix, picture, shader, sin, cos, smoothstep, still, size, time, values, vec2, vec3, vec4 } from 'claude-code/shader'

const v = values({ settle: [0, 1] })

const GROUND = vec3(0.055, 0.047, 0.09)
const LIGHT = vec3(0.545, 0.486, 0.965) // #8B7CF6
const DEEP = vec3(0.455, 0.384, 0.91) // #7462E8
const BAR_Y = 0.72

const sky = picture(p => {
  const aspect = size.x / max(size.y, 1)
  const t = time * 0.11 * (1 - still)
  const s = clamp(max(v.settle, smoothstep(0, 12, time)) + still, 0, 1)
  const ease = s * s * (3 - 2 * s)
  const q = vec2(p.uv.x * aspect, p.uv.y)

  // The field: five soft motes that drift, each pulled toward the bar's line as it settles.
  let field = 0
  for (const k of [0, 1, 2, 3, 4]) {
    const home = vec2((0.1 + 0.2 * k) * aspect + 0.12 * aspect * sin(t * (0.7 + 0.13 * k) + k * 1.7), 0.5 + 0.3 * cos(t * (0.5 + 0.11 * k) + k * 2.3))
    const c = vec2(home.x, mix(home.y, BAR_Y, ease))
    const d = vec2(q - c)
    const r = mix(0.22, 0.09, ease)
    field = field + exp(-(d.x * d.x + d.y * d.y * mix(1, 9, ease)) / (r * r))
  }

  // The bar: a soft line of light, full across, faded at the two sides.
  const dy = (p.uv.y - BAR_Y) / 0.035
  const sides = smoothstep(0, 0.25, p.uv.x) * smoothstep(1, 0.75, p.uv.x)
  const bar = (exp(-dy * dy) + 0.35 * exp(-dy * dy * 0.08)) * sides

  const glow = clamp(mix(field * 0.45, bar * 0.9 + field * 0.12, ease), 0, 1.2)
  const tint = mix(DEEP, LIGHT, clamp(glow, 0, 1))
  const color = vec3(GROUND + tint * glow * 0.6)
  return vec4(color, 1)
})

export default shader({ fps: 30, passes: [sky] })
