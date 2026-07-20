import { describe, expect, it } from "vitest";
import { BoundedByteTail } from "../../src/subagent/bounded-byte-tail.js";

describe("bounded byte tail", () => {
    it("preserves only the newest bytes across wrapped and oversized writes", () => {
        const tail = new BoundedByteTail(8);
        tail.append("abcd");
        tail.append("efghij");
        expect(tail.toBuffer().toString()).toBe("cdefghij");
        expect(tail.omittedBytes()).toBe(2);
        tail.append("0123456789");
        expect(tail.toBuffer().toString()).toBe("23456789");
        expect(tail.omittedBytes()).toBe(12);
    });
});
