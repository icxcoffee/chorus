import type { ChorusJob } from "../jobs.js";
import { runCustomComponent, type CustomUiLike, type ThemeLike } from "./component.js";
import { matchesUiCancel, matchesUiKeybinding, parseUiKey } from "./keys.js";
import { truncateToWidth, wrapToWidth } from "./width.js";
import { clamp, formatElapsed } from "../utils/format.js";

export type WatchUiLike = CustomUiLike;

const WATCH_BODY_LINES = 18;

export async function watchChorusJob(args: {
  ui: WatchUiLike;
  job: ChorusJob;
  initialVoiceIndex?: number;
  subscribe: (listener: (job: ChorusJob) => void) => () => void;
}): Promise<void> {
  if (!args.ui.custom) return;
  await runCustomComponent<void>(args.ui, ({ theme, keybindings, done, refresh }) => {
    let job = args.job;
    let active = clamp(args.initialVoiceIndex ?? 0, 0, Math.max(0, job.voices.length));
    let scroll = 0;
    let maxScroll = 0;
    const unsubscribe = args.subscribe((updated) => {
      job = updated;
      active = clamp(active, 0, Math.max(0, job.voices.length));
      refresh();
    });
    const close = () => {
      unsubscribe();
      done();
    };
    return {
      render(width) {
        const rendered = renderWatch({ job, active, scroll, width, theme });
        maxScroll = rendered.maxScroll;
        scroll = Math.min(scroll, maxScroll);
        return rendered.lines;
      },
      handleInput(data) {
        const key = parseUiKey(data);
        if (matchesUiCancel(keybindings, data, key) || key.key === "enter") {
          close();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.left") || key.key === "left") {
          active = active === 0 ? Math.max(0, job.voices.length) : active - 1;
          scroll = 0;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.right") || key.key === "right" || key.key === "tab") {
          active = active >= job.voices.length ? 0 : active + 1;
          scroll = 0;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") {
          scroll = Math.max(0, scroll - 1);
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down") {
          scroll += 1;
          refresh();
        } else if (key.key === "pageup") {
          scroll = Math.max(0, scroll - WATCH_BODY_LINES);
          refresh();
        } else if (key.key === "pagedown") {
          scroll = Math.min(maxScroll, scroll + WATCH_BODY_LINES);
          refresh();
        } else if (key.key === "home" || (key.key === "text" && key.text === "g")) {
          scroll = 0;
          refresh();
        } else if (key.key === "end" || (key.key === "text" && key.text === "G")) {
          scroll = maxScroll;
          refresh();
        } else if (key.key === "text" && (key.text === "q" || key.text === "Q")) {
          close();
        }
      },
      invalidate() {
        unsubscribe();
      }
    };
  });
}

