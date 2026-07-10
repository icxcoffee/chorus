import type { TokenUsage } from "../types.js";

export interface ParsedSubagentOutput {
  output: string;
  activityLog?: string;
  usage?: TokenUsage;
  costUsd: number | null;
  malformedLines: string[];
}

export interface SubagentParseState {
  messageTexts: string[];
  textDeltas: string[];
  activityBlocks: ActivityBlock[];
  blockIndexes: Map<string, number>;
  thinkingLengths: Map<number, number>;
  malformedLines: string[];
  usage?: TokenUsage;
  costUsd: number | null;
}

interface ActivityBlock {
  key: string;
  label: string;
  content: string;
}

export function parseSubagentNdjson(text: string): ParsedSubagentOutput {
  const state = createParseState();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    applySubagentLine(state, line);
  }
  const output = outputFromState(state).trim();
  const activityLog = activityLogFromState(state);
  return {
    output,
    ...(activityLog ? { activityLog } : {}),
    costUsd: state.costUsd,
    malformedLines: state.malformedLines,
    ...(state.usage ? { usage: state.usage } : {})
  };
}

export function createParseState(): SubagentParseState {
  return {
    messageTexts: [],
    textDeltas: [],
    activityBlocks: [],
    blockIndexes: new Map(),
    thinkingLengths: new Map(),
    malformedLines: [],
    costUsd: null
  };
}

export function applySubagentLine(state: SubagentParseState, line: string): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    state.malformedLines.push(line);
    return;
  }
  const type = String(event.type ?? event.event ?? "");
  applyActivityEvent(state, event, type);
  if (type === "message_end" || type === "message") {
    const content = extractMessageText(event);
    if (content) state.messageTexts.push(content);
  }
  if (type === "message_update") {
    const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (update) {
      const updateType = String(update.type ?? "");
      if (updateType === "text_delta" && typeof update.delta === "string") {
        state.textDeltas.push(update.delta);
      } else if (updateType === "text_end" && typeof update.content === "string") {
        state.textDeltas.length = 0;
        state.textDeltas.push(update.content);
      }
    }
  }
  const maybeUsage = extractUsage(event);
  if (maybeUsage) {
    state.usage = {
      input: numberField(maybeUsage, ["input", "input_tokens"]),
      output: numberField(maybeUsage, ["output", "output_tokens"]),
      cacheRead: numberField(maybeUsage, ["cacheRead", "cache_read"]),
      cacheWrite: numberField(maybeUsage, ["cacheWrite", "cache_write"])
    };
    const cost = maybeUsage.cost as { total?: unknown } | undefined;
    if (typeof cost?.total === "number") state.costUsd = cost.total;
  }
}

export function outputFromState(state: SubagentParseState): string {
  return state.messageTexts.at(-1) ?? state.textDeltas.join("");
}

function applyActivityEvent(state: SubagentParseState, event: Record<string, unknown>, type: string): void {
  if (type === "turn_start") {
    appendActivity(state, `turn:${String(event.turnIndex ?? state.activityBlocks.length)}:start`, "[turn]", `start ${String(event.turnIndex ?? "")}`.trim());
    return;
  }
  if (type === "turn_end") {
    appendActivity(state, `turn:${String(event.turnIndex ?? state.activityBlocks.length)}:end`, "[turn]", `end ${String(event.turnIndex ?? "")}`.trim());
    return;
  }
  if (type === "tool_execution_start") {
    const name = String(event.toolName ?? "tool");
    appendActivity(state, `tool-exec:${String(event.toolCallId ?? state.activityBlocks.length)}:start`, "[tool start]", `${name} ${formatUnknown(event.args)}`.trim());
    return;
  }
  if (type === "tool_execution_update") {
    const name = String(event.toolName ?? "tool");
    appendActivity(state, `tool-exec:${String(event.toolCallId ?? state.activityBlocks.length)}:update`, "[tool update]", `${name} ${formatUnknown(event.partialResult)}`.trim());
    return;
  }
  if (type === "tool_execution_end") {
    const name = String(event.toolName ?? "tool");
    const isError = event.isError === true ? " error" : "";
    appendActivity(state, `tool-exec:${String(event.toolCallId ?? state.activityBlocks.length)}:end`, "[tool done]", `${name}${isError} ${formatUnknown(event.result)}`.trim());
    return;
  }
  if (type === "tool_call") {
    const name = String(event.toolName ?? "tool");
    appendActivity(state, `tool-call:${String(event.toolCallId ?? state.activityBlocks.length)}`, "[tool call]", `${name} ${formatUnknown(event.input)}`.trim());
    return;
  }
  if (type === "tool_result") {
    const name = String(event.toolName ?? "tool");
    const isError = event.isError === true ? " error" : "";
    appendActivity(state, `tool-result:${String(event.toolCallId ?? state.activityBlocks.length)}`, "[tool result]", `${name}${isError} ${extractContentText(event.content) || formatUnknown(event.details)}`.trim());
    return;
  }
  if (type !== "message_update") return;
  const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!update) return;
  applyAssistantActivityEvent(state, update);
}

