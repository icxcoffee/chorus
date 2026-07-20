import { architectureReviewDefinition, designReviewDefinition } from "./additional.js";
import { codeReviewDefinition } from "./code-review.js";
import { defaultReviewStageRegistry, defaultReviewWorkflowRegistry } from "./registry.js";
import { crossReviewStage } from "./stages/cross-review.js";
import { devilStage } from "./stages/devil.js";
import { independentReviewStage } from "./stages/independent-review.js";
import { integrateStage } from "./stages/integrate.js";

let builtinReviewComponentsRegistered = false;

export function registerBuiltinReviewComponents(): void {
    if (builtinReviewComponentsRegistered) return;
    for (const definition of [codeReviewDefinition, architectureReviewDefinition, designReviewDefinition]) {
        defaultReviewWorkflowRegistry.register({ definition });
    }
    for (const stage of [independentReviewStage, crossReviewStage, devilStage, integrateStage]) {
        defaultReviewStageRegistry.register(stage);
    }
    builtinReviewComponentsRegistered = true;
}
