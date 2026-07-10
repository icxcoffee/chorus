import type { PiLikeContext } from "../pi-context.js";

export function registerCommand(
  ctx: PiLikeContext,
  name: string,
  definition: { description: string; handler: (args: string, ctx: PiLikeContext) => unknown }
): void {
  ctx.registerCommand?.(name, definition);
}

export function registerTool(
  ctx: PiLikeContext,
  definition: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: (update: unknown) => void,
      ctx: PiLikeContext
    ) => unknown;
  }
): void {
  ctx.registerTool?.(definition);
}

export function withActivationActions(commandCtx: PiLikeContext, activationCtx: PiLikeContext): PiLikeContext {
  return {
    ...commandCtx,
    ...(commandCtx.sendMessage || !activationCtx.sendMessage ? {} : { sendMessage: activationCtx.sendMessage }),
    ...(commandCtx.sendUserMessage || !activationCtx.sendUserMessage ? {} : { sendUserMessage: activationCtx.sendUserMessage }),
    ...(commandCtx.chorusJobStore || !activationCtx.chorusJobStore ? {} : { chorusJobStore: activationCtx.chorusJobStore })
  };
}
