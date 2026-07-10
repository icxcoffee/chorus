export function visibleWidth(text: string): number {
  let width = 0;
  for (const token of tokenizeAnsi(text)) {
    if (token.kind === "ansi") continue;
    width += charWidth(token.value);
  }
  return width;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let width = 0;
  let output = "";
  for (const token of tokenizeAnsi(text)) {
    if (token.kind === "ansi") {
      output += token.value;
      continue;
    }
    const next = charWidth(token.value);
    if (width + next > maxWidth) break;
    output += token.value;
    width += next;
  }
  return output;
}

export function wrapToWidth(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let current = "";
    let currentWidth = 0;
    for (const char of Array.from(raw)) {
      const next = charWidth(char);
      if (currentWidth > 0 && currentWidth + next > width) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      if (next > width) continue;
      current += char;
      currentWidth += next;
    }
    lines.push(current);
  }
  return lines;
}

function tokenizeAnsi(text: string): Array<{ kind: "ansi" | "char"; value: string }> {
  const tokens: Array<{ kind: "ansi" | "char"; value: string }> = [];
  for (let index = 0; index < text.length;) {
    if (text.charCodeAt(index) === 0x1b && text[index + 1] === "[") {
      const match = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(text.slice(index));
      if (match) {
        tokens.push({ kind: "ansi", value: match[0] });
        index += match[0].length;
        continue;
      }
    }
    const code = text.codePointAt(index);
    const value = code === undefined ? text[index] ?? "" : String.fromCodePoint(code);
    tokens.push({ kind: "char", value });
    index += value.length;
  }
  return tokens;
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (isCombining(code)) return 0;
  return isFullWidth(code) ? 2 : 1;
}

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isFullWidth(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}
