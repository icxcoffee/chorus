import type { RegistryLike } from "./types.js";
import type { StorePaths } from "./store.js";
import type { ChorusJobStore } from "./jobs.js";

export interface PiLikeContext {
  modelRegistry?: RegistryLike;
  model?: unknown;
  sessionManager?: { scopedModels?: Array<{ model: unknown }> };
  mode?: string;
  signal?: AbortSignal;
  cwd?: string;
  storePaths?: StorePaths;
  chorusJobStore?: ChorusJobStore;
  hasUI?: boolean;
  sendMessage?: (
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean }
  ) => unknown;
  sendUserMessage?: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => unknown;
  registerCommand?: (name: string, definition: { description: string; handler: (args: string, ctx: PiLikeContext) => unknown }) => void;
  registerTool?: (definition: {
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
  }) => void;
  ui?: {
    setStatus?: (key: string, message?: string) => void;
    setWorkingMessage?: (message?: string) => void;
    setWorkingVisible?: (visible: boolean) => void;
    setWidget?: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void;
    show?: (content: string) => void;
    notify?: (content: string, level?: "info" | "warning" | "error") => void;
    input?: (prompt: string) => Promise<string>;
    custom?: <T>(
      factory: (
        tui: { requestRender?: () => void },
        theme: { fg?: (color: string, text: string) => string; bold?: (text: string) => string },
        keybindings: unknown,
        done: (result: T) => void
      ) => { render(width: number): string[]; handleInput(data: unknown): void; invalidate?: () => void }
    ) => Promise<T>;
  };
}
