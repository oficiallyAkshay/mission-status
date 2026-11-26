const ACCENT = "#8B7CF6";
const PILL = "#7462E8";
const GREEN = "#4FA569";
const LIGHT = { accent: "#5B4BD6", green: "#2F7D47", amber: "#9A6312", grey: "#6F6D66", ink: "#2A2833", page: "#FAF9F5" };
const DARK_PAGE = "#1F1E1D";
const LINE = "#8B8A85";
const FONT = "'Anthropic Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif";
const uid = (...input) => {
  const text = JSON.stringify(input);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `v${(h >>> 0).toString(36)}`;
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const textWidth = (s, px = 12) => Math.ceil([...s].length * px * 0.6);
const pct = (x) => `${(Math.max(0, Math.min(1, x)) * 100).toFixed(2)}%`;
function dither(id, width, height, color, from = 0.15, to = 0.9) {
  return `<defs><linearGradient id="${id}g" x1="0" x2="1"><stop offset="0" stop-color="${color}" stop-opacity="${(from * 0.6).toFixed(2)}"/><stop offset="1" stop-color="${color}" stop-opacity="${(to * 0.6).toFixed(2)}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#${id}g)"/>`;
}
function trackSvg(input) {
  const { total, done, current, isDone, doneLabel = "Done", clock = 0, names = [], tips = [], checks } = input;
  const H = 30;
  const n = Math.max(1, total);
  const id = uid(total, done, current, isDone, doneLabel, clock, names, tips);
  const seg = isDone ? n - 1 : Math.max(0, Math.min(done, n - 1));
  const isOut = !isDone && (done < 0 || done >= n);
  const shown = (k) => {
    const name = names[k] ?? "";
    const isPast = checks !== void 0 ? checks[k] === true : k < seg || isDone;
    return isPast ? `\u2713 ${name}` : name;
  };
  const weights = Array.from({ length: n }, (_, k) => Math.max(36, textWidth(k === seg ? isDone ? doneLabel : current ?? "" : shown(k), k === seg ? 12 : 11) + 28));
  const sum = weights.reduce((a, b) => a + b, 0);
  const at = (k) => weights.slice(0, k).reduce((a, b) => a + b, 0) / sum;
  const span = (k) => (weights[k] ?? 0) / sum;
  const label = isDone ? doneLabel : isOut ? "" : current ?? "";
  const isPastAt = (k) => isDone ? true : checks !== void 0 ? checks[k] === true : isOut ? done >= n : k < seg;
  let fills = "";
  for (let k = 0; k < n; k++) {
    if (!isPastAt(k)) continue;
    fills += `<svg x="${pct(at(k))}" width="${pct(span(k))}" height="${H}"><rect width="100%" height="${H}" fill="${GREEN}" fill-opacity=".22"/>${dither(`${id}d${k}`, "100%", H, GREEN)}</svg>`;
  }
  let marks = "";
  for (let k = 0; k < n; k++) {
    if (!isDone && !isOut && k === seg) continue;
    if (isDone && k === n - 1) continue;
    const name = names[k] ?? "";
    if (k > 0 && (isOut || k !== seg + 1)) marks += `<svg x="${pct(at(k))}" overflow="visible"><rect x="-.5" y="9" width="1" height="${H - 18}" class="dv"/></svg>`;
    if (name === "") continue;
    const isPast = checks !== void 0 ? checks[k] === true : k < seg || isDone;
    marks += `<svg x="${pct(at(k))}" width="${pct(span(k))}" height="${H}"><text x="50%" y="${H / 2 + 4}" text-anchor="middle" style="font:500 11px ${FONT}" class="${isPast ? "np" : "nf"}">${esc(isPast ? `\u2713 ${name}` : name)}</text></svg>`;
  }
  const nameStyle = `<style>.np{fill:#fff;fill-opacity:.78}.nf{fill:#A8A69E;fill-opacity:.85}.dv{fill:#fff;fill-opacity:.12}@media (prefers-color-scheme:light){.np{fill:${LIGHT.ink};fill-opacity:.85}.nf{fill:${LIGHT.grey};fill-opacity:1}.dv{fill:#000;fill-opacity:.14}}</style>`;
  const pill = `<svg x="${pct(at(seg))}" width="${pct(span(seg))}" height="${H}"><rect width="100%" height="${H}" fill="${isDone ? "#3E8E57" : PILL}"/><text x="50%" y="${H / 2 + 4}" text-anchor="middle" style="font:600 12px ${FONT}" fill="#fff">${esc(label)}</text></svg>`;
  const shimmer = `<defs><pattern id="${id}st" width="15" height="9" patternUnits="userSpaceOnUse"><rect x="3" width="2" height="2" fill="#fff"/><rect x="9" y="3" width="2" height="2" fill="#fff"/><rect y="6" width="2" height="2" fill="#fff"/><rect x="12" y="6" width="2" height="2" fill="#fff"/></pattern></defs>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}">${shimmer}${nameStyle}<defs><clipPath id="${id}k"><rect width="100%" height="${H}" rx="6"/></clipPath></defs><g clip-path="url(#${id}k)"><rect width="100%" height="${H}" fill="#808080" fill-opacity=".16"/>${fills}${marks}${label === "" ? "" : pill}</g>` + tips.map((tip, k) => tip === "" ? "" : `<rect x="${pct(at(k))}" width="${pct(span(k))}" height="${H}" fill="#000" fill-opacity="0"><title>${esc(tip)}</title></rect>`).join("") + `</svg>`;
}
function phaseBegin(now, durMs, offsetMs = 0) {
  const at = ((now - offsetMs) % durMs + durMs) % durMs;
  return `-${(at / 1e3).toFixed(3)}s`;
}
const NARROW = /* @__PURE__ */ new Set([..."iljtfr.,:;!|' "]);
const WIDE = /* @__PURE__ */ new Set([..."mwMW"]);
const pulseWidth = (name) => Math.ceil([...name].reduce((sum, ch) => sum + 12 * (NARROW.has(ch) ? 0.3 : WIDE.has(ch) ? 0.85 : ch >= "A" && ch <= "Z" ? 0.68 : /\d/.test(ch) ? 0.6 : 0.56), 0)) + 2;
function stripSvg({ title, detail, state, time = "", now = 0 }) {
  const H = 22;
  const id = uid(title, detail, state, time, now);
  const tint = state === "running" ? ACCENT : state === "done" ? GREEN : "#D67278";
  const mark = state === "running" ? (
    // Turns once every 1.2 s, from the wall clock's place in that turn, so a rebuild picks up where the turn was.
    `<circle cx="12" cy="${H / 2}" r="3.5" fill="none" stroke="${tint}" stroke-width="1.6" stroke-dasharray="14 8"><animateTransform attributeName="transform" type="rotate" from="0 12 ${H / 2}" to="360 12 ${H / 2}" dur="1.2s" begin="${phaseBegin(now, 1200)}" repeatCount="indefinite"/></circle>`
  ) : `<circle cx="12" cy="${H / 2}" r="3.5" fill="${tint}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}"><style>.i{fill:#F0EEFC}.d{fill:#A7A5AE}@media (prefers-color-scheme:light){.i{fill:#222226}.d{fill:#5B5B5E}}</style><defs><clipPath id="${id}r"><rect width="100%" height="${H}" rx="6"/></clipPath></defs><g clip-path="url(#${id}r)"><rect width="100%" height="${H}" fill="${tint}" fill-opacity=".14"/>${state === "running" ? dither(`${id}d`, "70%", H, tint, 0.55, 0) : ""}</g>` + mark + `<text x="24" y="${H / 2 + 4}" style="font:500 12px ${FONT}"><tspan class="i">${esc(title)}</tspan>${detail ? `<tspan class="d"> (${esc(detail)})</tspan>` : ""}</text>` + (time === "" ? "" : `<text x="100%" dx="-10" y="${H / 2 + 4}" text-anchor="end" class="d" style="font:400 11px ${FONT}">${esc(time)}</text>`) + `</svg>`;
}
function badgeSvg(state, clock, size = 20, up, down) {
  if (up !== void 0 || down !== void 0) {
    const inner = badgeSvg(state, clock, size);
    const pad = (20 - size) / 2;
    const stub = (y1, y2) => `<path class="wa" d="M8 ${y1} V${y2}" stroke-width="1.5"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="20">${WAITS_STYLE}` + (up === true ? stub(0, pad) : "") + (down === true ? stub(20 - pad, 20) : "") + `<g transform="translate(${(16 - size) / 2} ${pad})">${inner.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g></svg>`;
  }
  const S = size;
  if (state === "dot")
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><circle cx="${S / 2}" cy="${S / 2}" r="${S * 0.3}" fill="${ACCENT}"/></svg>`;
  const c = S / 2;
  const id = uid(state, clock, size);
  if (state === "done")
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><defs><linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5BC07A"/><stop offset="1" stop-color="#2F8A4C"/></linearGradient></defs><circle cx="${c}" cy="${c}" r="${c - 1}" fill="url(#${id}g)"/><path d="M${c - S * 0.2125} ${c + S * 0.0125}l${S * 0.15} ${S * 0.15} ${S * 0.275}-${S * 0.3}" fill="none" stroke="#fff" stroke-width="${S / 10}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  if (state === "now") {
    const r = c - 2;
    const arc = 2 * Math.PI * r;
    const begin = phaseBegin(clock, 1e3);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><style>@media (prefers-color-scheme:light){.ba{stroke:${LIGHT.accent}}}</style><circle class="ba" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ACCENT}" stroke-opacity=".22" stroke-width="2"/><circle class="ba" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linecap="round" stroke-dasharray="${(arc * 0.28).toFixed(2)} ${arc.toFixed(2)}"><animateTransform attributeName="transform" type="rotate" from="0 ${c} ${c}" to="360 ${c} ${c}" dur="1s" begin="${begin}" repeatCount="indefinite"/></circle></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><style>.bn{stroke:#A8A69E;stroke-opacity:.55}@media (prefers-color-scheme:light){.bn{stroke:${LIGHT.grey};stroke-opacity:.8}}</style><circle class="bn" cx="${c}" cy="${c}" r="${c - 2.5}" fill="none" stroke-width="1.5"/></svg>`;
}
function failedBadgeSvg(size = 16, up, down) {
  const S = size;
  const c = S / 2;
  const k = S * 0.18;
  const mark = `<style>.bf{stroke:#E5484D}@media (prefers-color-scheme:light){.bf{stroke:#C4314B}}</style><circle class="bf" cx="${c}" cy="${c}" r="${c - 1.5}" fill="none" stroke-width="1.6"/><path class="bf" d="M${c - k} ${c - k} L${c + k} ${c + k} M${c + k} ${c - k} L${c - k} ${c + k}" stroke-width="1.6" stroke-linecap="round"/>`;
  if (up === void 0 && down === void 0) return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${mark}</svg>`;
  const pad = (20 - S) / 2;
  const stub = (y1, y2) => `<path class="wa" d="M8 ${y1} V${y2}" stroke-width="1.5"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="20">${WAITS_STYLE}` + (up === true ? stub(0, pad) : "") + (down === true ? stub(20 - pad, 20) : "") + `<g transform="translate(${(16 - S) / 2} ${pad})">${mark}</g></svg>`;
}
function needsBadgeSvg(size = 16) {
  const S = size;
  const c = S / 2;
  const h = S * 0.11;
  const w = S * 0.2;
  const mark = `<style>.bn{stroke:#E5A23D}.bnf{fill:#E5A23D}@media (prefers-color-scheme:light){.bn{stroke:#A8650A}.bnf{fill:#A8650A}}</style><circle class="bn" cx="${c}" cy="${c}" r="${c - 1.5}" fill="none" stroke-width="1.6"/><circle class="bnf" cx="${c}" cy="${c - h * 0.9}" r="${h}"/><path class="bn" d="M${c - w} ${c + w * 1.05} Q${c} ${c + h * 0.6 - w * 0.15} ${c + w} ${c + w * 1.05}" fill="none" stroke-width="1.6" stroke-linecap="round"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">${mark}</svg>`;
}
const WAITS_STYLE = `<style>.wa{stroke:${LINE}}@media (prefers-color-scheme:light){.wa{stroke:${LIGHT.grey}}}</style>`;
function waitsLineSvg(height = 20) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="${height}">${WAITS_STYLE}<path class="wa" d="M8 0 V${height}" stroke-width="1.5"/></svg>`;
}
function exitSvg(text, isLast, isMet = false) {
  const H = 40;
  const X = 19;
  const id = uid(text, isLast, isMet);
  const PAD = 12;
  const ICON = 12;
  const label = isMet ? text : `Needs: ${text}`;
  const left = X - 10;
  const w = Math.min(360, PAD + ICON + 6 + textWidth(label, 11) + PAD);
  const ix = left + PAD;
  const iy = H / 2 - ICON / 2;
  const icon = isMet ? `<path class="g${id}" d="M${ix + 1.5} ${iy + 6.5} l3 3 l6 -6.5" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>` : `<path class="i${id}" d="M${ix + 2} ${iy + 11.5} V${iy + 1} M${ix + 2} ${iy + 1.5} H${ix + 10} L${ix + 8} ${iy + 4} L${ix + 10} ${iy + 6.5} H${ix + 2}" fill="none" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  const chip = isMet ? `fill:${DARK_PAGE};stroke:${GREEN};stroke-opacity:.8` : `fill:${DARK_PAGE};stroke:${LINE};stroke-opacity:.7`;
  const chipLight = isMet ? `fill:${LIGHT.page};stroke:${LIGHT.green}` : `fill:${LIGHT.page};stroke:${LIGHT.grey}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${H}"><style>.t${id}{font:500 11px ${FONT};fill:${isMet ? GREEN : "#B9B6C8"}}.c${id}{${chip}}.el{stroke:${LINE};stroke-opacity:.6}.i${id}{stroke:#B9B6C8}.g${id}{stroke:${GREEN}}@media (prefers-color-scheme:light){.t${id}{fill:${isMet ? LIGHT.green : "#55545C"}}.c${id}{${chipLight}}.el{stroke:${LIGHT.grey};stroke-opacity:.7}.i${id}{stroke:#55545C}.g${id}{stroke:${LIGHT.green}}}</style><line class="el" x1="${X}" y1="0" x2="${X}" y2="${isLast ? H / 2 : H}" stroke-width="1.4"/><rect class="c${id}" x="${left}" y="${H / 2 - 10}" width="${w}" height="20" rx="10" stroke-width="1"/>` + icon + `<text class="t${id}" x="${ix + ICON + 6}" y="${H / 2 + 4}">${esc(label)}</text></svg>`;
}
function flowLineSvg(height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}">${WAITS_STYLE}<line class="wa" x1="19" y1="0" x2="19" y2="${height}" stroke-width="1.4"/></svg>`;
}
function stepsRailSvg(states) {
  const n = Math.max(1, states.length);
  const gap = 0.6;
  const w = (100 - gap * (n - 1)) / n;
  const fill = { done: GREEN, now: ACCENT, next: "#808080", failed: "#D9534F", blocked: "#D4A13A" };
  const op = { done: "1", now: "1", next: ".3", failed: "1", blocked: ".85" };
  const bars = states.map((st, k) => `<rect x="${(k * (w + gap)).toFixed(3)}%" y="0" width="${w.toFixed(3)}%" height="6" rx="3" fill="${fill[st]}" fill-opacity="${op[st]}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="6">${bars}</svg>`;
}
function prIconSvg(state) {
  const color = { merged: "#8957E5", open: "#3FB950", draft: "#8B949E", conflict: "#D29922", closed: "#F85149" }[state];
  const stroke = `fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`;
  const ring = (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="1.75" ${stroke}/>`;
  const body = state === "merged" ? (
    // git-merge: a ring at the top left, its line down, a curve into the ring at the right.
    `${ring(4.5, 3.5)}${ring(4.5, 12.5)}${ring(11.5, 8)}<path d="M4.5 5.25v5.5M4.5 5.25c0 2.2 2.4 2.75 5.25 2.75" ${stroke}/>`
  ) : state === "closed" ? (
    // git-pull-request-closed: the base ring and line, and a cross where the head would be.
    `${ring(4.5, 3.5)}${ring(4.5, 12.5)}<path d="M4.5 5.25v5.5M10 2.5l3 3M13 2.5l-3 3" ${stroke}/>${ring(11.5, 12.5)}<path d="M11.5 8.5v2.25" ${stroke}/>`
  ) : state === "draft" ? (
    // git-pull-request-draft: the base ring and line, and dots up to the head ring.
    `${ring(4.5, 3.5)}${ring(4.5, 12.5)}<path d="M4.5 5.25v5.5" ${stroke}/>${ring(11.5, 12.5)}<circle cx="11.5" cy="3.5" r=".9" fill="${color}"/><circle cx="11.5" cy="7.25" r=".9" fill="${color}"/>`
  ) : (
    // git-pull-request (open, or a conflict in amber): the base ring and line, and an arrow back to the head ring.
    `${ring(4.5, 3.5)}${ring(4.5, 12.5)}<path d="M4.5 5.25v5.5M11.5 10.75V6a2 2 0 0 0-2-2H7.5M8.75 2.6L7.3 4l1.45 1.4" ${stroke}/>${ring(11.5, 12.5)}`
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${body}</svg>`;
}
function stepPulseSvg(name, k, running, now = 0) {
  const w = pulseWidth(name);
  const style = `<style>.sp{fill:rgba(128,128,128,.75)}.s0{stop-color:rgb(128,128,128);stop-opacity:.75}.s1{stop-color:#F0EEFC;stop-opacity:1}@media (prefers-color-scheme:light){.sp{fill:${LIGHT.grey}}.s0{stop-color:${LIGHT.grey};stop-opacity:1}.s1{stop-color:${LIGHT.ink}}}</style>`;
  if (!running)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="16">${style}<text class="sp" x="0" y="12" style="font:400 12px ${FONT}">${esc(name)}</text></svg>`;
  const B = 36;
  const id = uid("shimmer", name, w);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="16">${style}<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" x2="${B}" y1="0" y2="0"><stop class="s0" offset="0"/><stop class="s1" offset=".5"/><stop class="s0" offset="1"/><animateTransform attributeName="gradientTransform" type="translate" values="${-B};${w + B}" dur="1.6s" begin="${phaseBegin(now, 1600, k * 250)}" repeatCount="indefinite"/></linearGradient></defs><text x="0" y="12" fill="url(#${id})" style="font:400 12px ${FONT}">${esc(name)}</text></svg>`;
}
export {
  DARK_PAGE,
  LIGHT,
  badgeSvg,
  exitSvg,
  failedBadgeSvg,
  flowLineSvg,
  needsBadgeSvg,
  phaseBegin,
  prIconSvg,
  pulseWidth,
  stepPulseSvg,
  stepsRailSvg,
  stripSvg,
  textWidth,
  trackSvg,
  waitsLineSvg
};
