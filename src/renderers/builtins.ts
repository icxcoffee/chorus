import { githubReviewRenderer } from "./github.js";
import { jsonReviewRenderer } from "./json.js";
import { markdownReviewRenderer } from "./markdown.js";
import { defaultReviewRendererRegistry } from "./registry.js";
import { sarifReviewRenderer } from "./sarif.js";

let builtinReviewRenderersRegistered = false;

export function registerBuiltinReviewRenderers(): void {
    if (builtinReviewRenderersRegistered) return;
    for (const renderer of [markdownReviewRenderer, jsonReviewRenderer, githubReviewRenderer, sarifReviewRenderer]) {
        defaultReviewRendererRegistry.register(renderer);
    }
    builtinReviewRenderersRegistered = true;
}
