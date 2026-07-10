import type { ChorusResult } from "../types.js";

export function fallbackAnswer(result: ChorusResult): string {
  const successful = result.voices.find((voice) => voice.status === "success" && voice.output);
  return successful?.output ?? result.fallbackNote ?? "No synthesis available.";
}
