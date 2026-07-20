import type { ReviewReport } from "../review/contracts.js";
import { registerBuiltinReviewRenderers } from "./builtins.js";

export interface ReviewRenderer {
    id: string;
    mediaType: string;
    extension: string;
    render(report: ReviewReport): string;
}

export class ReviewRendererRegistry {
    private readonly renderers = new Map<string, ReviewRenderer>();

    register(renderer: ReviewRenderer): void {
        if (this.renderers.has(renderer.id)) throw new Error(`review renderer already registered: ${renderer.id}`);
        this.renderers.set(renderer.id, renderer);
    }

    get(id: string): ReviewRenderer {
        registerBuiltinReviewRenderers();
        const renderer = this.renderers.get(id);
        if (!renderer) throw new Error(`unknown review renderer "${id}"`);
        return renderer;
    }

    list(): ReviewRenderer[] {
        registerBuiltinReviewRenderers();
        return [...this.renderers.values()];
    }
}

export const defaultReviewRendererRegistry = new ReviewRendererRegistry();
