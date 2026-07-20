import { randomUUID } from "node:crypto";
import { chmod, rename, rm, writeFile } from "node:fs/promises";

export async function atomicPrivateWrite(path: string, content: string): Promise<void> {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, content, { mode: 0o600 });
        await chmodPrivateBestEffort(temporary);
        await rename(temporary, path);
        await chmodPrivateBestEffort(path);
    } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
}

export async function chmodPrivateBestEffort(path: string): Promise<void> {
    try {
        await chmod(path, 0o600);
    } catch {
        // Some non-POSIX filesystems do not support chmod.
    }
}
