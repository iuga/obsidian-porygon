import { isGraphBubbleUp } from "@langchain/langgraph";
import { createMiddleware } from "langchain";
import type { App } from "obsidian";
import { getToolExecutionObserver, type ToolExecutionEvent } from "./tool-events";
import { withToolLocks } from "./tool-locks";
import { getToolCallTargets, type VaultTargetLookup } from "./tool-targets";
import { normalizeMarkdownPath, normalizeNoteReference, resolveMarkdownFile } from "./tools/shared";

function logToolTiming(message: string): void {
	// Temporary trace for verifying concurrent tool execution.
	console.debug(message);
}

// Resolved per event, never captured: the middleware is built once with the
// cached agent, while the observer is installed fresh by each turn.
function emitToolExecution(event: ToolExecutionEvent): void {
	getToolExecutionObserver()?.onToolExecution(event);
}

/**
 * Serializes tool calls that touch the same note (or the whole vault) while
 * letting independent calls run concurrently.
 *
 * The lock targets are computed by `tool-targets.ts` and enforced by
 * `tool-locks.ts`; this file only adapts Obsidian's vault API and LangChain's
 * middleware contract.
 *
 * Why a middleware: the prompt already tells the model not to batch
 * conflicting calls, but prompts are best-effort. Enforcing the invariant in
 * the tool pipeline means a model that ignores the guidance still cannot
 * corrupt a note or lose a memory write.
 */
export function createToolConcurrencyMiddleware(app: App) {
	// Resolve through the vault so every spelling of a note ("A", "A.md",
	// "[[A|alias]]", "A#heading", or a bare basename that Obsidian resolves to
	// a nested path) maps to one canonical key.
	const lookup: VaultTargetLookup = {
		existingNotePath: (input) => resolveMarkdownFile(app, input)?.path ?? null,
		prospectiveNotePath: (input) => normalizeMarkdownPath(normalizeNoteReference(input)),
	};

	return createMiddleware({
		name: "PorygonToolTargetSerialization",
		wrapToolCall: async (request, handler) => {
			const { name, id } = request.toolCall;
			const targets = getToolCallTargets(lookup, name, request.toolCall.args);
			const requestedAt = performance.now();
			const execute = async () => {
				const startedAt = performance.now();
				const waitedMs = Math.round(startedAt - requestedAt);
				const targetSummary = targets.exclusive
					? " lock=structural"
					: targets.keys.length > 0
						? ` targets=[${targets.keys.join(", ")}]`
						: "";
				logToolTiming(
					`[Porygon Tools] start ${name} id=${id}${targetSummary}${waitedMs > 0 ? ` waited=${waitedMs}ms` : ""}`,
				);

				// Timer starts here, after tool-lock acquisition, so queue wait
				// is never counted as execution time.
				emitToolExecution({ id: id ?? "", name, phase: "start", at: startedAt });

				let status: "ok" | "error" | "interrupted" = "ok";
				try {
					return await handler(request);
				} catch (error) {
					status = isGraphBubbleUp(error) ? "interrupted" : "error";
					throw error;
				} finally {
					const durationMs = Math.round(performance.now() - startedAt);
					logToolTiming(`[Porygon Tools] finish ${name} id=${id} status=${status} duration=${durationMs}ms`);
					if (status === "interrupted") {
						// Paused for approval / ask_user. The call re-runs from the
						// top on resume, which emits a fresh `start`.
						emitToolExecution({ id: id ?? "", name, phase: "interrupted", at: performance.now() });
					} else {
						emitToolExecution({ id: id ?? "", name, phase: "finish", at: performance.now(), durationMs });
					}
				}
			};

			// `runtime.signal` is the run's abort signal (user pressed stop, or the
			// turn was superseded). Passing it through keeps a queued tool call from
			// running its mutation after cancellation.
			return withToolLocks(targets, execute, request.runtime?.signal);
		},
	});
}
