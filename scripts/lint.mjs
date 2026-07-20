import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const roots = ["src", "tests", "scripts", "skills"];
const violations = [];
const maxLineRules = [
  {
    prefix: "src/",
    suffix: ".ts",
    limit: 400,
    exceptions: new Set()
  },
  {
    prefix: "tests/",
    suffix: ".test.ts",
    limit: 500,
    exceptions: new Set()
  }
];

async function walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
    } else if (/\.(ts|mts|cts|js|mjs|json|md)$/.test(entry.name)) {
      await checkFile(path);
    }
  }
}

async function checkFile(path) {
  const text = await readFile(path, "utf8");
  if (text.includes("\t")) violations.push(`${path}: contains tab characters`);
  if (!text.endsWith("\n")) violations.push(`${path}: missing trailing newline`);
  const lines = text.split("\n");
  checkMaxLines(path, lines.length - 1);
  lines.forEach((line, index) => {
    if (/[ \t]$/.test(line)) violations.push(`${path}:${index + 1}: trailing whitespace`);
  });
}

function checkMaxLines(path, lineCount) {
  const normalized = path.replaceAll("\\", "/");
  for (const rule of maxLineRules) {
    if (!normalized.startsWith(rule.prefix) || !normalized.endsWith(rule.suffix)) continue;
    if (rule.exceptions.has(normalized)) return;
    if (lineCount > rule.limit) violations.push(`${path}: ${lineCount} lines exceeds max ${rule.limit}`);
    return;
  }
}

await Promise.all(roots.map(walk));

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