function applyAssistantActivityEvent(state: SubagentParseState, update: Record<string, unknown>): void {
  const updateType = String(update.type ?? "");
  const contentIndex = typeof update.contentIndex === "number" ? update.contentIndex : 0;
  if (updateType === "text_start") {
    getActivityBlock(state, `text:${contentIndex}`, "[assistant]");
  } else if (updateType === "text_delta") {
    const block = getActivityBlock(state, `text:${contentIndex}`, "[assistant]");
    if (typeof update.delta === "string") block.content += update.delta;
  } else if (updateType === "text_end") {
    const block = getActivityBlock(state, `text:${contentIndex}`, "[assistant]");
    if (typeof update.content === "string") block.content = update.content;
  } else if (updateType === "thinking_start") {
    state.thinkingLengths.set(contentIndex, 0);
    getActivityBlock(state, `thinking:${contentIndex}`, "[thinking]").content = "started";
  } else if (updateType === "thinking_delta") {
    const length = (state.thinkingLengths.get(contentIndex) ?? 0) + (typeof update.delta === "string" ? update.delta.length : 0);
    state.thinkingLengths.set(contentIndex, length);
    getActivityBlock(state, `thinking:${contentIndex}`, "[thinking]").content = `receiving hidden reasoning (${length} chars)`;
  } else if (updateType === "thinking_end") {
    const length = typeof update.content === "string" ? update.content.length : (state.thinkingLengths.get(contentIndex) ?? 0);
    getActivityBlock(state, `thinking:${contentIndex}`, "[thinking]").content = `hidden reasoning complete (${length} chars)`;
  } else if (updateType === "toolcall_start") {
    getActivityBlock(state, `toolcall:${contentIndex}`, "[tool call]").content = "started";
  } else if (updateType === "toolcall_delta") {
    const partialTool = extractPartialTool(update, contentIndex);
    getActivityBlock(state, `toolcall:${contentIndex}`, "[tool call]").content = `streaming ${partialTool}`.trim();
  } else if (updateType === "toolcall_end") {
    const toolCall = update.toolCall as Record<string, unknown> | undefined;
    const name = String(toolCall?.name ?? "tool");
    getActivityBlock(state, `toolcall:${contentIndex}`, "[tool call]").content = `${name} ${formatUnknown(toolCall?.arguments)}`.trim();
  } else if (updateType === "done") {
    appendActivity(state, `done:${state.activityBlocks.length}`, "[done]", String(update.reason ?? "complete"));
  } else if (updateType === "error") {
    appendActivity(state, `error:${state.activityBlocks.length}`, "[error]", String(update.reason ?? "error"));
  }
}

function getActivityBlock(state: SubagentParseState, key: string, label: string): ActivityBlock {
  const existing = state.blockIndexes.get(key);
  if (existing !== undefined) return state.activityBlocks[existing]!;
  const block = { key, label, content: "" };
  state.blockIndexes.set(key, state.activityBlocks.length);
  state.activityBlocks.push(block);
  trimActivityBlocks(state);
  return block;
}

function appendActivity(state: SubagentParseState, key: string, label: string, content: string): void {
  const block = getActivityBlock(state, key, label);
  block.content = content;
}

export function activityLogFromState(state: SubagentParseState): string {
  return state.activityBlocks
    .map((block) => `${block.label} ${block.content}`.trim())
    .filter(Boolean)
    .join("\n\n");
}

function trimActivityBlocks(state: SubagentParseState): void {
  const maxBlocks = 120;
  if (state.activityBlocks.length <= maxBlocks) return;
  const removeCount = state.activityBlocks.length - maxBlocks;
  state.activityBlocks.splice(0, removeCount);
  state.blockIndexes.clear();
  state.activityBlocks.forEach((block, index) => state.blockIndexes.set(block.key, index));
}

function extractPartialTool(update: Record<string, unknown>, contentIndex: number): string {
  const partial = update.partial as { content?: unknown } | undefined;
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const block = content[contentIndex] as Record<string, unknown> | undefined;
  if (!block) return "";
  const name = typeof block.name === "string" ? block.name : "tool";
  return `${name} ${formatUnknown(block.arguments)}`.trim();
}

function extractMessageText(event: Record<string, unknown>): string {
  const message = event.message as { role?: unknown; content?: unknown } | string | undefined;
  if (typeof message === "string") return message;
  if (message?.role && message.role !== "assistant") return "";
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return extractContentArrayText(message.content);
  const data = event.data as { message?: unknown; content?: unknown; text?: unknown } | undefined;
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.content === "string") return data.content;
  if (Array.isArray(data?.content)) return extractContentArrayText(data.content);
  if (typeof data?.message === "string") return data.message;
  return "";
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return extractContentArrayText(content);
}

function extractContentArrayText(content: unknown[]): string {
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean)
    .join("");
}

function formatUnknown(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return limitText(value.replace(/\s+/g, " ").trim(), 600);
  try {
    return limitText(JSON.stringify(value), 1000);
  } catch {
    return limitText(String(value), 600);
  }
}

function limitText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function extractUsage(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = event.data as { usage?: unknown } | undefined;
  const message = event.message as { usage?: unknown } | undefined;
  const update = event.assistantMessageEvent as { partial?: unknown } | undefined;
  const partial = update?.partial as { usage?: unknown } | undefined;
  const usage = event.usage ?? data?.usage ?? message?.usage ?? partial?.usage;
  return usage && typeof usage === "object" ? (usage as Record<string, unknown>) : undefined;
}

function numberField(source: Record<string, unknown>, names: string[]): number {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}
