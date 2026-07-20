import { spawn as nodeSpawn } from "node:child_process";
import type { EventEmitter } from "node:events";

export interface ManagedSubagentProcess extends EventEmitter {
    kill: (signal?: NodeJS.Signals | number) => boolean;
    pid?: number;
}

const activeProcesses = new Set<ManagedSubagentProcess>();
let exitHookInstalled = false;

export function registerActiveSubagentProcess(child: ManagedSubagentProcess): () => void {
    installExitHook();
    activeProcesses.add(child);
    const unregister = () => {
        activeProcesses.delete(child);
        child.off("close", unregister);
        child.off("error", unregister);
    };
    child.once("close", unregister);
    child.once("error", unregister);
    return unregister;
}

export function cleanupActiveSubagentProcesses(terminate: (child: ManagedSubagentProcess, signal: NodeJS.Signals) => void = terminateSubagentProcess): void {
    for (const child of [...activeProcesses]) {
        try { terminate(child, "SIGTERM"); }
        catch { /* Parent shutdown cleanup is best effort. */ }
    }
}

export function activeSubagentProcessCount(): number {
    return activeProcesses.size;
}

export function terminateSubagentProcess(child: ManagedSubagentProcess | undefined, signal: NodeJS.Signals): void {
    if (!child) return;
    if (process.platform === "win32") {
        if (typeof child.pid === "number") {
            try {
                nodeSpawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
                return;
            } catch {
                // Fall through to direct child termination.
            }
        }
        child.kill(signal);
        return;
    }
    if (typeof child.pid === "number") {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch {
            // Fall back when process-group signaling is unavailable.
        }
    }
    child.kill(signal);
}

function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    process.once("exit", () => cleanupActiveSubagentProcesses());
}
