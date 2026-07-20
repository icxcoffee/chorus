export type SchedulerState = "queued" | "running" | "success" | "error" | "aborted";

export const DEFAULT_MAX_CONCURRENCY = 5;

export interface ScheduledTask<T> {
    id: string;
    provider?: string;
    run: (lease: ProviderLease) => Promise<T>;
}

export interface ProviderLease {
    readonly provider: string | undefined;
    switchTo(provider: string | undefined, signal?: AbortSignal): Promise<void>;
}

export async function scheduleTasks<T>(args: {
    tasks: ScheduledTask<T>[];
    maxConcurrency: number;
    providerLimits?: Record<string, number>;
    signal?: AbortSignal;
    onState?: (id: string, state: SchedulerState) => void;
}): Promise<Array<PromiseSettledResult<T>>> {
    const results: Array<PromiseSettledResult<T> | undefined> = new Array(args.tasks.length);
    const providers = new ProviderPermitPool(args.providerLimits ?? {});
    const queued = args.tasks.map((task, index) => ({ task, index }));
    let active = 0;
    const inFlight = new Set<Promise<void>>();
    for (const task of args.tasks) args.onState?.(task.id, "queued");
    const canRun = (task: ScheduledTask<T>): boolean => {
        return providers.canAcquire(task.provider);
    };
    while (queued.length > 0 || inFlight.size > 0) {
        if (args.signal?.aborted) {
            for (const item of queued.splice(0)) {
                results[item.index] = { status: "rejected", reason: args.signal.reason ?? new Error("aborted") };
                args.onState?.(item.task.id, "aborted");
            }
            break;
        }
        const available = Math.max(1, Math.min(args.maxConcurrency, args.tasks.length));
        while (active < available) {
            const position = queued.findIndex((item) => canRun(item.task));
            if (position < 0) break;
            const item = queued.splice(position, 1)[0];
            if (!item) break;
            const lease = providers.tryCreateLease(item.task.provider);
            if (!lease) {
                queued.splice(position, 0, item);
                break;
            }
            active += 1;
            args.onState?.(item.task.id, "running");
            let running!: Promise<void>;
            running = (async () => {
                try {
                    results[item.index] = { status: "fulfilled", value: await item.task.run(lease) };
                    args.onState?.(item.task.id, "success");
                } catch (reason) {
                    results[item.index] = { status: "rejected", reason };
                    args.onState?.(item.task.id, args.signal?.aborted ? "aborted" : "error");
                } finally {
                    active -= 1;
                    lease.release();
                    inFlight.delete(running);
                }
            })();
            inFlight.add(running);
        }
        if (inFlight.size > 0) {
            const change = providers.waitForChange();
            await Promise.race([...inFlight, change.promise]);
            change.cancel();
        }
    }
    return results.map((result, index) => result ?? {
        status: "rejected",
        reason: new Error(`scheduled task ${index} did not run`),
    });
}

class ProviderPermitPool {
    private readonly active = new Map<string, number>();
    private readonly waiters = new Set<() => void>();

    constructor(private readonly limits: Record<string, number>) {}

    canAcquire(provider: string | undefined): boolean {
        if (!provider) return true;
        const limit = this.limits[provider];
        return limit === undefined || (this.active.get(provider) ?? 0) < Math.max(1, limit);
    }

    tryCreateLease(provider: string | undefined): ManagedProviderLease | undefined {
        const release = this.tryAcquire(provider);
        return release ? new ManagedProviderLease(this, provider, release) : undefined;
    }

    async acquire(provider: string | undefined, signal?: AbortSignal): Promise<() => void> {
        while (true) {
            if (signal?.aborted) throw signal.reason ?? new Error("aborted");
            const release = this.tryAcquire(provider);
            if (release) return release;
            await new Promise<void>((resolve, reject) => {
                const wake = () => { cleanup(); resolve(); };
                const abort = () => { cleanup(); reject(signal?.reason ?? new Error("aborted")); };
                const cleanup = () => {
                    this.waiters.delete(wake);
                    signal?.removeEventListener("abort", abort);
                };
                this.waiters.add(wake);
                signal?.addEventListener("abort", abort, { once: true });
            });
        }
    }

    waitForChange(): { promise: Promise<void>; cancel: () => void } {
        let wake: () => void = () => undefined;
        const promise = new Promise<void>((resolve) => {
            wake = () => { this.waiters.delete(wake); resolve(); };
            this.waiters.add(wake);
        });
        return { promise, cancel: () => { this.waiters.delete(wake); } };
    }

    private tryAcquire(provider: string | undefined): (() => void) | undefined {
        if (!this.canAcquire(provider)) return undefined;
        if (!provider || this.limits[provider] === undefined) return () => undefined;
        this.active.set(provider, (this.active.get(provider) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const next = Math.max(0, (this.active.get(provider) ?? 1) - 1);
            if (next === 0) this.active.delete(provider);
            else this.active.set(provider, next);
            for (const wake of [...this.waiters]) wake();
        };
    }
}

class ManagedProviderLease implements ProviderLease {
    constructor(
        private readonly pool: ProviderPermitPool,
        public provider: string | undefined,
        private releaseCurrent: () => void,
    ) {}

    async switchTo(provider: string | undefined, signal?: AbortSignal): Promise<void> {
        if (provider === this.provider) return;
        this.releaseCurrent();
        this.releaseCurrent = () => undefined;
        this.provider = undefined;
        this.releaseCurrent = await this.pool.acquire(provider, signal);
        this.provider = provider;
    }

    release(): void {
        this.releaseCurrent();
        this.releaseCurrent = () => undefined;
        this.provider = undefined;
    }
}
