import type { ModelInfo, ModelRef, RegistryLike } from "../types.js";
import type { OptimizeResult } from "../optimize.js";
import { runCustomComponent, type CustomUiLike } from "./component.js";
import { matchesUiCancel, matchesUiKeybinding, parseUiKey } from "./keys.js";
import { runOptimizeUi } from "./optimize.js";
import { truncateToWidth, wrapToWidth } from "./width.js";
import { clamp } from "../utils/format.js";

export interface PromptComposerUiLike extends CustomUiLike {
  setStatus?: (key: string, message?: string) => void;
  setWorkingMessage?: (message?: string) => void;
  setWorkingVisible?: (visible: boolean) => void;
  input?: (prompt: string) => Promise<string>;
}

export interface ComposePromptResult {
  original: string;
  prompt: string;
  optimizedPrompt?: string;
}

type ComposerAction = "submit" | "config" | "optimize" | "cancel";

export async function composePrompt(args: {
  ui: PromptComposerUiLike;
  title: string;
  placeholder: string;
  registry: ModelInfo[];
  signal: AbortSignal;
  model?: ModelRef;
  modelRegistry?: RegistryLike;
  fetchImpl?: typeof fetch;
  onOptimized?: (result: OptimizeResult) => void;
  onConfigure?: () => Promise<void>;
}): Promise<ComposePromptResult | null> {
  let current = "";
  let original = "";
  let optimizedPrompt: string | undefined;
  while (true) {
    const picked = await promptComposer(args.ui, {
      title: args.title,
      placeholder: args.placeholder,
      value: current,
      optimized: optimizedPrompt !== undefined,
      canConfigure: Boolean(args.onConfigure)
    });
    if (!picked) return null;
    current = picked.value.trim();
    if (picked.action === "config") {
      await args.onConfigure?.();
      continue;
    }
    if (!current) continue;
    if (!original) original = current;
    if (picked.action === "submit") {
      const result: ComposePromptResult = { original, prompt: current };
      if (optimizedPrompt !== undefined && current !== original) result.optimizedPrompt = current;
      return result;
    }
    args.ui.setStatus?.("chorus", "optimizing prompt");
    args.ui.setWorkingMessage?.("Optimizing prompt...");
    args.ui.setWorkingVisible?.(true);
    const optimized = await runOptimizeUi({
      prompt: current,
      registry: args.registry,
      ...(args.model ? { model: args.model } : {}),
      ...(args.modelRegistry ? { modelRegistry: args.modelRegistry } : {}),
      signal: args.signal,
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      emit: (message) => args.ui.setStatus?.("chorus", message)
    }).finally(() => {
      args.ui.setWorkingMessage?.();
      args.ui.setWorkingVisible?.(false);
    });
    args.onOptimized?.(optimized);
    current = optimized.optimized.trim() || current;
    optimizedPrompt = current;
    args.ui.setStatus?.("chorus", optimized.errorMessage ? "optimize unavailable" : "prompt optimized");
  }
}

async function promptComposer(
  ui: PromptComposerUiLike,
  args: { title: string; placeholder: string; value: string; optimized: boolean; canConfigure: boolean }
): Promise<{ action: ComposerAction; value: string } | null> {
  if (!ui.custom) {
    const value = args.value || (await ui.input?.(args.placeholder)) || "";
    return value ? { action: "submit", value } : null;
  }
  return runCustomComponent<{ action: ComposerAction; value: string } | null>(ui, ({ theme, keybindings, done, refresh }) => {
    let value = args.value;
    let actionIndex = 0;
    let scroll = 0;
    const actions: Array<{ action: ComposerAction; label: string }> = [
      { action: "submit", label: "Submit" },
      ...(args.canConfigure ? [{ action: "config" as const, label: "Config" }] : []),
      { action: "optimize", label: args.optimized ? "Optimize again" : "Optimize" },
      { action: "cancel", label: "Cancel" }
    ];
    return {
      render(width) {
        const rendered = renderComposer({ ...args, value, actionIndex, actions, width, theme, scroll });
        scroll = rendered.scroll;
        return rendered.lines;
      },
      handleInput(data) {
        const key = parseUiKey(data);
        if (matchesUiCancel(keybindings, data, key)) {
          done(null);
        } else if (matchesUiKeybinding(keybindings, data, "tui.editor.cursorLeft") || key.key === "left") {
          actionIndex = actionIndex === 0 ? actions.length - 1 : actionIndex - 1;
          refresh();
        } else if (
          matchesUiKeybinding(keybindings, data, "tui.editor.cursorRight") ||
          matchesUiKeybinding(keybindings, data, "tui.input.tab") ||
          key.key === "right" ||
          key.key === "tab"
        ) {
          actionIndex = actionIndex === actions.length - 1 ? 0 : actionIndex + 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") {
          scroll = Math.max(0, scroll - 1);
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down") {
          scroll += 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.confirm") || key.key === "enter") {
          const action = actions[actionIndex]?.action ?? "submit";
          done(action === "cancel" ? null : { action, value });
        } else if (key.key === "backspace") {
          value = value.slice(0, -1);
          scroll = Number.MAX_SAFE_INTEGER;
          refresh();
        } else if (key.key === "text" || key.key === "space") {
          value += key.text ?? "";
          scroll = Number.MAX_SAFE_INTEGER;
          refresh();
        }
      }
    };
  });
}

function renderComposer(args: {
  title: string;
  placeholder: string;
  value: string;
  optimized: boolean;
  actionIndex: number;
  actions: Array<{ action: ComposerAction; label: string }>;
  width: number;
  theme: { fg?: (color: string, text: string) => string; bold?: (text: string) => string };
  scroll: number;
}): { lines: string[]; scroll: number; maxScroll: number } {
  const width = Math.max(30, args.width);
  const color = (name: string, text: string) => args.theme.fg?.(name, text) ?? text;
  const bold = (text: string) => args.theme.bold?.(text) ?? text;
  const value = args.value || color("muted", args.placeholder);
  const status = args.optimized ? color("success", "optimized") : color("muted", "draft");
  const maxBody = 10;
  const wrapped = wrapToWidth(value, width - 2);
  const maxScroll = Math.max(0, wrapped.length - maxBody);
  const scroll = clamp(args.scroll, 0, maxScroll);
  const body = wrapped.slice(scroll, scroll + maxBody);
  const actions = args.actions
    .map((item, index) => {
      const label = index === args.actionIndex ? `[${item.label}]` : ` ${item.label} `;
      return index === args.actionIndex ? color("accent", label) : label;
    })
    .join("  ");
  const lines = [
    color("accent", "-".repeat(width)),
    ` ${color("accent", bold(args.title))} ${status}`,
    "",
    ...body.map((line) => ` ${line || " "}`),
    ...(wrapped.length > maxBody ? [` ${scroll + 1}-${Math.min(scroll + maxBody, wrapped.length)} of ${wrapped.length}`] : []),
    "",
    ` ${actions}`,
    "",
    " Type/paste prompt - up/down scroll - left/right/tab action - enter confirm - backspace delete - esc cancel",
    color("accent", "-".repeat(width))
  ];
  return { lines: lines.map((line) => truncateToWidth(line, width)), scroll, maxScroll };
}
