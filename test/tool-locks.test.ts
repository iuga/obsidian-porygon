import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
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

void describe("withToolLocks", () => {
	/**
	 * Verifies that two calls targeting the same key run one after the other.
	 *
	 * The expectation is that the second call does not start until the first
	 * one releases the key.
	 *
	 * This is important because concurrent edits on one note would otherwise
	 * read the same original content and the second write would drop the first
	 * change.
	 */
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

	/**
	 * Verifies that two calls with disjoint targets run concurrently.
	 *
	 * The expectation is that both calls start before either one finishes.
	 *
	 * This is important because serializing unrelated calls would give back the
	 * latency win that concurrent tool execution exists to provide.
	 */
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

	/**
	 * Verifies that two calls requesting the same two keys in opposite order
	 * both complete.
	 *
	 * The expectation is that the keys are acquired in a global sorted order,
	 * so the second call waits instead of deadlocking.
	 *
	 * This is important because a deadlock would hang the whole agent turn.
	 */
	void test("acquires several keys without deadlocking", async () => {
		const order: string[] = [];
		const gate = deferred();

		const first = withToolLocks({ exclusive: false, keys: ["vault:a", "vault:b"] }, async () => {
			order.push("first:start");
			await gate.promise;
			order.push("first:end");
		});
		const second = withToolLocks({ exclusive: false, keys: ["vault:b", "vault:a"] }, () => {
			order.push("second");
		});

		await flush();
		assert.deepEqual(order, ["first:start"]);

		gate.resolve();
		await Promise.all([first, second]);
		assert.deepEqual(order, ["first:start", "first:end", "second"]);
	});

	/**
	 * Verifies that a failing tool action still frees its key.
	 *
	 * The expectation is that the next call can acquire the same key
	 * immediately after the action throws.
	 *
	 * This is important because a leaked key would block that note for the rest
	 * of the plugin session.
	 */
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

	/**
	 * Verifies that cancelling a queued call removes it from the queue without
	 * wedging the waiters behind it.
	 *
	 * The expectation is that the cancelled call never runs and the next waiter
	 * proceeds once the holder releases.
	 *
	 * This is important because otherwise stopping a batch would block every
	 * later call on that note for the rest of the session.
	 */
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

	/**
	 * Verifies that a call which is already cancelled never runs its action.
	 *
	 * The expectation is that the promise rejects with `AbortError` and the
	 * action is not invoked.
	 *
	 * This is important because a cancelled mutation must not reach the vault.
	 */
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

	/**
	 * Verifies that a structural call waits for active readers, then runs
	 * alone, and that readers arriving later queue behind it.
	 *
	 * The expectation is that the order is reader, structural call, late
	 * reader.
	 *
	 * This is important because folder-level operations change child paths and
	 * must not race any note access, while still not starving behind a steady
	 * stream of reads.
	 */
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
		const lateReader = withToolLocks({ exclusive: false, keys: ["vault:b"] }, () => {
			order.push("lateReader");
		});

		await flush();
		assert.deepEqual(order, ["reader"], "the structural call must wait for the shared reader");

		readerGate.resolve();
		await Promise.all([reader, writer, lateReader]);
		assert.deepEqual(order, ["reader", "writer", "lateReader"]);
	});

	/**
	 * Verifies that an aborted structural writer does not hand its slot to the
	 * next writer while a reader is still active.
	 *
	 * The expectation is that the remaining writer still waits for the active
	 * reader before it starts.
	 *
	 * This is important because granting the writer early would break the
	 * exclusive guarantee and let a folder move race a note read.
	 */
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
});

void describe("resetToolLocks", () => {
	/**
	 * Verifies that resetting the locks rejects calls that are still queued.
	 *
	 * The expectation is that the queued call rejects with an abort error
	 * instead of waiting forever.
	 *
	 * This is important because plugin unload must not leave pending promises
	 * that can never settle.
	 */
	void test("rejects queued waiters", async () => {
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
});
