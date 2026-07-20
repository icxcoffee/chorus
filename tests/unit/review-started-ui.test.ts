import { describe, expect, it, vi } from "vitest";
import { showReviewStarted } from "../../src/runtime/pi-ui.js";

describe("Review started UI", () => {
    it("pins complete Review task details in interactive Pi", () => {
        const sendMessage = vi.fn();
        showReviewStarted({ hasUI: true, sendMessage }, {
            jobId: "chorus-1",
            presetName: "default",
            request: { version: 1, workflow: "architecture-review", objective: ["Review boundaries"], constraints: ["Preserve API"], scope: { kind: "repository", root: "/repo" }, profile: "quick", renderer: "markdown" },
            assignments: [
                { roleId: "architect", model: { provider: "p", modelId: "architect-model" } },
                { roleId: "reliability", model: { provider: "p", modelId: "reliability-model" } },
                { roleId: "security", model: { provider: "q", modelId: "security-model" } },
            ],
            outputDir: "/tmp/results/chorus-1",
        });
        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
            customType: "chorus-review-started",
            content: expect.stringContaining("Review boundaries"),
            details: expect.objectContaining({ kind: "review-started", jobId: "chorus-1" }),
        }));
        expect(sendMessage.mock.calls[0]?.[0].content).toContain("architecture-review");
        expect(sendMessage.mock.calls[0]?.[0].content).toContain("architect-model");
        expect(sendMessage.mock.calls[0]?.[0].content).toContain("## Expert Reviewers");
        expect(sendMessage.mock.calls[0]?.[0].content).not.toContain("## Workflow Roles");
        expect(sendMessage.mock.calls[0]?.[0].content).toContain("Language: `zh-CN`");
        expect(sendMessage.mock.calls[0]?.[0].content).toContain("/chorus cancel chorus-1");
    });
});
