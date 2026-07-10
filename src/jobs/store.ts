import { ChorusJobStore } from "../jobs.js";
import type { StorePaths } from "../store.js";

export interface JobStoreContext {
  storePaths?: StorePaths;
  chorusJobStore?: ChorusJobStore;
}

export function getJobStore(ctx: JobStoreContext): ChorusJobStore {
  ctx.chorusJobStore ??= new ChorusJobStore(ctx.storePaths ?? {});
  return ctx.chorusJobStore;
}
