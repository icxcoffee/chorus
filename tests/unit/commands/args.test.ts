import { describe, expect, it } from "vitest";
import { joinArgs, parseDurationMs, splitCommandArgs } from "../../../src/commands/args.js";

describe("commands/args", () => {
  describe("splitCommandArgs", () => {
    it("splits on whitespace and drops empty tokens", () => {
      expect(splitCommandArgs("ask   what  do ")).toEqual(["ask", "what", "do"]);
    });

    it("strips matching quotes and keeps inner spaces", () => {
      expect(splitCommandArgs('"what do you" think')).toEqual(["what do you", "think"]);
      expect(splitCommandArgs("'don\\'t' stop")).toEqual(["don't", "stop"]);
    });

    it("processes backslash escapes", () => {
      expect(splitCommandArgs("what\\? really")).toEqual(["what?", "really"]);
    });
  });

  describe("joinArgs", () => {
    it("rejoins tokens with single spaces and collapses runs of whitespace", () => {
      expect(joinArgs("what   do   you think")).toBe("what do you think");
    });

    it("strips quotes and processes escapes just like splitCommandArgs", () => {
      expect(joinArgs('"what do you"')).toBe("what do you");
      expect(joinArgs("what\\? really")).toBe("what? really");
      expect(joinArgs("'don\\'t stop'")).toBe("don't stop");
    });

    it("returns empty string for blank input", () => {
      expect(joinArgs("")).toBe("");
      expect(joinArgs("   ")).toBe("");
    });

    // Regression: /chorus ask <prompt> and /chorus-ask <prompt> must feed the
    // identical prompt string to handleAsk. The router computes the prompt as
    // rest.join(" ") after splitCommandArgs strips the leading "ask" token;
    // joinArgs must reproduce that for the same prompt text.
    it("matches the router's rest.join(' ') for the same prompt (alias parity)", () => {
      const prompts = [
        "what do you think of pi agent",
        '"what do you think"',
        "what  do   you think",
        "what\\? really",
        "'don\\'t stop'",
        ""
      ];
      for (const prompt of prompts) {
        const viaRouter = splitCommandArgs(`ask ${prompt}`).slice(1).join(" ");
        const viaAlias = joinArgs(prompt);
        expect(viaAlias).toBe(viaRouter);
      }
    });
  });

  describe("parseDurationMs", () => {
    it.each([
      ["2s", 2000],
      ["3m", 180000],
      ["1h", 3600000],
      ["1000ms", 1000],
      ["default", undefined]
    ])("parses %s", (input, expected) => {
      expect(parseDurationMs(input)).toBe(expected);
    });

    it("returns null for invalid input", () => {
      expect(parseDurationMs("nope")).toBeNull();
      expect(parseDurationMs(undefined)).toBeNull();
    });
  });
});
