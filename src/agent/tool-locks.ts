/**
 * Target-aware locks for agent tool calls.
 *
 * The agent can return several tool calls in one model response and LangChain
 * runs them concurrently (see `version: "v2"` in agent.ts). Most tools are
 * safe to overlap, but some touch shared state:
 *
 *  - Note-level tools (`view`, `edit`, `backlinks`) must not overlap on the
 *    same note. Two concurrent `edit` calls would both read the original
 *    content and the second write would silently drop the first change.
 *  - `save_memory` reads, mutates and writes the whole memory store, so two
 *    concurrent saves lose one update.
 *  - Folder-level tools (`rename`, `copy`, `create_folder`) change paths for
 *    whole subtrees. No finite set of per-path keys can cover the children of
 *    a folder that is being moved, so they take an exclusive structural lock
 *    that blocks every other vault-touching tool.
 *
 * Two lock kinds back this:
 *
 *  1. Per-target FIFO chains (`targetTails`). Each key maps to a promise that
 *     resolves when the last queued holder releases. Acquiring appends to the
 *     chain, so waiters run in arrival order and two callers can never hold
 *     the same key at the same time.
 *  2. One structural read/write lock. Note tools take it shared (they can
 *     overlap), structural tools take it exclusive (they run alone). Waiting
 *     writers block new readers, so a rename cannot be starved by a steady
 *     stream of reads.
 *
 * Ordering: every caller acquires the structural lock first, then its target
 * keys in sorted order. That single global order means no cycle can form, even
 * when one call needs several keys (a future tool moving two notes at once).
 *
 * Abort: the agent stream passes an AbortSignal (user pressed stop, run was
 * superseded). Waits are abortable, and an aborted waiter hands its place in
 * the chain to the next caller instead of leaving a gate that never opens.
 * Without that, cancelling a batch could wedge every later call on that note
 * for the rest of the plugin session.
 *
 * This module is intentionally free of Obsidian imports so the lock behaviour
 * can be tested with plain `node --test` (see test/tool-locks.test.ts).
 */

export interface ToolLockTargets {
	/**
	 * When true the call takes the exclusive structural lock, which blocks
	 * every other vault-touching tool. Used by folder-level operations whose
	 * blast radius cannot be expressed as a fixed set of paths.
	 */
	exclusive: boolean;
	/** Paths (or synthetic keys) this call must hold exclusively. */
	keys: readonly string[];
}

interface StructuralWaiter {
	grant: () => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

const RESOLVED = Promise.resolve();

// Key -> promise that settles when the current queue for that key is drained.
const targetTails = new Map<string, Promise<void>>();

let structuralReaders = 0;
let structuralWriter = false;
let waitingWriters = 0;
const readerQueue: StructuralWaiter[] = [];
const writerQueue: StructuralWaiter[] = [];

function createAbortError(signal?: AbortSignal): Error {
	// `AbortSignal.reason` is typed as `any` in the DOM lib; narrow it explicitly.
	const reason: unknown = signal?.reason;
	if (reason instanceof Error) {
		return reason;
	}

	const error = new Error("Tool call aborted");
	error.name = "AbortError";
	return error;
}

/**
 * Resolves with `turn`, or rejects as soon as `signal` aborts. The listener is
 * always removed so a long-lived stream signal does not accumulate handlers
 * for every tool call.
 */
function waitForTurn(turn: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		return turn;
	}

	if (signal.aborted) {
		return Promise.reject(createAbortError(signal));
	}

	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(createAbortError(signal));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		turn.then(
			() => {
				cleanup();
				resolve();
			},
			(error: unknown) => {
				cleanup();
				reject(error instanceof Error ? error : new Error("Tool lock wait failed"));
			},
		);
	});
}

/**
 * Joins the FIFO chain for `key` and resolves with a release function once the
 * previous holders are done.
 */
async function acquireTarget(key: string, signal?: AbortSignal): Promise<() => void> {
	const previous = targetTails.get(key) ?? RESOLVED;
	let openGate!: () => void;
	const gate = new Promise<void>((resolve) => {
		openGate = resolve;
	});
	const tail = previous.then(() => gate);
	targetTails.set(key, tail);

	const release = () => {
		// Only the last waiter owns the map entry. Leaving it in place while a
		// successor is queued keeps the chain intact.
		if (targetTails.get(key) === tail) {
			targetTails.delete(key);
		}
		openGate();
	};

	try {
		await waitForTurn(previous, signal);
	} catch (error) {
		// We never held the lock, so open the gate to pass the baton to the next
		// waiter instead of stalling the chain forever.
		release();
		throw error;
	}

	return release;
}

