/**
 * Tool execution lifecycle events.
 *
 * `onToolIntent` (streaming.ts) fires while the model is still streaming the
 * tool-call arguments, i.e. before anything runs. These events come from the
 * tool middleware and describe the actual execution window:
 *
 *   start       the tool body began running (after tool-lock acquisition)
 *   finish      the tool body returned/raised normally, with durationMs
 *   interrupted the tool paused for user input (approval / ask_user); the
 *               call is re-run from the top after resume, so the UI drops
 *               the live timer and restarts it on the next `start`
 *
 * Kept free of Obsidian/LangChain imports so it can be unit tested.
 */

export type ToolExecutionPhase = "start" | "finish" | "interrupted";

export interface ToolExecutionEvent {
	id: string;
	name: string;
	phase: ToolExecutionPhase;
	at: number;
	durationMs?: number;
}

export interface ToolExecutionObserver {
	onToolExecution: (event: ToolExecutionEvent) => void;
}

// Timing fields carried on the chat-side tool intent. Transient: intents are
// never serialized into session files.
export interface ToolExecutionTimingState {
	id: string;
	name: string;
	executionStartedAt?: number;
	durationMs?: number;
	isExecuting?: boolean;
}

// The plugin runs one agent turn at a time, so a single mutable observer is
// enough. The middleware resolves it at event time because the agent (and its
// middleware) is built once and reused across turns.
let currentObserver: ToolExecutionObserver | null = null;

export function setToolExecutionObserver(observer: ToolExecutionObserver | null): void {
	currentObserver = observer;
}

/**
 * Clears the observer only if it is still the one that installed it. A
 * superseded turn must not tear down the observer of the turn that replaced it.
 */
export function clearToolExecutionObserver(observer: ToolExecutionObserver): void {
	if (currentObserver === observer) {
		currentObserver = null;
	}
}

export function getToolExecutionObserver(): ToolExecutionObserver | null {
	return currentObserver;
}

/**
 * Applies one lifecycle event to the matching intent in place and returns it,
 * or null when no intent matches.
 *
 * Matching prefers the tool-call id. When the event carries no id (providers
 * that omit ids, matching the tracker's synthesized ids), it falls back to
 * name: `start` claims the first same-named intent with no execution state,
 * while `finish`/`interrupted` prefer the currently executing one. An unknown
 * non-empty id never falls back, so a tool abandoned by a superseded turn
 * cannot overwrite a same-named tool in the current one.
 */
export function applyToolExecution<T extends ToolExecutionTimingState>(intents: readonly T[] | undefined, event: ToolExecutionEvent): T | null {
	if (!intents || intents.length === 0) {
		return null;
	}

	const byId = event.id ? intents.find((intent) => intent.id === event.id) : undefined;
	const intent = byId ?? (event.id ? null : findIntentByName(intents, event));
	if (!intent) {
		return null;
	}

	if (event.phase === "start") {
		intent.isExecuting = true;
		intent.executionStartedAt = event.at;
		intent.durationMs = undefined;
		return intent;
	}

	if (event.phase === "interrupted") {
		// Discard the paused attempt: the resumed run is timed from scratch so
		// the user's decision time never counts as tool execution time.
		intent.isExecuting = false;
		intent.executionStartedAt = undefined;
		intent.durationMs = undefined;
		return intent;
	}

	intent.isExecuting = false;
	intent.durationMs = event.durationMs ?? (intent.executionStartedAt !== undefined ? Math.max(0, event.at - intent.executionStartedAt) : 0);
	intent.executionStartedAt = undefined;
	return intent;
}

function findIntentByName<T extends ToolExecutionTimingState>(intents: readonly T[], event: ToolExecutionEvent): T | null {
	const candidates = intents.filter((intent) => intent.name === event.name);
	if (event.phase === "start") {
		return candidates.find((intent) => !intent.isExecuting && intent.executionStartedAt === undefined) ?? null;
	}
	return candidates.find((intent) => intent.isExecuting)
		?? candidates.find((intent) => intent.executionStartedAt !== undefined && intent.durationMs === undefined)
		?? null;
}
