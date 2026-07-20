import { describe, expect, it } from "vitest";
import { ThrottledTextStream } from "../../src/runtime/streaming.js";

describe("streaming", () => {
    it("reconciles buffered deltas into a final marker", () => {
        const events: unknown[] = [];
        const stream = new ThrottledTextStream((event) => events.push(event), 0);
        stream.push("hel");
        stream.push("lo");
        stream.flush(true);
        expect(events).toEqual([{ text: "hel" }, { text: "lo" }, { text: "", done: true }]);
    });

    it("flushes large synchronous input in bounded Unicode-safe chunks", () => {
        const events: Array<{ text: string; done?: boolean }> = [];
        const stream = new ThrottledTextStream((event) => events.push(event), Number.MAX_SAFE_INTEGER, 4);
        stream.push("ab\u{1F680}cdef");
        stream.flush(true);

        expect(events).toEqual([
            { text: "ab\u{1F680}" },
            { text: "cdef" },
            { text: "", done: true },
        ]);
        expect(events.every((event) => !event.text.includes("\uFFFD"))).toBe(true);
    });

    it("flushes a synchronous burst when the buffer reaches its size limit", () => {
        const events: Array<{ text: string; done?: boolean }> = [];
        const stream = new ThrottledTextStream((event) => events.push(event), Number.MAX_SAFE_INTEGER, 5);
        stream.push("ab");
        stream.push("cde");
        stream.push("f");
        stream.flush(true);
        expect(events).toEqual([{ text: "abcde" }, { text: "f", done: true }]);
    });

    it("falls back to the default buffer limit for non-finite configuration", () => {
        const events: Array<{ text: string; done?: boolean }> = [];
        const stream = new ThrottledTextStream((event) => events.push(event), Number.MAX_SAFE_INTEGER, Number.NaN);
        stream.push("safe");
        stream.flush(true);
        expect(events).toEqual([{ text: "safe", done: true }]);
    });
});
