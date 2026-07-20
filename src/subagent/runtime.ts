import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { SubagentPermissionProfile } from "../types.js";

export function assertPermissionProfileAllowed(profile: SubagentPermissionProfile): void {
    if (profile === "workspace-write" && process.env.CHORUS_ALLOW_WORKSPACE_WRITE !== "1") {
        throw new Error("workspace-write permission profile requires CHORUS_ALLOW_WORKSPACE_WRITE=1");
    }
    if (profile === "full" && process.env.CHORUS_ALLOW_FULL_ACCESS !== "1") {
        throw new Error("full permission profile requires CHORUS_ALLOW_FULL_ACCESS=1");
    }
}

export function permissionProfileArgs(profile: SubagentPermissionProfile, disableTools: boolean): string[] {
    if (disableTools) {
        return ["--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates"];
    }
    if (profile === "read-only") {
        return ["--tools", "read,grep,find,ls", "--no-extensions", "--no-skills", "--no-prompt-templates"];
    }
    if (profile === "workspace-write") {
        return ["--tools", "read,grep,find,ls,edit,write", "--no-extensions", "--no-skills", "--no-prompt-templates"];
    }
    return [];
}

// Keep this aligned with the environment-based authentication contract of the
// Pi binary that Chorus launches. Stored Pi credentials continue to flow via
// PI_CODING_AGENT_DIR; this list covers users who authenticate through env vars.
export const PI_CHILD_ENV_ALLOWLIST = [
    "PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot", "COMSPEC", "PATHEXT",
    "CHORUS_PI_BIN", "PI_CODING_AGENT_DIR", "PI_OFFLINE",
    "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANT_LING_API_KEY", "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    "DEEPSEEK_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
    "FIREWORKS_API_KEY", "TOGETHER_API_KEY", "OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "ZAI_API_KEY", "ZAI_CODING_CN_API_KEY",
    "MISTRAL_API_KEY", "MINIMAX_API_KEY", "MINIMAX_CN_API_KEY", "MOONSHOT_API_KEY", "HF_TOKEN", "OPENCODE_API_KEY", "KIMI_API_KEY",
    "CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID", "XIAOMI_API_KEY",
    "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY", "COPILOT_GITHUB_TOKEN",
    "GOOGLE_CLOUD_API_KEY", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS",
    "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION", "AWS_DEFAULT_REGION",
    "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME", "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
    "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "AWS_EC2_METADATA_DISABLED", "AWS_SDK_LOAD_CONFIG",
] as const;

export function buildChildEnvironment(profile: SubagentPermissionProfile): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { CHORUS_PERMISSION_PROFILE: profile };
    for (const name of PI_CHILD_ENV_ALLOWLIST) if (process.env[name] !== undefined) env[name] = process.env[name];
    return env;
}

export function resolveSubagentCwd(requested?: string): string {
    const cwd = requested ?? process.cwd();
    if (process.env.CHORUS_ALLOW_UNSAFE_CWD === "1") return cwd;
    try {
        const mode = statSync(cwd).mode & 0o777;
        if (mode & 0o002) {
            throw new Error(
                `chorus refuses to spawn subagents in a world-writable cwd (${cwd}); ` +
                    "move to a private directory or set CHORUS_ALLOW_UNSAFE_CWD=1 to override",
            );
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("chorus refuses")) throw error;
        // If we cannot stat the cwd, let spawn surface the original error.
    }
    return cwd;
}

let cachedPiBinary: string | undefined;

interface PiBinarySearchOptions {
    path?: string;
    pathExt?: string;
    platform?: NodeJS.Platform;
    isFile?: (candidate: string) => boolean;
}

export function findPiBinaryOnPath(options: PiBinarySearchOptions = {}): string | undefined {
    const platform = options.platform ?? process.platform;
    const pathDelimiter = platform === "win32" ? ";" : delimiter;
    const extensions = platform === "win32"
        ? ["", ...(options.pathExt ?? ".COM;.EXE;.BAT;.CMD").split(";")
            .map((extension) => extension.trim())
            .filter(Boolean)
            .map((extension) => extension.startsWith(".") ? extension : `.${extension}`)]
        : [""];
    const isFile = options.isFile ?? ((candidate: string) => statSync(candidate).isFile());
    for (const directory of (options.path ?? "").split(pathDelimiter).filter(Boolean)) {
        for (const extension of extensions) {
            const candidate = join(directory, `pi${extension}`);
            try {
                if (isFile(candidate)) return candidate;
            } catch {
                // Continue searching PATH.
            }
        }
    }
    return undefined;
}

export function resolvePiBinary(): string {
    if (cachedPiBinary) return cachedPiBinary;
    const override = process.env.CHORUS_PI_BIN;
    if (override && isAbsolute(override)) {
        cachedPiBinary = override;
        return cachedPiBinary;
    }
    const candidate = findPiBinaryOnPath({
        ...(process.env.PATH ? { path: process.env.PATH } : {}),
        ...(process.env.PATHEXT ? { pathExt: process.env.PATHEXT } : {}),
    });
    if (candidate) {
        cachedPiBinary = candidate;
        return cachedPiBinary;
    }
    cachedPiBinary = "pi";
    return cachedPiBinary;
}
