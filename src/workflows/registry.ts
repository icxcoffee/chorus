import type { ReviewStageId } from "../review/contracts.js";
import type { ReviewStageRunner, ReviewWorkflow } from "./contracts.js";
import { registerBuiltinReviewComponents } from "./builtins.js";

export class ReviewWorkflowRegistry {
    private readonly workflows = new Map<string, ReviewWorkflow>();

    register(workflow: ReviewWorkflow): void {
        const id = workflow.definition.id;
        if (this.workflows.has(id)) throw new Error(`review workflow already registered: ${id}`);
        this.workflows.set(id, structuredClone(workflow));
    }

    get(id: string): ReviewWorkflow {
        registerBuiltinReviewComponents();
        const workflow = this.workflows.get(id);
        if (!workflow) throw new Error(`unknown review workflow "${id}"`);
        return structuredClone(workflow);
    }

    list(): ReviewWorkflow[] {
        registerBuiltinReviewComponents();
        return [...this.workflows.values()].map((workflow) => structuredClone(workflow));
    }
}

export class ReviewStageRegistry {
    private readonly stages = new Map<ReviewStageId, ReviewStageRunner>();

    register(stage: ReviewStageRunner): void {
        if (this.stages.has(stage.id)) throw new Error(`review stage already registered: ${stage.id}`);
        this.stages.set(stage.id, stage);
    }

    get(id: ReviewStageId): ReviewStageRunner {
        registerBuiltinReviewComponents();
        const stage = this.stages.get(id);
        if (!stage) throw new Error(`review stage is not registered: ${id}`);
        return stage;
    }
}

export const defaultReviewWorkflowRegistry = new ReviewWorkflowRegistry();
export const defaultReviewStageRegistry = new ReviewStageRegistry();
