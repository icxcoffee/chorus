import type { ChorusRunEvent } from "../types.js";
import { redactSensitive } from "../utils/redact.js";

export interface RunEventState { runId?: string; status: "idle" | "running" | "success" | "error" | "aborted"; totalVoices: number; voiceStatuses: Record<number, string>; }
export interface RunMetrics { runs: number; successes: number; failures: number; retries: number; totalCostUsd: number; totalDurationMs: number; byProvider: Record<string, { runs: number; failures: number; costUsd: number }>; }
export type RunEventSink = (event: ChorusRunEvent) => void | Promise<void>;

export function reduceRunEvent(state: RunEventState, event: ChorusRunEvent): RunEventState {
    if (event.type === "run.started") return { ...state, runId: event.runId, status: "running", totalVoices: event.totalVoices };
    if (event.type === "voice.transition") return { ...state, voiceStatuses: { ...state.voiceStatuses, [event.voiceIndex]: event.status } };
    if (event.type === "run.finished") return { ...state, status: event.status };
    return state;
}

export function createMetrics(): RunMetrics { return { runs: 0, successes: 0, failures: 0, retries: 0, totalCostUsd: 0, totalDurationMs: 0, byProvider: {} }; }

export function recordMetric(metrics: RunMetrics, event: ChorusRunEvent): void {
    if (event.type === "run.started") metrics.runs += 1;
    if (event.type === "run.finished") event.status === "success" ? metrics.successes += 1 : metrics.failures += 1;
    if (event.type === "retry") metrics.retries += 1;
}

export class EventJournal {
    private readonly events: ChorusRunEvent[] = [];
    constructor(private readonly maxEvents = 2_000) {}
    append(event: ChorusRunEvent): void { this.events.push(sanitizeEvent(event)); if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents); }
    list(): ChorusRunEvent[] { return [...this.events]; }
}

export async function emitSafely(sink: RunEventSink | undefined, event: ChorusRunEvent): Promise<void> {
    if (!sink) return;
    try { await sink(sanitizeEvent(event)); } catch { /* telemetry must not affect a run */ }
}

function sanitizeEvent(event: ChorusRunEvent): ChorusRunEvent {
    if ("message" in event) return { ...event, message: redactSensitive(event.message) };
    return event;
}
