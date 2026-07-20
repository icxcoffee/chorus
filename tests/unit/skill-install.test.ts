import { afterEach, describe, expect, it } from "vitest";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installChorusSkill, parseSkillInstallArgs } from "../../src/cli/install-skill.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Chorus skill installer", () => {
    it("parses target, mode, and force options", () => {
        expect(parseSkillInstallArgs(["../target", "--mode", "link", "--force"], "/workspace/source")).toEqual({
            targetDir: "/workspace/target",
            mode: "link",
            scope: "project",
            force: true,
            help: false,
        });
        expect(() => parseSkillInstallArgs(["--mode", "invalid"])).toThrow("--mode must be copy or link");
        expect(parseSkillInstallArgs(["--scope", "user"])).toMatchObject({ scope: "user" });
        expect(() => parseSkillInstallArgs(["target", "--scope", "user"])).toThrow("cannot be used with --scope user");
    });

    it("copies the canonical skill into Codex and Claude project directories", async () => {
        const { root, source, target } = await fixture();
        const result = await installChorusSkill({ targetDir: target, sourceDir: source });

        expect(result.mode).toBe("copy");
        await expect(readFile(join(target, ".agents/skills/chorus-agent/SKILL.md"), "utf8")).resolves.toBe("skill-body\n");
        await expect(readFile(join(target, ".claude/skills/chorus-agent/SKILL.md"), "utf8")).resolves.toBe("skill-body\n");
        temporaryDirectories.push(root);
    });

    it("refuses partial replacement unless force is explicit", async () => {
        const { root, source, target } = await fixture();
        const existing = join(target, ".agents/skills/chorus-agent");
        await mkdir(existing, { recursive: true });
        await writeFile(join(existing, "SKILL.md"), "old\n");

        await expect(installChorusSkill({ targetDir: target, sourceDir: source })).rejects.toThrow("--force");
        await expect(lstat(join(target, ".claude/skills/chorus-agent"))).rejects.toMatchObject({ code: "ENOENT" });
        await installChorusSkill({ targetDir: target, sourceDir: source, force: true });
        await expect(readFile(join(existing, "SKILL.md"), "utf8")).resolves.toBe("skill-body\n");
        temporaryDirectories.push(root);
    });

    it("links both host directories to one persistent skill source", async () => {
        const { root, source, target } = await fixture();
        await installChorusSkill({ targetDir: target, sourceDir: source, mode: "link" });

        expect((await lstat(join(target, ".agents/skills/chorus-agent"))).isSymbolicLink()).toBe(true);
        await expect(realpath(join(target, ".agents/skills/chorus-agent"))).resolves.toBe(await realpath(source));
        await expect(realpath(join(target, ".claude/skills/chorus-agent"))).resolves.toBe(await realpath(source));
        temporaryDirectories.push(root);
    });

    it("installs into Codex and Claude user skill directories", async () => {
        const { root, source, target } = await fixture();
        const codexHome = join(root, "codex-home");
        const claudeConfigDir = join(root, "claude-home");
        const result = await installChorusSkill({
            targetDir: target,
            sourceDir: source,
            scope: "user",
            codexHome,
            claudeConfigDir,
        });

        expect(result.scope).toBe("user");
        await expect(readFile(join(codexHome, "skills/chorus-agent/SKILL.md"), "utf8")).resolves.toBe("skill-body\n");
        await expect(readFile(join(claudeConfigDir, "skills/chorus-agent/SKILL.md"), "utf8")).resolves.toBe("skill-body\n");
        temporaryDirectories.push(root);
    });
});

async function fixture(): Promise<{ root: string; source: string; target: string }> {
    const root = await mkdtemp(join(tmpdir(), "chorus-skill-install-"));
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(join(source, "agents"), { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, "SKILL.md"), "skill-body\n");
    await writeFile(join(source, "agents/openai.yaml"), "interface: {}\n");
    return { root, source, target };
}
