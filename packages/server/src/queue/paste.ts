export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';
export const ENTER = '\r';

/**
 * Wraps text in a bracketed paste. Line endings are normalised to \n and any embedded paste markers
 * (or other ESC bytes) are removed so a message cannot terminate the paste early or inject keystrokes.
 */
export function toBracketedPaste(text: string): string {
  const clean = text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b/g, '');
  return `${PASTE_START}${clean}${PASTE_END}`;
}
