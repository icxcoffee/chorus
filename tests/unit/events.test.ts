import { describe, expect, it } from "vitest";
import { createMetrics, emitSafely, EventJournal, reduceRunEvent } from "../../src/runtime/events.js";

describe("typed run events", () => {
    it("reduces deterministically and bounds the journal", () => {
        const started = { version: 1 as const, type: "run.started" as const, runId: "r", at: 1, totalVoices: 2 };
        const state = reduceRunEvent({ status: "idle", totalVoices: 0, voiceStatuses: {} }, started);
        expect(state.status).toBe("running");
        const journal = new EventJournal(1);
        journal.append(started);
        journal.append({ version: 1, type: "run.finished", runId: "r", at: 2, status: "success" });
        expect(journal.list()).toHaveLength(1);
    });
    it("isolates sink failures and redacts event errors", async () => {
        const metrics = createMetrics();
        const event = { version: 1 as const, type: "persistence" as const, runId: "r", at: 1, message: "Bearer secret-token" };
        await emitSafely(async (value) => { expect(value).toMatchObject({ message: "Bearer [redacted]" }); throw new Error("sink"); }, event);
        expect(metrics.runs).toBe(0);
    });
});
