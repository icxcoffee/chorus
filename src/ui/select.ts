import type { ModelInfo, ModelRef } from "../types.js";
import { runCustomComponent, type CustomUiLike, type ThemeLike } from "./component.js";
import { matchesUiCancel, matchesUiKeybinding, parseUiKey } from "./keys.js";
import { truncateToWidth } from "./width.js";
import { modelRefToPiArg, sameModelRef } from "../utils/models.js";

export type { CustomUiLike };

interface SelectItem {
  value: string;
  label: string;
  searchText: string;
  selected?: boolean;
  disabled?: boolean;
  tags?: string[];
}

export async function pickVoiceModels(args: {
  ui: CustomUiLike;
  title: string;
  models: ModelInfo[];
  initial: ModelRef[];
}): Promise<ModelRef[] | null> {
  const initial = new Set(args.initial.map(modelRefToPiArg));
  const items = args.models.map((model) => ({
    value: `${model.provider}/${model.modelId}`,
    label: `${model.modelId} [${model.provider}]`,
    searchText: `${model.modelId} ${model.provider} ${model.name ?? ""}`,
    selected: initial.has(`${model.provider}/${model.modelId}`)
  }));
  const picked = await pickMany(args.ui, args.title, items, { min: 2, max: 8 });
  return picked?.map((value) => {
    const slash = value.indexOf("/");
    return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
  }) ?? null;
}

export async function pickConductorModel(args: {
  ui: CustomUiLike;
  title: string;
  models: ModelInfo[];
  voices: ModelRef[];
  initial?: ModelRef;
}): Promise<ModelRef | null> {
  const initial = args.initial ? modelRefToPiArg(args.initial) : "";
  const voiceValues = new Set(args.voices.map(modelRefToPiArg));
  const items = args.models
    .filter((model) => !voiceValues.has(`${model.provider}/${model.modelId}`))
    .map((model) => ({
      value: `${model.provider}/${model.modelId}`,
      label: `${model.modelId} [${model.provider}]`,
      searchText: `${model.modelId} ${model.provider} ${model.name ?? ""}`,
      selected: initial === `${model.provider}/${model.modelId}`,
      tags: initial === `${model.provider}/${model.modelId}` ? ["current"] : []
    }));
  const picked = await pickOne(args.ui, args.title, items);
  if (!picked) return null;
  const slash = picked.indexOf("/");
  return { provider: picked.slice(0, slash), modelId: picked.slice(slash + 1) };
}

async function pickOne(ui: CustomUiLike, title: string, items: SelectItem[]): Promise<string | null> {
  if (!ui.custom || items.length === 0) return null;
  return runCustomComponent<string | null>(ui, ({ theme, keybindings, done, refresh }) => {
    let cursor = 0;
    let query = "";
    const visible = () => filterItems(items, query);
    return {
      render: (width) => renderPicker({ title, items, visible: visible(), cursor, query, theme, width }),
      handleInput(data) {
        const key = parseUiKey(data);
        const shown = visible();
        if (matchesUiCancel(keybindings, data, key)) {
          done(null);
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") {
          if (shown.length) cursor = cursor === 0 ? shown.length - 1 : cursor - 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down") {
          if (shown.length) cursor = cursor === shown.length - 1 ? 0 : cursor + 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.confirm") || key.key === "enter") {
          done(shown[cursor]?.value ?? null);
        } else if (key.key === "backspace") {
          query = query.slice(0, -1);
          cursor = 0;
          refresh();
        } else if (key.key === "text" || key.key === "space") {
          query += key.text ?? "";
          cursor = 0;
          refresh();
        }
      }
    };
  });
}

