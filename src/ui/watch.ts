import type { ChorusJob } from "../jobs.js";
import { runCustomComponent, type CustomUiLike } from "./component.js";
import { matchesUiCancel, matchesUiKeybinding, parseUiKey } from "./keys.js";
import { truncateToWidth, wrapToWidth } from "./width.js";
import { clamp, formatElapsed } from "../utils/format.js";

export type WatchUiLike = CustomUiLike;

export async function watchChorusJob(args: {
  ui: WatchUiLike;
  job: ChorusJob;
  initialVoiceIndex?: number;
  subscribe: (listener: (job: ChorusJob) => void) => () => void;
}): Promise<void> {
  if (!args.ui.custom) return;
  await runCustomComponent<void>(args.ui, ({ theme, keybindings, done, refresh }) => {
    let job = args.job;
    let active = clamp(args.initialVoiceIndex ?? 0, 0, Math.max(0, job.voices.length - 1));
    let scroll = 0;
    const unsubscribe = args.subscribe((updated) => {
      job = updated;
      active = clamp(active, 0, Math.max(0, job.voices.length - 1));
      refresh();
    });
    const close = () => {
      unsubscribe();
      done();
    };
    return {
      render(width) {
        const rendered = renderWatch({ job, active, scroll, width, theme });
        scroll = Math.min(scroll, rendered.maxScroll);
        return rendered.lines;
      },
      handleInput(data) {
        const key = parseUiKey(data);
        if (matchesUiCancel(keybindings, data, key) || key.key === "enter") {
          close();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.left") || key.key === "left") {
          active = active === 0 ? Math.max(0, job.voices.length - 1) : active - 1;
          scroll = 0;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.right") || key.key === "right" || key.key === "tab") {
          active = active >= job.voices.length - 1 ? 0 : active + 1;
          scroll = 0;
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") {
          scroll = Math.max(0, scroll - 1);
          refresh();
        } else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down") {
          scroll += 1;
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
  theme?: { fg?: (color: string, text: string) => string; bold?: (text: string) => string };
}): { lines: string[]; maxScroll: number } {
  const width = Math.max(40, args.width);
  const voice = args.job.voices[args.active];
  const content = voice?.activityLog ?? voice?.output ?? voice?.partialOutput ?? voice?.errorMessage ?? "No output yet.";
  const wrapped = wrapToWidth(content, Math.max(20, width - 2));
  const maxBody = 18;
  const maxScroll = Math.max(0, wrapped.length - maxBody);
  const scroll = clamp(args.scroll, 0, maxScroll);
  const body = wrapped.slice(scroll, scroll + maxBody);
  const tabs = args.job.voices
    .map((candidate, index) => {
      const label = `${index}:${candidate.status}`;
      return index === args.active ? `[${label}]` : label;
    })
    .join("  ");
  const elapsed = formatElapsed((args.job.finishedAt ?? Date.now()) - args.job.startedAt);
  const lines = [
    "-".repeat(width),
    ` ${args.job.title}  ${args.job.id}`,
    ` Status: ${args.job.status} | Preset: ${args.job.presetName} | Elapsed: ${elapsed}`,
    ` ${tabs}`,
    "",
    ` ${voice?.label ?? "agent[0]"}`,
    ""
  ];
  if (body.length === 0) lines.push(" No output yet.");
  else lines.push(...body.map((line) => ` ${line}`));
  if (wrapped.length > maxBody) lines.push(` ${scroll + 1}-${Math.min(scroll + maxBody, wrapped.length)} of ${wrapped.length}`);
  if (voice?.activityPath) lines.push(` full activity: ${voice.activityPath}`);
  if (voice?.outputPath) lines.push(` full output: ${voice.outputPath}`);
  lines.push("");
  lines.push(" left/right/tab switch agent - up/down scroll - enter/esc/q close");
  lines.push("-".repeat(width));
  return { lines: lines.map((line) => truncateToWidth(line, width)), maxScroll };
}
