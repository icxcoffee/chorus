export class BoundedByteTail {
    private readonly buffer: Buffer;
    private length = 0;
    private writeOffset = 0;
    private omitted = 0;

    constructor(readonly limit: number) {
        if (!Number.isInteger(limit) || limit < 1) throw new Error("bounded byte tail limit must be a positive integer");
        this.buffer = Buffer.allocUnsafe(limit);
    }

    append(value: Buffer | string): void {
        const source = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (source.length >= this.limit) {
            this.omitted += this.length + source.length - this.limit;
            source.copy(this.buffer, 0, source.length - this.limit);
            this.length = this.limit;
            this.writeOffset = 0;
            return;
        }
        const overflow = Math.max(0, this.length + source.length - this.limit);
        this.omitted += overflow;
        const first = Math.min(source.length, this.limit - this.writeOffset);
        source.copy(this.buffer, this.writeOffset, 0, first);
        if (first < source.length) source.copy(this.buffer, 0, first);
        this.writeOffset = (this.writeOffset + source.length) % this.limit;
        this.length = Math.min(this.limit, this.length + source.length);
    }

    omittedBytes(): number {
        return this.omitted;
    }

    toBuffer(): Buffer {
        if (this.length === 0) return Buffer.alloc(0);
        if (this.length < this.limit) return Buffer.from(this.buffer.subarray(0, this.length));
        const result = Buffer.allocUnsafe(this.length);
        const first = this.limit - this.writeOffset;
        this.buffer.copy(result, 0, this.writeOffset);
        if (this.writeOffset > 0) this.buffer.copy(result, first, 0, this.writeOffset);
        return result;
    }
}
