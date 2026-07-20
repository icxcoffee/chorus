export function validateGitRevision(value: string, path: string): string {
    if (value.startsWith("-")) throw new Error(`${path} must not start with '-'`);
    if (/\s|[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${path} must not contain whitespace or control characters`);
    return value;
}