export function renderWatch(args: {
  job: ChorusJob;
  active: number;
  scroll: number;
  width: number;
  theme?: ThemeLike;
}): { lines: string[]; maxScroll: number } {
  const width = Math.max(40, args.width);
  const voice = args.job.voices[args.active];
  const conductorActive = args.active === args.job.voices.length;
  const conductor = args.job.conductor;
  const errorMessage = conductorActive
    ? conductor?.errorMessage ?? args.job.errorMessage
    : voice?.errorMessage ?? (args.job.status === "error" ? args.job.errorMessage : undefined);
  const content = conductorActive
    ? conductor?.activityLog ?? conductor?.partialOutput ?? "No conductor output yet."
    : voice?.activityLog ?? voice?.output ?? voice?.partialOutput ?? (voice?.status === "skipped" ? "Review stage skipped." : "No output yet.");
  const contentLabel = conductorActive
    ? conductor?.activityLog ? "Activity" : "Review report"
    : voice?.activityLog ? "Activity" : "Output";
  const wrapped = wrapToWidth(content, Math.max(20, width - 2));
  const maxBody = WATCH_BODY_LINES;
  const maxScroll = Math.max(0, wrapped.length - maxBody);
  const scroll = clamp(args.scroll, 0, maxScroll);
  const body = wrapped.slice(scroll, scroll + maxBody);
  const tabItems = [...args.job.voices
    .map((candidate, index) => {
      const label = `${index}:${candidate.status}`;
      return { text: index === args.active ? `[${label}]` : label, status: candidate.status, active: index === args.active };
    }), {
      text: `${conductorActive ? "[conductor" : "conductor"}:${conductor?.status ?? "pending"}${conductorActive ? "]" : ""}`,
      status: conductor?.status ?? "pending",
      active: conductorActive
    }];
  const tabs = tabItems.map((item) => styleStatus(item.status, item.text, args.theme, item.active)).join("  ");
  const elapsed = formatElapsed((args.job.finishedAt ?? Date.now()) - args.job.startedAt);
  const position = wrapped.length === 0 ? 0 : Math.round((scroll / Math.max(1, maxScroll)) * 100);
  const viewport = wrapped.length > maxBody
    ? `${contentLabel} · lines ${scroll + 1}-${Math.min(scroll + maxBody, wrapped.length)} / ${wrapped.length} · ${position}%`
    : `${contentLabel} · ${wrapped.length} line${wrapped.length === 1 ? "" : "s"}`;
  const lines = [
    color(args.theme, "accent", "-".repeat(width)),
    ` ${bold(args.theme, args.job.title)}  ${color(args.theme, "muted", args.job.id)}`,
    ` ${color(args.theme, "muted", "Status:")} ${styleStatus(args.job.status, args.job.status, args.theme)} ${color(args.theme, "muted", `| Preset: ${args.job.presetName} | Elapsed: ${elapsed}`)}`,
    ...(args.job.reviewStage ? [` ${color(args.theme, "muted", "Stage:")} ${bold(args.theme, args.job.reviewStage.id)} ${styleStatus(args.job.reviewStage.status, `(${args.job.reviewStage.status})`, args.theme)}`] : []),
    ` ${tabs}`,
    ...(errorMessage ? ["", ...renderErrorSummary(errorMessage, width, args.theme)] : []),
    "",
    ` ${bold(args.theme, conductorActive ? (args.job.kind === "review" ? "review report" : "conductor") : voice?.label ?? "agent[0]")}`,
    ` ${color(args.theme, "accent", viewport)}`,
    ""
  ];
  if (body.length === 0) lines.push(" No output yet.");
  else lines.push(...body.map((line) => ` ${styleActivityLine(line, args.theme)}`));
  if (!conductorActive && voice?.activityPath) lines.push(` ${color(args.theme, "muted", `full activity: ${voice.activityPath}`)}`);
  if (!conductorActive && voice?.outputPath) lines.push(` ${color(args.theme, "muted", `full output: ${voice.outputPath}`)}`);
  lines.push("");
  lines.push(` ${color(args.theme, "muted", "tab/left/right role | up/down line | pgup/pgdn page")}`);
  lines.push(` ${color(args.theme, "muted", "home/end or g/G jump | enter/esc/q close")}`);
  lines.push(color(args.theme, "accent", "-".repeat(width)));
  return { lines: lines.map((line) => truncateToWidth(line, width)), maxScroll };
}

function renderErrorSummary(message: string, width: number, theme?: ThemeLike): string[] {
  const wrapped = wrapToWidth(message, Math.max(20, width - 9));
  const maximumLines = 5;
  const visible = wrapped.length <= maximumLines
    ? wrapped
    : [...wrapped.slice(0, maximumLines - 2), "...", wrapped.at(-1)!];
  return visible.map((line, index) => color(theme, "error", ` ${index === 0 ? "Error: " : "       "}${line}`));
}

function styleActivityLine(line: string, theme?: ThemeLike): string {
  const match = /^\[([^\]]+)\]/.exec(line);
  if (!match) return line;
  const label = match[0];
  const token = match[1] === "tool done"
    ? "success"
    : match[1] === "assistant"
      ? "accent"
      : match[1] === "tool call" || match[1] === "tool start"
        ? "warning"
        : match[1] === "error" || match[1] === "tool error"
          ? "error"
          : match[1] === "thinking" || match[1] === "turn"
            ? "muted"
            : undefined;
  if (token) return `${color(theme, token, label)}${line.slice(label.length)}`;
  return line;
}

function styleStatus(status: string, text: string, theme?: ThemeLike, active = false): string {
  const token = status === "success"
    ? "success"
    : status === "running"
      ? "accent"
      : status === "error"
        ? "error"
        : status === "degraded" || status === "aborted" || status === "stale" || status === "empty"
          ? "warning"
          : "muted";
  const styled = color(theme, token, text);
  return active ? bold(theme, styled) : styled;
}

function color(theme: ThemeLike | undefined, name: string, text: string): string {
  return theme?.fg?.(name, text) ?? text;
}

function bold(theme: ThemeLike | undefined, text: string): string {
  return theme?.bold?.(text) ?? text;
}
