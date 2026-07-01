import { AIMessageChunk, BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import { ToolCallChunk } from "@langchain/core/messages/tool";
import { AskUserInterruptPayload } from "./tools";
import type { AgentChatMessage, AgentToolCallIntent } from "./agent";

const MODEL_NODE_NAME = "model_request";

// ---------- Message helpers (LangChain interop) ----------

export function toLangChainMessage(message: AgentChatMessage): BaseMessageLike {
	return {
		role: message.role === "porygon" || message.role === "file" ? "assistant" : message.role,
		content: message.content,
	};
}

export function toSystemMessage(content: string): BaseMessageLike {
	return {
		role: "system",
		content,
	};
}

export function getMessageText(message: { content: unknown }): string {
	if (typeof message.content === "string") {
		return message.content;
	}

	if (!Array.isArray(message.content)) {
		return "";
	}

	return message.content
		.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "")
		.join("");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------- Stream consumption ----------

export interface StreamHandlers {
	onContentDelta?: (delta: string) => void;
	onThinkingDelta?: (delta: string) => void;
	onToolIntent?: (toolIntent: AgentToolCallIntent) => void;
	onUsage?: (usage: AgentTokenUsage) => void;
}

export interface AgentTokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
}

export interface StreamAccumulator {
	content: string;
	thinking: string;
	toolIntents: AgentToolCallIntent[];
	usage: AgentTokenUsage | null;
}

export function createStreamAccumulator(): StreamAccumulator {
	return { content: "", thinking: "", toolIntents: [], usage: null };
}

// Reusable consumer state for tool-intent reconstruction across one full
// stream (which may span multiple resume cycles for interrupts).
export class ToolIntentTracker {
	private readonly toolCallChunks = new Map<number, ToolCallChunk>();
	private readonly emittedToolCallIds = new Set<string>();

	collect(message: AIMessageChunk): AgentToolCallIntent[] {
		const toolCalls = message.tool_calls ?? [];
		const directToolIntents = toolCalls
			.map((toolCall) => toToolIntent(toolCall.id ?? `${toolCall.name}-${toolIntentsFallbackId(toolCall.args)}`, toolCall.name, toolCall.args))
			.filter((toolIntent): toolIntent is AgentToolCallIntent => toolIntent !== null && !this.emittedToolCallIds.has(toolIntent.id));
		directToolIntents.forEach((toolIntent) => this.emittedToolCallIds.add(toolIntent.id));

		const chunkToolIntents: AgentToolCallIntent[] = [];
		(message.tool_call_chunks ?? []).forEach((chunk) => {
			const index = chunk.index ?? 0;
			const existingChunk = this.toolCallChunks.get(index);
			const mergedChunk: ToolCallChunk = {
				id: `${existingChunk?.id ?? ""}${chunk.id ?? ""}` || undefined,
				name: `${existingChunk?.name ?? ""}${chunk.name ?? ""}` || undefined,
				args: `${existingChunk?.args ?? ""}${chunk.args ?? ""}` || undefined,
				index,
			};
			this.toolCallChunks.set(index, mergedChunk);

			const parsedArgs = parseToolArgs(mergedChunk.args);
			if (!parsedArgs || !mergedChunk.name) {
				return;
			}

			const toolIntent = toToolIntent(mergedChunk.id ?? `${mergedChunk.name}-${index}`, mergedChunk.name, parsedArgs);
			if (!toolIntent || this.emittedToolCallIds.has(toolIntent.id)) {
				return;
			}

			this.emittedToolCallIds.add(toolIntent.id);
			chunkToolIntents.push(toolIntent);
		});

		return [...directToolIntents, ...chunkToolIntents];
	}
}

// Consumes one LangGraph stream pass, updating `acc` and notifying `handlers`.
// Callers loop this across interrupt/resume cycles; `tracker` carries the
// partial-chunk state across passes so split tool-call args still reconcile.
export async function consumeAgentStream(
	stream: AsyncIterable<unknown>,
	tracker: ToolIntentTracker,
	acc: StreamAccumulator,
	handlers: StreamHandlers,
): Promise<void> {
	for await (const chunk of stream) {
		if (!Array.isArray(chunk)) {
			continue;
		}
		const [message, metadata] = chunk as [BaseMessage, { langgraph_node?: string }];
		if (!AIMessageChunk.isInstance(message)) {
			continue;
		}

		if (metadata.langgraph_node !== MODEL_NODE_NAME) {
			continue;
		}

		for (const toolIntent of tracker.collect(message)) {
			acc.toolIntents.push(toolIntent);
			handlers.onToolIntent?.(toolIntent);
		}

		const reasoningDelta = getReasoningDelta(message);
		if (reasoningDelta) {
			acc.thinking += reasoningDelta;
			handlers.onThinkingDelta?.(reasoningDelta);
		}

		const contentDelta = typeof message.content === "string" ? message.content : "";
		if (contentDelta) {
			acc.content += contentDelta;
			handlers.onContentDelta?.(contentDelta);
		}

		// Best-effort: capture usage_metadata if a chunk carries it. Under the
		// `messages` stream mode LangGraph usually drops the final,
		// usage-bearing chunk, so this rarely fires — streamLocalAgent reads
		// the checkpointed state (readUsageFromState) as the reliable source.
		// We still honor it here in case a provider surfaces usage mid-stream.
		const usage = readUsage(message);
		if (usage) {
			acc.usage = usage;
			handlers.onUsage?.(usage);
		}
	}
}

