import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { resetToolLocks, withToolLocks } from "../src/agent/tool-locks";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// Lets every task that is ready to start run before we assert on ordering.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
	resetToolLocks();
});

void test("serializes calls that share a target", async () => {
	const order: string[] = [];
	const firstGate = deferred();

	const first = withToolLocks({ exclusive: false, keys: ["vault:a"] }, async () => {
		order.push("first:start");
		await firstGate.promise;
		order.push("first:end");
	});
	const second = withToolLocks({ exclusive: false, keys: ["vault:a"] }, () => {
		order.push("second");
	});

	await flush();
	assert.deepEqual(order, ["first:start"], "second must wait for the shared key");

	firstGate.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

void test("runs calls with different targets concurrently", async () => {
	const order: string[] = [];
	const gate = deferred();

	const first = withToolLocks({ exclusive: false, keys: ["vault:a"] }, async () => {
		order.push("a:start");
		await gate.promise;
	});
	const second = withToolLocks({ exclusive: false, keys: ["vault:b"] }, async () => {
		order.push("b:start");
		await gate.promise;
	});

	await flush();
	assert.deepEqual(order, ["a:start", "b:start"], "different keys must not block each other");

	gate.resolve();
	await Promise.all([first, second]);
});

void test("acquires several keys without deadlocking", async () => {
	const order: string[] = [];
	const gate = deferred();

	const first = withToolLocks({ exclusive: false, keys: ["vault:a", "vault:b"] }, async () => {
		order.push("first:start");
		await gate.promise;
		order.push("first:end");
	});
	// Reverse order must not deadlock: keys are always acquired sorted.
	const second = withToolLocks({ exclusive: false, keys: ["vault:b", "vault:a"] }, () => {
		order.push("second");
	});

	await flush();
	assert.deepEqual(order, ["first:start"]);

	gate.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

void test("releases the lock when the action throws", async () => {
	await assert.rejects(
		withToolLocks({ exclusive: false, keys: ["vault:a"] }, () => {
			throw new Error("boom");
		}),
		/boom/,
	);

	let ran = false;
	await withToolLocks({ exclusive: false, keys: ["vault:a"] }, () => {
		ran = true;
	});
	assert.equal(ran, true, "the key must be free after a failed action");
});

void test("passes the lock on when a queued call aborts", async () => {
	const order: string[] = [];
	const holderGate = deferred();
	const controller = new AbortController();

	const holder = withToolLocks({ exclusive: false, keys: ["vault:a"] }, async () => {
		order.push("holder");
		await holderGate.promise;
	});
	const aborted = withToolLocks(
		{ exclusive: false, keys: ["vault:a"] },
		() => {
			order.push("aborted");
		},
		controller.signal,
	);
	const next = withToolLocks({ exclusive: false, keys: ["vault:a"] }, () => {
		order.push("next");
	});

	await flush();
	controller.abort();
	await assert.rejects(aborted, { name: "AbortError" });

	holderGate.resolve();
	await Promise.all([holder, next]);
	assert.deepEqual(order, ["holder", "next"], "the cancelled call must not run and must not block the queue");
});

void test("does not run the action when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	let ran = false;

	await assert.rejects(
		withToolLocks(
			{ exclusive: false, keys: [] },
			() => {
				ran = true;
			},
			controller.signal,
		),
		{ name: "AbortError" },
	);
	assert.equal(ran, false);
});

void test("structural calls run alone and waiting writers block new readers", async () => {
	const order: string[] = [];
	const readerGate = deferred();

	const reader = withToolLocks({ exclusive: false, keys: ["vault:a"] }, async () => {
		order.push("reader");
		await readerGate.promise;
	});
	const writer = withToolLocks({ exclusive: true, keys: [] }, () => {
		order.push("writer");
	});
	// Arrives after the writer queued: writer preference keeps the rename from
	// being starved by a stream of reads.
	const lateReader = withToolLocks({ exclusive: false, keys: ["vault:b"] }, () => {
		order.push("lateReader");
	});

	await flush();
	assert.deepEqual(order, ["reader"], "the structural call must wait for the shared reader");

	readerGate.resolve();
	await Promise.all([reader, writer, lateReader]);
	assert.deepEqual(order, ["reader", "writer", "lateReader"]);
});

void test("an aborted writer does not let another writer pass active readers", async () => {
	const order: string[] = [];
	const readerGate = deferred();
	const controller = new AbortController();

	const reader = withToolLocks({ exclusive: false, keys: [] }, async () => {
		order.push("reader");
		await readerGate.promise;
	});
	const firstWriter = withToolLocks({ exclusive: true, keys: [] }, () => {
		order.push("firstWriter");
	});
	const abortedWriter = withToolLocks(
		{ exclusive: true, keys: [] },
		() => {
			order.push("abortedWriter");
		},
		controller.signal,
	);

	await flush();
	controller.abort();
	await assert.rejects(abortedWriter, { name: "AbortError" });
	await flush();
	assert.deepEqual(order, ["reader"], "the remaining writer must wait for the active reader");

	readerGate.resolve();
	await Promise.all([reader, firstWriter]);
	assert.deepEqual(order, ["reader", "firstWriter"]);
});

void test("resetToolLocks rejects queued waiters", async () => {
	const gate = deferred();
	const holder = withToolLocks({ exclusive: true, keys: [] }, () => gate.promise);
	const queued = withToolLocks({ exclusive: true, keys: [] }, () => {
		throw new Error("queued call must not run");
	});

	await flush();
	resetToolLocks();
	await assert.rejects(queued, /aborted/i);

	gate.resolve();
	await holder;
});