async function pickMany(
  ui: CustomUiLike,
  title: string,
  items: SelectItem[],
  limits: { min: number; max: number }
): Promise<string[] | null> {
  if (!ui.custom || items.length === 0) return null;
  return runCustomComponent<string[] | null>(ui, ({ theme, keybindings, done, refresh }) => {
    let cursor = 0;
    let query = "";
    const selected = new Set(items.filter((item) => item.selected).map((item) => item.value));
    const visible = () => filterItems(items, query);
    return {
      render: (width) =>
        renderPicker({
          title,
          items,
          visible: visible(),
          cursor,
          query,
          theme,
          width,
          selected,
          hint:
            selected.size < limits.min
              ? `Select at least ${limits.min} models`
              : selected.size > limits.max
                ? `Select at most ${limits.max} models`
                : `${selected.size} selected`
        }),
      handleInput(data) {
        const key = parseUiKey(data);
        const shown = visible();
        if (matchesUiCancel(keybindings, data, key)) {
          done(null);
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") {
          if (shown.length) cursor = cursor === 0 ? shown.length - 1 : cursor - 1;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down") {
          if (shown.length) cursor = cursor === shown.length - 1 ? 0 : cursor + 1;
          refresh();
        } else if (key.key === "space") {
          const value = shown[cursor]?.value;
          if (value) {
            if (selected.has(value)) selected.delete(value);
            else selected.add(value);
          }
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.confirm") || key.key === "enter") {
          if (selected.size >= limits.min && selected.size <= limits.max) done(Array.from(selected));
        } else if (key.key === "backspace") {
          query = query.slice(0, -1);
          cursor = 0;
          refresh();
        } else if (key.key === "text") {
          query += key.text ?? "";
          cursor = 0;
          refresh();
        }
      }
    };
  });
}

function renderPicker(args: {
  title: string;
  items: SelectItem[];
  visible: SelectItem[];
  cursor: number;
  query: string;
  theme: ThemeLike;
  width: number;
  selected?: Set<string>;
  hint?: string;
}): string[] {
  const maxVisible = 12;
  const width = Math.max(20, args.width);
  const color = (name: string, text: string) => args.theme.fg?.(name, text) ?? text;
  const bold = (text: string) => args.theme.bold?.(text) ?? text;
  const lines = [color("accent", "-".repeat(width)), ` ${color("accent", bold(args.title))}`, ` Search: ${args.query || "-"}`];
  if (args.selected) lines.push(` ${args.hint ?? `${args.selected.size} selected`} | ${args.visible.length}/${args.items.length} shown`);
  else lines.push(` ${args.visible.length}/${args.items.length} shown`);
  lines.push("");
  const start = Math.max(0, Math.min(args.cursor - Math.floor(maxVisible / 2), Math.max(0, args.visible.length - maxVisible)));
  const end = Math.min(args.visible.length, start + maxVisible);
  if (args.visible.length === 0) {
    lines.push(color("warning", " No matches."));
  } else {
    for (let i = start; i < end; i++) {
      const item = args.visible[i];
      if (!item) continue;
      const active = i === args.cursor;
      const pointer = active ? color("accent", "> ") : "  ";
      const check = args.selected ? `${args.selected.has(item.value) ? "[x]" : "[ ]"} ` : "";
      const tagText = item.tags?.length ? ` ${item.tags.map((tag) => `[${tag}]`).join(" ")}` : "";
      const baseLabel = `${item.label}${tagText}`;
      const label = active ? color("accent", baseLabel) : item.selected ? color("success", baseLabel) : baseLabel;
      lines.push(`${pointer}${check}${label}`);
    }
  }
  if (args.visible.length > maxVisible) lines.push(` ${start + 1}-${end} of ${args.visible.length}`);
  lines.push("");
  lines.push(
    args.selected
      ? " Type to search - up/down move - space toggle - enter confirm - backspace delete - esc cancel"
      : " Type to search - up/down move - enter confirm - backspace delete - esc cancel"
  );
  lines.push(color("accent", "-".repeat(width)));
  return lines.map((line) => truncateToWidth(line, width));
}

function filterItems(items: SelectItem[], query: string): SelectItem[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return items;
  return items.filter((item) => `${item.label} ${item.searchText}`.toLowerCase().includes(lower));
}
