// Pure colour mapping used to derive the light theme from the dark stylesheet.
// Neutral (low-saturation) colours are inverted in lightness: dark surfaces become
// near-white, light text becomes dark slate. Saturated accents keep their hue;
// pale accent text is darkened so it stays readable on white.

const HEX = /#([0-9a-fA-F]{3,8})\b/g;
const RGBA = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([0-9.]+)\s*)?\)/g;

function clamp01(value) { return Math.max(0, Math.min(1, value)); }

export function rgbToHsl(r, g, b) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h / 6, s, l };
}

export function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  const hue = (p, q, t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: Math.round(hue(p, q, h + 1 / 3) * 255), g: Math.round(hue(p, q, h) * 255), b: Math.round(hue(p, q, h - 1 / 3) * 255) };
}

/** Map one dark-theme RGB colour to its light-theme counterpart. */
export function lightenForLightTheme(r, g, b) {
  const { h, s, l } = rgbToHsl(r, g, b);
  const neutral = s < 0.28 || l < 0.12;
  let nl;
  let ns = s;
  if (neutral) {
    if (l <= 0.2) nl = 0.985 - l * 0.45;            // surfaces → near-white (#f6f8fa … #e9edf2)
    else if (l <= 0.42) nl = 0.9 - (l - 0.2) * 0.9;   // borders / dividers → light greys
    else nl = clamp01(0.62 - l * 0.55);             // text → dark slate, brighter text gets darker
    ns = Math.min(s, 0.18);
  } else if (l >= 0.6) {
    nl = 0.34; ns = Math.min(1, s * 0.9);          // pale accent text → deep accent
  } else if (l <= 0.3) {
    nl = 0.93; ns = Math.min(s, 0.45);             // dark tinted surfaces → light tint
  } else {
    nl = Math.min(l, 0.46);                         // mid accents (candles, buttons) → slightly deeper
  }
  return hslToRgb(h, ns, clamp01(nl));
}

function parseHex(hex) {
  let value = hex;
  if (value.length === 3 || value.length === 4) value = [...value].map((c) => c + c).join("");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  const a = value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : null;
  return { r, g, b, a };
}

function format({ r, g, b }, alpha) {
  if (alpha == null) return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
}

/**
 * Rewrite every colour inside a CSS declaration value. Shadows keep black but get
 * softer; everything else goes through lightenForLightTheme.
 */
export function mapDeclarationValue(prop, value) {
  const isShadow = prop === "box-shadow" || prop === "text-shadow";
  const mapRgb = (r, g, b, alpha) => {
    if (isShadow && rgbToHsl(r, g, b).l < 0.1) return format({ r: 15, g: 23, b: 42 }, (alpha ?? 1) * 0.35);
    return format(lightenForLightTheme(r, g, b), alpha);
  };
  return value
    .replace(RGBA, (_, r, g, b, a) => mapRgb(Number(r), Number(g), Number(b), a == null ? 1 : Number(a)).replace(/^#(.{6})$/, (m) => m))
    .replace(HEX, (match, hex) => {
      if (![3, 4, 6, 8].includes(hex.length)) return match;
      const { r, g, b, a } = parseHex(hex);
      return mapRgb(r, g, b, a);
    });
}

export function hasColor(value) {
  HEX.lastIndex = 0; RGBA.lastIndex = 0;
  const found = /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(value);
  return found;
}
