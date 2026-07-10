import type { PiLikeContext } from "../pi-context.js";
import { notify } from "../runtime/pi-ui.js";
import { handleAgent } from "./agent.js";
import { handleAsk } from "./ask.js";
import { handleConfig } from "./config.js";
import { handleCancel, handleJob, handleJobs, handleWatch } from "./jobs.js";
import { handleOptimize } from "./optimize.js";
import { splitCommandArgs } from "./args.js";

export async function handleChorusCommand(ctx: PiLikeContext, rawArgs: string): Promise<void> {
  const [subcommand, ...rest] = splitCommandArgs(rawArgs);
  const body = rest.join(" ");
  if (!subcommand || subcommand === "config") return handleConfig(ctx, body);
  if (subcommand === "ask") return handleAsk(ctx, body);
  if (subcommand === "agent") return handleAgent(ctx, body);
  if (subcommand === "jobs") return handleJobs(ctx);
  if (subcommand === "job") return handleJob(ctx, body);
  if (subcommand === "watch") return handleWatch(ctx, body);
  if (subcommand === "cancel") return handleCancel(ctx, body);
  if (subcommand === "optimize") return handleOptimize(ctx, body);
  notify(ctx, "Usage: /chorus config | /chorus ask <question> | /chorus agent <task> | /chorus jobs | /chorus watch <jobId> [agent] | /chorus cancel <jobId> | /chorus optimize <prompt>", "warning");
}
