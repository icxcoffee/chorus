#!/usr/bin/env node
import { cp, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./main.js";

export const CHORUS_SKILL_NAME = "chorus-agent";
export type SkillInstallMode = "copy" | "link";
export type SkillInstallScope = "project" | "user";

export interface SkillInstallOptions {
    targetDir: string;
    mode?: SkillInstallMode;
    scope?: SkillInstallScope;
    force?: boolean;
    sourceDir?: string;
    codexHome?: string;
    claudeConfigDir?: string;
}

export interface SkillInstallResult {
    mode: SkillInstallMode;
    scope: SkillInstallScope;
    sourceDir: string;
    destinations: string[];
}

export function packagedSkillDir(): string {
    return fileURLToPath(new URL("../../skills/chorus-agent/", import.meta.url));
}

export async function installChorusSkill(options: SkillInstallOptions): Promise<SkillInstallResult> {
    const targetDir = resolve(options.targetDir);
    const sourceDir = resolve(options.sourceDir ?? packagedSkillDir());
    const mode = options.mode ?? "copy";
    const scope = options.scope ?? "project";
    const destinations = scope === "user"
        ? [
            join(resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")), "skills", CHORUS_SKILL_NAME),
            join(resolve(options.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")), "skills", CHORUS_SKILL_NAME),
        ]
        : [
            join(targetDir, ".agents", "skills", CHORUS_SKILL_NAME),
            join(targetDir, ".claude", "skills", CHORUS_SKILL_NAME),
        ];

    await requireSkillSource(sourceDir);
    const existing = (await Promise.all(destinations.map(async (path) => ({ path, exists: await pathExists(path) })))).filter((entry) => entry.exists);
    if (existing.length > 0 && !options.force) {
        throw new Error(`skill destination already exists: ${existing.map((entry) => entry.path).join(", ")}; rerun with --force to replace it`);
    }

    if (options.force) {
        await Promise.all(existing.map((entry) => rm(entry.path, { recursive: true, force: true })));
    }

    for (const destination of destinations) {
        await mkdir(dirname(destination), { recursive: true });
        if (mode === "copy") {
            await cp(sourceDir, destination, { recursive: true });
        } else {
            const target = process.platform === "win32" ? sourceDir : relative(dirname(destination), sourceDir);
            await symlink(target, destination, process.platform === "win32" ? "junction" : "dir");
        }
    }

    return { mode, scope, sourceDir, destinations };
}

export interface ParsedSkillInstallArgs {
    targetDir: string;
    mode: SkillInstallMode;
    scope: SkillInstallScope;
    force: boolean;
    help: boolean;
}

export function parseSkillInstallArgs(args: string[], cwd = process.cwd()): ParsedSkillInstallArgs {
    let targetDir = cwd;
    let targetSeen = false;
    let mode: SkillInstallMode = "copy";
    let scope: SkillInstallScope = "project";
    let force = false;
    let help = false;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--help" || arg === "-h") help = true;
        else if (arg === "--force") force = true;
        else if (arg === "--copy") mode = "copy";
        else if (arg === "--link") mode = "link";
        else if (arg === "--user") scope = "user";
        else if (arg === "--project") scope = "project";
        else if (arg === "--mode") {
            const value = args[++index];
            if (value !== "copy" && value !== "link") throw new Error("--mode must be copy or link");
            mode = value;
        } else if (arg === "--scope") {
            const value = args[++index];
            if (value !== "project" && value !== "user") throw new Error("--scope must be project or user");
            scope = value;
        } else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        else if (targetSeen) throw new Error("only one target project directory may be provided");
        else {
            targetDir = resolve(cwd, arg);
            targetSeen = true;
        }
    }

    if (scope === "user" && targetSeen) throw new Error("target project directory cannot be used with --scope user");
    return { targetDir, mode, scope, force, help };
}

export async function runSkillInstallCli(args: string[], cwd = process.cwd()): Promise<number> {
    try {
        const parsed = parseSkillInstallArgs(args, cwd);
        if (parsed.help) {
            process.stdout.write(usage());
            return 0;
        }
        const result = await installChorusSkill(parsed);
        process.stdout.write([
            `Installed ${CHORUS_SKILL_NAME} for ${result.scope} scope in ${result.mode} mode:`,
            ...result.destinations.map((destination) => `- ${destination}`),
            "Restart Codex or open a new session; Claude Code hot-reloads skills.",
            "",
        ].join("\n"));
        return 0;
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}`);
        return 1;
    }
}

function usage(): string {
    return [
        "Usage: chorus-skill-install [target-project] [--scope project|user] [--mode copy|link] [--force]",
        "",
        "Project scope installs into .agents/skills and .claude/skills under the target project.",
        "User scope installs into CODEX_HOME/skills and CLAUDE_CONFIG_DIR/skills (defaulting under the home directory).",
        "Use copy mode for portable project commits; use link mode with a persistent local Chorus checkout.",
        "",
    ].join("\n");
}

async function requireSkillSource(sourceDir: string): Promise<void> {
    if (!await pathExists(join(sourceDir, "SKILL.md"))) throw new Error(`Chorus skill source is missing: ${sourceDir}`);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

if (await isMainModule(import.meta.url, process.argv[1])) {
    process.exitCode = await runSkillInstallCli(process.argv.slice(2));
}
