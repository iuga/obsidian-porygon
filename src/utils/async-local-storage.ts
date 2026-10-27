/**
 * Cross-platform `AsyncLocalStorage` for Porygon's Electron renderer.
 *
 * On desktop (Obsidian's Electron renderer) this is a small port of Node's own
 * `async_hooks`-based `AsyncLocalStorage`: a `createHook` that copies each
 * store from the triggering async resource onto every new one, keyed by a
 * per-instance symbol on the resource. The `async_hooks` module is resolved
 * lazily via the renderer's `require` so this file never *statically* imports
 * `node:async_hooks` — a static import would fail to resolve at module-eval time
 * and crash plugin load.
 *
 * We deliberately do NOT hand out Node's own `AsyncLocalStorage` class. From
 * Node 24 (Electron 40+; current Obsidian shipper) that class is backed by
 * `AsyncContextFrame`, which keeps the current frame in V8's
 * continuation-preserved embedder-data slot. In a renderer, Blink's
 * task-attribution scheduler stores its own C++ heap object in that same slot
 * for interaction-attributed tasks (the soft-navigation heuristics: a click on
 * "Send" qualifies), and Node reads the slot back without a type check. The
 * first `getStore()` inside such a task then hands JavaScript a non-JS heap
 * object and V8 aborts the renderer — the "window goes white on the first chat
 * send" crash, reached from LangGraph's config lookup. The hooks-based
 * implementation never touches that slot and is exactly what older Node ran
 * underneath, so behavior on older Electron is unchanged.
 *
 * On any environment without `node:async_hooks` we fall back to a synchronous
 * stack-based shim. It preserves `run(store, fn)` scoping across synchronous and
 * awaited single-run chains, which is all the desktop UI drives; it does not
 * isolate genuinely concurrent async tasks the way the hooks-based version does.
 * Porygon ships `isDesktopOnly: true`, so the shim is a defensive fallback only.
 */

/**
 * The `AsyncLocalStorage` surface Porygon needs: the subset
 * `@langchain/core`'s `AsyncLocalStorageInterface` requires
 * (`getStore`/`run`/`enterWith`), not Node's full class — `run` takes no
 * trailing args (langchain's callback ignores them) and `getStore()` returns
 * `undefined` while a storage is disabled.
 */
export interface AsyncLocalStorageLike<T> {
	getStore(): T | undefined;
	run<R>(store: T, fn: () => R): R;
	enterWith(store: T): void;
}

/**
 * Synchronous fallback used when `node:async_hooks` is unavailable. Kept in sync
 * with the semantics the hooks-based version promises for the single-run agent
 * flows Porygon's UI drives.
 */
export class SyncAsyncLocalStorage<T> implements AsyncLocalStorageLike<T> {
	private stack: T[] = [];
	private entered: T | undefined;

	getStore(): T | undefined {
		return this.stack.length > 0 ? this.stack[this.stack.length - 1] : this.entered;
	}

	run<R>(store: T, fn: () => R): R {
		// Avoid the push/pop churn when the store is already the active one.
		if (Object.is(store, this.getStore())) return fn();
		this.stack.push(store);
		try {
			return fn();
		} finally {
			this.stack.pop();
		}
	}

	enterWith(store: T): void {
		this.entered = store;
	}
}

/** The two `async_hooks` primitives the hooks-based implementation needs. */
interface AsyncHooksPrimitives {
	createHook(callbacks: {
		init(asyncId: number, type: string, triggerAsyncId: number, resource: object): void;
	}): { enable(): void; disable(): void };
	executionAsyncResource(): object;
}

/** Async resources carry one slot per storage instance, keyed by its symbol. */
type StoreCarrier = Record<symbol, unknown>;

function asAsyncHooks(candidate: unknown): AsyncHooksPrimitives | null {
	const mod = candidate as Partial<AsyncHooksPrimitives> | null | undefined;
	if (typeof mod?.createHook === "function" && typeof mod?.executionAsyncResource === "function") {
		return mod as AsyncHooksPrimitives;
	}
	return null;
}

