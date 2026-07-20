import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export type FakeChild = EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    exitCode: number | null;
    kills: Array<NodeJS.Signals | number | undefined>;
};

export function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kills = [];
    child.kill = (signal?: NodeJS.Signals | number) => {
        child.kills.push(signal);
        return true;
    };
    return child;
}
