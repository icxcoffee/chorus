export type UiKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "tab"
  | "enter"
  | "escape"
  | "backspace"
  | "space"
  | "text"
  | "unknown";

export interface UiKeyEvent {
  key: UiKey;
  text?: string;
}

export function matchesUiKeybinding(keybindings: unknown, input: unknown, action: string): boolean {
  if (!keybindings || typeof keybindings !== "object") return false;
  const matches = (keybindings as { matches?: unknown }).matches;
  if (typeof matches !== "function") return false;
  try {
    return matches.call(keybindings, input, action) === true;
  } catch {
    return false;
  }
}

export function matchesUiCancel(keybindings: unknown, input: unknown, key: UiKeyEvent): boolean {
  return (
    key.key === "escape" ||
    matchesUiKeybinding(keybindings, input, "tui.select.cancel") ||
    matchesUiKeybinding(keybindings, input, "app.interrupt")
  );
}

export function parseUiKey(input: unknown): UiKeyEvent {
  const normalized = normalizeInput(input);
  if (normalized == null) return { key: "unknown" };
  const pasted = parseBracketedPaste(normalized);
  if (pasted !== null) return { key: "text", text: pasted };
  if (normalized.length === 1) return parseSingleChar(normalized);
  const sequenceKey = parseTerminalSequence(normalized);
  if (sequenceKey) return sequenceKey;

  const lower = normalized.toLowerCase();
  switch (lower) {
    case "\u001b[a":
    case "\u001boa":
    case "up":
    case "arrowup":
      return { key: "up" };
    case "\u001b[b":
    case "\u001bob":
    case "down":
    case "arrowdown":
      return { key: "down" };
    case "\u001b[d":
    case "\u001bod":
    case "left":
    case "arrowleft":
      return { key: "left" };
    case "\u001b[c":
    case "\u001boc":
    case "right":
    case "arrowright":
      return { key: "right" };
    case "home":
      return { key: "home" };
    case "end":
      return { key: "end" };
    case "pageup":
    case "page up":
    case "pgup":
      return { key: "pageup" };
    case "pagedown":
    case "page down":
    case "pgdown":
    case "pgdn":
      return { key: "pagedown" };
    case "tab":
      return { key: "tab" };
    case "return":
    case "enter":
      return { key: "enter" };
    case "esc":
    case "escape":
    case "ctrl+c":
    case "ctrl-c":
    case "c-c":
      return { key: "escape" };
    case "backspace":
    case "delete":
    case "del":
      return { key: "backspace" };
    case "space":
      return { key: "space", text: " " };
    default:
      return isTextInput(normalized) ? { key: "text", text: normalizeTextInput(normalized) } : { key: "unknown" };
  }
}

function parseBracketedPaste(value: string): string | null {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  if (!value.startsWith(start) || !value.endsWith(end)) return null;
  return normalizeTextInput(value.slice(start.length, -end.length));
}

function parseTerminalSequence(value: string): UiKeyEvent | null {
  const kitty = /^\u001b\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/.exec(value);
  if (kitty) {
    const codepoint = Number(kitty[1]);
    const modifier = kitty[2] ? Number(kitty[2]) - 1 : 0;
    if (codepoint === 27 && modifier === 0) return { key: "escape" };
    if (codepoint === 9 && modifier === 0) return { key: "tab" };
    if ((codepoint === 13 || codepoint === 57414) && modifier === 0) return { key: "enter" };
    if (codepoint === 32 && modifier === 0) return { key: "space", text: " " };
    if (codepoint === 127 && modifier === 0) return { key: "backspace" };
    if (codepoint === 57421 && modifier === 0) return { key: "pageup" };
    if (codepoint === 57422 && modifier === 0) return { key: "pagedown" };
    if (codepoint === 57423 && modifier === 0) return { key: "home" };
    if (codepoint === 57424 && modifier === 0) return { key: "end" };
  }

  if (["\u001b[H", "\u001bOH", "\u001b[1~", "\u001b[7~"].includes(value)) return { key: "home" };
  if (["\u001b[F", "\u001bOF", "\u001b[4~", "\u001b[8~"].includes(value)) return { key: "end" };
  if (["\u001b[5~", "\u001b[[5~"].includes(value)) return { key: "pageup" };
  if (["\u001b[6~", "\u001b[[6~"].includes(value)) return { key: "pagedown" };

  const modifyOtherKeys = /^\u001b\[27;(\d+);(\d+)~$/.exec(value);
  if (modifyOtherKeys) {
    const modifier = Number(modifyOtherKeys[1]) - 1;
    const codepoint = Number(modifyOtherKeys[2]);
    if (codepoint === 27 && modifier === 0) return { key: "escape" };
  }

  return null;
}

function parseSingleChar(value: string): UiKeyEvent {
  switch (value) {
    case "\u0003":
    case "\u001b":
      return { key: "escape" };
    case "\r":
    case "\n":
      return { key: "enter" };
    case "\t":
      return { key: "tab" };
    case "\u007f":
    case "\b":
      return { key: "backspace" };
    case " ":
      return { key: "space", text: " " };
    default:
      return isPrintableText(value) ? { key: "text", text: value } : { key: "unknown" };
  }
}

function normalizeInput(input: unknown): string | null {
  if (typeof input === "string") return input;
  if (input instanceof Uint8Array) return Buffer.from(input).toString("utf8");
  if (!input || typeof input !== "object") return null;

  const record = input as Record<string, unknown>;
  const eventName = typeof record.name === "string" ? record.name.toLowerCase() : "";
  const eventType = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (eventName === "paste" || eventType === "paste") {
    for (const key of ["paste", "text", "data", "value", "input", "raw", "sequence"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }

  const ctrl = record.ctrl === true || record.control === true;
  const name = typeof record.name === "string" ? record.name : "";
  if (ctrl && name) return `ctrl+${name}`;

  for (const key of ["name", "key", "sequence", "input", "raw", "code"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  const nestedKey = record.key;
  if (nestedKey && typeof nestedKey === "object") return normalizeInput(nestedKey);

  return null;
}

function isPrintableText(value: string): boolean {
  return !/[^\S ]/.test(value) && !value.includes("\u001b") && value >= " ";
}

function isTextInput(value: string): boolean {
  return !value.includes("\u001b") && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function normalizeTextInput(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}
