/**
 * Recolors the output of `claude` on its way to xterm.js: the process still believes it paints Claude orange
 * (truecolor SGR `38;2;r;g;b`), the browser shows another hue. Only the displayed stream is rewritten.
 */

export type TerminalAccent = 'claude' | 'blue';

export const TERMINAL_ACCENTS: Record<TerminalAccent, string> = {
  claude: '#d77757',
  blue: '#578bd7',
};

// Claude orange is rgb(215,119,87) (hue ~14°), its shimmer variants sit a bit higher. Rotating the hue by a fixed
// amount keeps their saturation/lightness relationships. Yellow (warnings, hue ~45°) and red (errors) stay outside.
const SOURCE_HUE_MIN = 8;
const SOURCE_HUE_MAX = 40;
const MIN_SATURATION = 0.35;
const HUE_SHIFT = 203;

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector] as [number, number, number];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function recolorBlue(r: number, g: number, b: number): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s < MIN_SATURATION || h < SOURCE_HUE_MIN || h > SOURCE_HUE_MAX) return [r, g, b];
  return hslToRgb((h + HUE_SHIFT) % 360, s, l);
}

/** Rewrites the parameters of one SGR sequence (`1;38;2;215;119;87` → `1;38;2;87;143;215`). */
function recolorParams(params: string): string {
  const parts = params.split(';');
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i];
    if (code !== '38' && code !== '48' && code !== '58') continue;
    if (parts[i + 1] === '5') {
      i += 2; // 256-color index, not touched
    } else if (parts[i + 1] === '2' && i + 4 < parts.length) {
      const [r, g, b] = [Number(parts[i + 2]), Number(parts[i + 3]), Number(parts[i + 4])];
      if ([r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
        const [nr, ng, nb] = recolorBlue(r, g, b);
        parts[i + 2] = String(nr);
        parts[i + 3] = String(ng);
        parts[i + 4] = String(nb);
      }
      i += 4;
    }
  }
  return parts.join(';');
}

const SGR = /\x1b\[([0-9;]*)m/g;
// An escape sequence cut off by the end of a websocket frame; held back until the next frame completes it.
const INCOMPLETE_ESCAPE = /\x1b(?:\[[0-9;:]*)?$/;

export interface StreamRecolor {
  write(chunk: string): string;
  /** Drops a held-back partial sequence (call when the terminal is reset and a snapshot starts over). */
  reset(): void;
}

export function createStreamRecolor(accent: TerminalAccent): StreamRecolor {
  if (accent === 'claude') return { write: (chunk) => chunk, reset: () => undefined };
  let carry = '';
  return {
    write(chunk) {
      let text = carry + chunk;
      carry = '';
      const cut = INCOMPLETE_ESCAPE.exec(text);
      if (cut) {
        carry = cut[0];
        text = text.slice(0, cut.index);
      }
      return text.replace(SGR, (_all, params: string) => `\x1b[${recolorParams(params)}m`);
    },
    reset() {
      carry = '';
    },
  };
}