function detachAbort(waiter: StructuralWaiter): void {
	if (waiter.signal && waiter.onAbort) {
		waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.onAbort = undefined;
	}
}

function releaseStructuralReader(): void {
	structuralReaders -= 1;
	if (structuralReaders === 0) {
		pumpStructural();
	}
}

function releaseStructuralWriter(): void {
	structuralWriter = false;
	pumpStructural();
}

/**
 * Grants the next queued structural holder(s): one writer if any are waiting,
 * otherwise every queued reader (they may share).
 *
 * Never grants while readers are active: a writer may only start once every
 * shared holder has released, otherwise the "exclusive" guarantee would be
 * broken (for example when a queued writer aborts and hands its slot on).
 */
function pumpStructural(): void {
	if (structuralWriter || structuralReaders > 0) {
		return;
	}

	if (waitingWriters > 0) {
		const next = writerQueue.shift();
		if (!next) {
			return;
		}
		waitingWriters -= 1;
		detachAbort(next);
		structuralWriter = true;
		next.grant();
		return;
	}

	while (readerQueue.length > 0) {
		const next = readerQueue.shift();
		if (!next) {
			break;
		}
		detachAbort(next);
		structuralReaders += 1;
		next.grant();
	}
}

function acquireStructural(exclusive: boolean, signal?: AbortSignal): Promise<() => void> {
	if (signal?.aborted) {
		return Promise.reject(createAbortError(signal));
	}

	if (exclusive) {
		// Queue behind earlier writers so a steady stream of reads cannot starve
		// a rename.
		if (!structuralWriter && structuralReaders === 0 && waitingWriters === 0) {
			structuralWriter = true;
			return Promise.resolve(releaseStructuralWriter);
		}
	} else if (!structuralWriter && waitingWriters === 0) {
		structuralReaders += 1;
		return Promise.resolve(releaseStructuralReader);
	}

	return new Promise<() => void>((resolve, reject) => {
		const waiter: StructuralWaiter = {
			grant: () => resolve(exclusive ? releaseStructuralWriter : releaseStructuralReader),
			reject,
			signal,
		};

		if (exclusive) {
			waitingWriters += 1;
			writerQueue.push(waiter);
		} else {
			readerQueue.push(waiter);
		}

		if (!signal) {
			return;
		}

		waiter.onAbort = () => {
			const queue = exclusive ? writerQueue : readerQueue;
			const index = queue.indexOf(waiter);
			if (index === -1) {
				// Already granted: the caller checks `signal.aborted` before it runs
				// the action, so there is nothing to undo here.
				return;
			}

			queue.splice(index, 1);
			if (exclusive) {
				waitingWriters -= 1;
				// The writer slot is free again; readers it was blocking may proceed.
				pumpStructural();
			}
			reject(createAbortError(signal));
		};
		signal.addEventListener("abort", waiter.onAbort, { once: true });
	});
}

/**
 * Runs `action` while holding the structural lock plus every target key.
 *
 * The structural lock is always acquired first and released last, and keys are
 * acquired in sorted order, so concurrent calls with overlapping key sets
 * cannot deadlock.
 */
export async function withToolLocks<T>(
	targets: ToolLockTargets,
	action: () => Promise<T> | T,
	signal?: AbortSignal,
): Promise<T> {
	const releases: Array<() => void> = [];
	try {
		releases.push(await acquireStructural(targets.exclusive, signal));
		for (const key of [...new Set(targets.keys)].sort()) {
			releases.push(await acquireTarget(key, signal));
		}

		// A signal can abort while we were queued. Re-check so a cancelled batch
		// never starts a mutation after the user stopped it.
		if (signal?.aborted) {
			throw createAbortError(signal);
		}

		return await action();
	} finally {
		for (let index = releases.length - 1; index >= 0; index -= 1) {
			releases[index]?.();
		}
	}
}

/**
 * Drops every held and queued lock and rejects waiters.
 *
 * Only safe when no run can be in flight: plugin unload, or between tests.
 * Calling it mid-run would let a new caller acquire a key that an in-flight
 * tool still believes it owns.
 */
export function resetToolLocks(): void {
	const error = createAbortError();
	const waiters = [...readerQueue, ...writerQueue];
	readerQueue.length = 0;
	writerQueue.length = 0;
	waitingWriters = 0;
	structuralReaders = 0;
	structuralWriter = false;
	targetTails.clear();

	for (const waiter of waiters) {
		detachAbort(waiter);
		waiter.reject(error);
	}
}
