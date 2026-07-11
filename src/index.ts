import type { PiLikeContext } from "./pi-context.js";
import { ChorusJobStore } from "./jobs.js";
import { handleAgent } from "./commands/agent.js";
import { handleAsk } from "./commands/ask.js";
import { joinArgs } from "./commands/args.js";
import { handleConfig } from "./commands/config.js";
import { handleChorusCommand } from "./commands/router.js";
import { handleOptimize } from "./commands/optimize.js";
import { chorusAnswerTool } from "./tools/chorus-answer.js";
import { registerCommand, registerTool, withActivationActions } from "./runtime/activation.js";

export async function activate(ctx: PiLikeContext): Promise<void> {
  const activationCtx: PiLikeContext = {
    ...ctx,
    chorusJobStore: ctx.chorusJobStore ?? new ChorusJobStore(ctx.storePaths ?? {})
  };
  registerCommand(ctx, "chorus", {
    description: "Run Chorus commands: /chorus config, /chorus ask <question>, /chorus agent <task>, /chorus jobs, /chorus watch <jobId>",
    handler: async (args, commandCtx) => handleChorusCommand(withActivationActions(commandCtx, activationCtx), args)
  });
  registerCommand(ctx, "chorus-config", {
    description: "Open Chorus config",
    handler: async (args, commandCtx) => handleConfig(withActivationActions(commandCtx, activationCtx), args)
  });
  registerCommand(ctx, "chorus-ask", {
    description: "Ask Chorus with the active preset",
    handler: async (args, commandCtx) => handleAsk(withActivationActions(commandCtx, activationCtx), joinArgs(args))
  });
  registerCommand(ctx, "chorus-agent", {
    description: "Run a task through multiple Chorus agents and synthesize the result",
    handler: async (args, commandCtx) => handleAgent(withActivationActions(commandCtx, activationCtx), joinArgs(args))
  });
  registerCommand(ctx, "chorus-optimize", {
    description: "Optimize a prompt without asking",
    handler: async (args, commandCtx) => handleOptimize(withActivationActions(commandCtx, activationCtx), joinArgs(args))
  });
  registerTool(ctx, {
    name: "chorus_answer",
    label: "Chorus Answer",
    description: "Fan a prompt out to multiple configured voices and synthesize the result.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        presetName: { type: "string" }
      },
      required: ["prompt"]
    },
    async execute(_toolCallId, params, signal, onUpdate, toolCtx) {
      return chorusAnswerTool({ ...toolCtx, signal }, params, onUpdate);
    }
  });
}

export default activate;
export type { PiLikeContext } from "./pi-context.js";
export { chorusAnswerTool } from "./tools/chorus-answer.js";
export { renderPromptOptimization, renderRunStarted } from "./render/run.js";
export { bindJobToHostSignal } from "./runtime/job-runner.js";
