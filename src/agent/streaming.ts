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
}

export interface StreamAccumulator {
	content: string;
	thinking: string;
	toolIntents: AgentToolCallIntent[];
}

export function createStreamAccumulator(): StreamAccumulator {
	return { content: "", thinking: "", toolIntents: [] };
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
	}
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
	getState: (config: unknown) => Promise<{ tasks?: Array<{ interrupts?: Array<{ id?: string; value?: unknown }> }> }>;
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