function readUsage(message: AIMessageChunk): AgentTokenUsage | null {
	const usage = message.usage_metadata;
	if (usage) {
		const inputTokens = usage.input_tokens ?? 0;
		const outputTokens = usage.output_tokens ?? 0;
		const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
		if (totalTokens > 0) {
			return { inputTokens, outputTokens, totalTokens };
		}
	}

	// Fallback: LangGraph can drop usage_metadata off the final streamed
	// chunk while preserving Ollama's raw response_metadata, which carries
	// prompt_eval_count (prompt tokens) and eval_count (generated tokens).
	const responseMeta = message.response_metadata as Record<string, unknown> | undefined;
	if (responseMeta) {
		const inputTokens = typeof responseMeta.prompt_eval_count === "number" ? responseMeta.prompt_eval_count : 0;
		const outputTokens = typeof responseMeta.eval_count === "number" ? responseMeta.eval_count : 0;
		const totalTokens = inputTokens + outputTokens;
		if (totalTokens > 0) {
			return { inputTokens, outputTokens, totalTokens };
		}
	}

	return null;
}

function toToolIntent(id: string, name: string, args: Record<string, unknown>): AgentToolCallIntent | null {
	const intent = args.intent;
	return typeof intent === "string" && intent.trim() ? { id, name, intent: intent.trim() } : null;
}

function parseToolArgs(args: string | undefined): Record<string, unknown> | null {
	if (!args) {
		return null;
	}

	try {
		const parsedArgs: unknown = JSON.parse(args);
		return isRecord(parsedArgs) ? parsedArgs : null;
	} catch {
		return null;
	}
}

function toolIntentsFallbackId(args: Record<string, unknown>): string {
	return JSON.stringify(args);
}

function getReasoningDelta(message: AIMessageChunk): string {
	const reasoning = message.additional_kwargs?.reasoning_content;
	return typeof reasoning === "string" ? reasoning : "";
}

// ---------- Interrupt / ask-user resume cycle ----------

export interface PendingAskUser {
	id: string;
	payload: AskUserInterruptPayload;
}

export interface AgentLike {
	getState: (config: unknown) => Promise<{
		values?: { messages?: unknown[] };
		tasks?: Array<{ interrupts?: Array<{ id?: string; value?: unknown }> }>;
	}>;
}

// The `messages` stream mode drops the final, empty-content chunk that
// carries usage_metadata, so live streaming never sees token counts. The
// checkpointed state, however, stores the fully-merged AI messages with
// their usage_metadata intact. We read the most recent AI message that has
// a usable token count — that call's input_tokens already accounts for the
// whole prompt + history + tool results, i.e. current context-window fill.
export async function readUsageFromState(agent: AgentLike, config: unknown): Promise<AgentTokenUsage | null> {
	try {
		const state = await agent.getState(config);
		const values = state.values ?? {};
		const messages = Array.isArray(values.messages) ? values.messages : [];
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const candidate = messages[i];
			if (!AIMessageChunk.isInstance(candidate as BaseMessage) && !isAIMessageLike(candidate)) {
				continue;
			}
			const usage = readUsage(candidate as AIMessageChunk);
			if (usage) {
				return usage;
			}
		}
	} catch (error) {
		console.error("Unable to read token usage from agent state", error);
	}
	return null;
}

function isAIMessageLike(value: unknown): value is AIMessageChunk {
	if (!isRecord(value)) {
		return false;
	}
	return "usage_metadata" in value || "response_metadata" in value;
}

export async function getPendingAskUserPayloads(agent: AgentLike, config: unknown): Promise<PendingAskUser[]> {
	const state = await agent.getState(config);
	const pending: PendingAskUser[] = [];
	for (const task of state.tasks ?? []) {
		for (const interruptEntry of task.interrupts ?? []) {
			const payload = normalizeAskUserPayload(interruptEntry.value);
			if (payload && typeof interruptEntry.id === "string") {
				pending.push({ id: interruptEntry.id, payload });
			}
		}
	}
	return pending;
}

export function normalizeAskUserPayload(value: unknown): AskUserInterruptPayload | null {
	if (!isRecord(value)) {
		return null;
	}
	const { question, options } = value as { question?: unknown; options?: unknown };
	if (typeof question !== "string" || !Array.isArray(options)) {
		return null;
	}
	const stringOptions = options.filter((option): option is string => typeof option === "string");
	if (stringOptions.length < 2) {
		return null;
	}
	// Defensive cap: ignore extra options beyond the first 4 instead of failing.
	return { question, options: stringOptions.slice(0, 4) };
}
