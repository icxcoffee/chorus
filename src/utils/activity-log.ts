const TRANSITION_LINE = /^\[(?:retry|recovery|fallback)\].*$/gm;
const SNAPSHOT_LINE = /^\[(?:turn|thinking|assistant|tool(?: call| start| update| done| result)?|done|error)\]/m;

export function mergeActivitySnapshots(existing: string | undefined, next: string): string {
    if (!existing) return next;
    if (isTransition(next)) return `${existing}\n\n${next}`;
    if (SNAPSHOT_LINE.test(next)) {
        const boundary = lastTransitionBoundary(existing);
        return boundary === undefined ? next : `${existing.slice(0, boundary)}\n\n${next}`;
    }
    if (next.startsWith(existing)) return next;
    if (existing.includes(next)) return existing;
    return `${existing}\n\n${next}`;
}

function isTransition(value: string): boolean {
    return /^\[(?:retry|recovery|fallback)\]/.test(value.trimStart());
}

function lastTransitionBoundary(value: string): number | undefined {
    TRANSITION_LINE.lastIndex = 0;
    let boundary: number | undefined;
    for (let match = TRANSITION_LINE.exec(value); match; match = TRANSITION_LINE.exec(value)) boundary = match.index + match[0].length;
    return boundary;
}
