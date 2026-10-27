import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { createAsyncLocalStorage } from "../utils/async-local-storage";

/**
 * Wires @langchain/core's global `AsyncLocalStorage` singleton to our
 * `async_hooks`-backed instance (see `../utils/async-local-storage.ts` for why
 * it is never Node's own `AsyncLocalStorage` class — that one crashes the
 * renderer on Node 24+ / current Electron).
 *
 * Why this is needed:
 * LangGraph threads the active `RunnableConfig` through nested runs via this
 * singleton — most importantly the `interrupt()` / `ask_user` hitl path, which
 * pauses the graph, surfaces to the UI, and resumes via `Command({ resume })`.
 * Without a real propagation store the singleton falls back to a no-op mock, a
 * nested run can't see the parent's config, and the interrupt can't locate its
 * thread checkpoint — so `ask_user` / the destructive-action approval prompts
 * stop working.
 *
 * Initialize it here once, at plugin load, before any agent stream runs.
 * `initializeGlobalInstance` is a no-op if another instance was already set, so
 * this is idempotent and safe to run first.
 */
export function initLangGraphAsyncContext(): void {
	try {
		AsyncLocalStorageProviderSingleton.initializeGlobalInstance(createAsyncLocalStorage<unknown>());
	} catch (error) {
		console.error("[Porygon] failed to initialize LangGraph async context", error);
	}
}
