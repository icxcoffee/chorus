export function splitCommandArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

/**
 * Normalize a free-text arg string the same way the `/chorus <sub>` router
 * path does: tokenize with shell-style quote/escape handling, then rejoin with
 * single spaces. This keeps the direct aliases (`/chorus-ask`, `/chorus-agent`,
 * `/chorus-optimize`) byte-for-byte consistent with their `/chorus ask` /
 * `/chorus agent` / `/chorus optimize` counterparts.
 */
export function joinArgs(input: string): string {
  return splitCommandArgs(input).join(" ");
}

export function parseDurationMs(value: string | undefined): number | undefined | null {
  if (!value) return null;
  if (value === "default") return undefined;
  const match = /^(\d+)(ms|s|m|h)?$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  const unit = match[2] ?? "ms";
  const multiplier = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  const ms = amount * multiplier;
  return ms >= 1_000 && ms <= 21_600_000 ? ms : null;
}