/** Resolve the renderer's `node:async_hooks` (createHook + executionAsyncResource), or null. */
function tryRequireAsyncHooks(): AsyncHooksPrimitives | null {
	// `obsidianmd/no-global-this` bans the bare `global`/`globalThis` identifiers
	// (and that rule can't be disabled here), so we never name the global. Instead
	// we probe each runtime with the accessor that exists in it: `window` is the
	// renderer's global (and `require` lives on it); on a plain Node runner
	// `window` is absent, so we fall through to `process.getBuiltinModule`.
	//
	// Electron's renderer exposes CommonJS `require` on its global object.
	try {
		const req = (window as unknown as { require?: (id: string) => unknown }).require;
		if (typeof req === "function") {
			const mod = asAsyncHooks(req("async_hooks"));
			if (mod) return mod;
		}
	} catch {
		// `window` is undefined in a non-DOM (e.g. Vitest) runner — fall through.
	}
	// Plain Node (e.g. Vitest) has no global `require` under ESM, but exposes the
	// synchronous builtin accessor `process.getBuiltinModule` (Node 20.16+).
	try {
		const getBuiltinModule = (process as unknown as {
			getBuiltinModule?: (id: string) => unknown;
		}).getBuiltinModule;
		if (typeof getBuiltinModule === "function") {
			const mod = asAsyncHooks(getBuiltinModule("async_hooks"));
			if (mod) return mod;
		}
	} catch {
		// fall through
	}
	return null;
}

const asyncHooks = tryRequireAsyncHooks();

/**
 * Every enabled instance, so the single shared hook can propagate all of their
 * stores in one pass. Mirrors Node's module-level `storageList`.
 */
const enabledStorages: HooksAsyncLocalStorage<unknown>[] = [];
let propagationHook: { enable(): void; disable(): void } | null = null;

/**
 * Port of Node's `lib/internal/async_local_storage/async_hooks.js`, minus
 * `exit`/`disable`/`bind`/`snapshot`, which nothing here uses.
 */
class HooksAsyncLocalStorage<T> implements AsyncLocalStorageLike<T> {
	private readonly key = Symbol("porygon:asyncLocalStorage");
	private enabled = false;

	constructor(private readonly hooks: AsyncHooksPrimitives) {}

	private enable(): void {
		if (this.enabled) return;
		this.enabled = true;
		// `enabledStorages` is the shared `HooksAsyncLocalStorage<unknown>[]`; `this` is a
		// subtype of its element type, so it pushes without a cast.
		enabledStorages.push(this);
		if (!propagationHook) {
			// Call `executionAsyncResource` on the held object rather than capturing it as a
			// bare value, which would detach it from its `this` (unbound-method).
			const hooks = this.hooks;
			propagationHook = hooks.createHook({
				init(_asyncId, _type, _triggerAsyncId, resource) {
					// `executionAsyncResource()` is always a non-null object.
					const current = hooks.executionAsyncResource() as StoreCarrier;
					const target = resource as StoreCarrier;
					for (const storage of enabledStorages) {
						target[storage.key] = current[storage.key];
					}
				},
			});
			propagationHook.enable();
		}
	}

	run<R>(store: T, fn: () => R): R {
		// Avoid touching the resource if the store is already active.
		if (Object.is(store, this.getStore())) return fn();

		this.enable();
		const resource = this.hooks.executionAsyncResource() as StoreCarrier;
		const previous = resource[this.key];
		resource[this.key] = store;
		try {
			return fn();
		} finally {
			resource[this.key] = previous;
		}
	}

	getStore(): T | undefined {
		if (!this.enabled) return undefined;
		return (this.hooks.executionAsyncResource() as StoreCarrier)[this.key] as T | undefined;
	}

	enterWith(store: T): void {
		this.enable();
		(this.hooks.executionAsyncResource() as StoreCarrier)[this.key] = store;
	}
}

/**
 * Construct an `AsyncLocalStorage`: `async_hooks`-backed on desktop, synchronous
 * shim otherwise. Callers get a consistent `run`/`getStore`/`enterWith` surface
 * regardless of runtime, and never receive Node's own `AsyncLocalStorage` class.
 */
export function createAsyncLocalStorage<T>(): AsyncLocalStorageLike<T> {
	if (asyncHooks) return new HooksAsyncLocalStorage<T>(asyncHooks);
	return new SyncAsyncLocalStorage<T>();
}
