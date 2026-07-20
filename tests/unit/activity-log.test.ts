import { describe, expect, it } from "vitest";
import { mergeActivitySnapshots } from "../../src/utils/activity-log.js";

describe("activity log snapshots", () => {
    it("replaces growing snapshots instead of appending duplicate turns", () => {
        const first = "[turn] start\n\n[assistant] {\"findings\":";
        const second = "[turn] start\n\n[assistant] {\"findings\":[]}";
        expect(mergeActivitySnapshots(first, second)).toBe(second);
    });

    it("preserves transition diagnostics while replacing the current attempt snapshot", () => {
        const initial = "[turn] start\n\n[tool done] read source";
        const transition = "[recovery] retrying bounded finalization";
        const firstRecovery = "[turn] start\n\n[assistant] {\"findings\":";
        const finalRecovery = "[turn] start\n\n[assistant] {\"findings\":[]}";
        const withTransition = mergeActivitySnapshots(initial, transition);
        const merged = mergeActivitySnapshots(mergeActivitySnapshots(withTransition, firstRecovery), finalRecovery);
        expect(merged).toContain(initial);
        expect(merged).toContain(transition);
        expect(merged).toContain(finalRecovery);
        expect(merged.match(/\[assistant\]/g)).toHaveLength(1);
    });
});
