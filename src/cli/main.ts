import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function isMainModule(importMetaUrl: string, argvEntry: string | undefined): Promise<boolean> {
    if (!argvEntry) return false;
    try {
        return await realpath(fileURLToPath(importMetaUrl)) === await realpath(argvEntry);
    } catch {
        return false;
    }
}
