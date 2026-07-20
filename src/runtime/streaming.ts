export interface TextDelta { text: string; done?: boolean; }
export class ThrottledTextStream {
    private buffer = "";
    private last = 0;
    private readonly maxBufferChars: number;
    constructor(private readonly onDelta: (delta: TextDelta) => void, private readonly intervalMs = 50, maxBufferChars = 64 * 1024) {
        this.maxBufferChars = Number.isFinite(maxBufferChars) ? Math.max(2, Math.floor(maxBufferChars)) : 64 * 1024;
    }
    push(text: string): void {
        let remaining = text;
        while (remaining.length > 0) {
            if (this.buffer.length >= this.maxBufferChars) this.flush();
            const capacity = this.maxBufferChars - this.buffer.length;
            const splitAt = safeSplitIndex(remaining, capacity);
            if (splitAt === 0) {
                this.flush();
                continue;
            }
            this.buffer += remaining.slice(0, splitAt);
            remaining = remaining.slice(splitAt);
            if (this.buffer.length >= this.maxBufferChars) this.flush();
        }
        const now = Date.now();
        if (now - this.last >= this.intervalMs) this.flush();
    }
    flush(done = false): void { if (!this.buffer && !done) return; this.onDelta({ text: this.buffer, ...(done ? { done: true } : {}) }); this.buffer = ""; this.last = Date.now(); }
}

function safeSplitIndex(value: string, limit: number): number {
    if (value.length <= limit) return value.length;
    if (limit <= 0) return 0;
    const last = value.charCodeAt(limit - 1);
    return last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit;
}
