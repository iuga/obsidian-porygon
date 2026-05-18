import { AIMessageChunk, BaseMessageLike } from "@langchain/core/messages";
import { ToolCallChunk } from "@langchain/core/messages/tool";
import { ChatOllama } from "@langchain/ollama";
import { App } from "obsidian";
import { createAgent } from "langchain";
import defaultSystemPrompt from "../prompts/system.md";
import { RagIndexProgress, RagSemanticSearchService } from "./rag";
import { createAgentTools } from "./tools";

export type AgentChatRole = "user" | "porygon" | "file";

export interface AgentChatMessage {
	role: AgentChatRole;
	content: string;
}

export interface LocalAgentOptions {
	app: App;
	semanticSearch: RagSemanticSearchService;
	getIndexProgress: () => RagIndexProgress;
	ollamaHost: string;
	ollamaChatModel: string;
	ollamaThinking: boolean;
	personalPrompt: string;
	messages: AgentChatMessage[];
}

export interface AgentToolCallIntent {
	id: string;
	name: string;
	intent: string;
}

export interface LocalAgentResponse {
	content: string;
	thinking: string;
	toolIntents: AgentToolCallIntent[];
}

export interface LocalAgentStreamHandlers {
	onContentDelta?: (delta: string) => void;
	onThinkingDelta?: (delta: string) => void;
	onToolIntent?: (toolIntent: AgentToolCallIntent) => void;
}

export interface SessionTitleAgentOptions {
	ollamaHost: string;
	ollamaChatModel: string;
	userMessages: string[];
}

const MODEL_NODE_NAME = "model_request";
const DEFAULT_SYSTEM_PROMPT = defaultSystemPrompt.trim();
const SESSION_TITLE_SYSTEM_PROMPT = "Generate a short, concise title (max 6 words) for a conversation that starts with this message. Return ONLY the title, nothing else. Use the user's initial message as context when generating your response.";

export async function streamLocalAgent(options: LocalAgentOptions, handlers: LocalAgentStreamHandlers = {}): Promise<LocalAgentResponse> {
	const agent = createAgent({
		model: new ChatOllama({
			baseUrl: options.ollamaHost,
			model: options.ollamaChatModel,
			think: options.ollamaThinking,
			maxRetries: 0,
		}),
		tools: createAgentTools(options.app, options.semanticSearch, options.getIndexProgress),
		systemPrompt: DEFAULT_SYSTEM_PROMPT,
	});

	const stream = await agent.stream(
		{ messages: [toSystemMessage(options.personalPrompt), ...options.messages.map(toLangChainMessage)] },
		{ streamMode: "messages" },
	);

	let content = "";
	let thinking = "";
	const toolIntents: AgentToolCallIntent[] = [];
	const toolCallChunks = new Map<number, ToolCallChunk>();
	const emittedToolCallIds = new Set<string>();

	for await (const [message, metadata] of stream) {
		if (!AIMessageChunk.isInstance(message)) {
			continue;
		}

		if ((metadata as { langgraph_node?: string }).langgraph_node !== MODEL_NODE_NAME) {
			continue;
		}

		for (const toolIntent of getToolIntents(message, toolCallChunks, emittedToolCallIds)) {
			toolIntents.push(toolIntent);
			handlers.onToolIntent?.(toolIntent);
		}

		const reasoningDelta = getReasoningDelta(message);
		if (reasoningDelta) {
			thinking += reasoningDelta;
			handlers.onThinkingDelta?.(reasoningDelta);
		}

		const contentDelta = typeof message.content === "string" ? message.content : "";
		if (contentDelta) {
			content += contentDelta;
			handlers.onContentDelta?.(contentDelta);
		}
	}

	return { content, thinking, toolIntents };
}

export async function generateSessionTitle(options: SessionTitleAgentOptions): Promise<string> {
	const model = new ChatOllama({
		baseUrl: options.ollamaHost,
		model: options.ollamaChatModel,
		think: false,
		maxRetries: 0,
	});
	const response = await model.invoke([
		toSystemMessage(SESSION_TITLE_SYSTEM_PROMPT),
		{ role: "user", content: options.userMessages.join("\n\n") },
	]);
	return getMessageText(response).trim();
}

function getToolIntents(message: AIMessageChunk, toolCallChunks: Map<number, ToolCallChunk>, emittedToolCallIds: Set<string>): AgentToolCallIntent[] {
	const toolCalls = message.tool_calls ?? [];
	const directToolIntents = toolCalls
		.map((toolCall) => toToolIntent(toolCall.id ?? `${toolCall.name}-${toolIntentsFallbackId(toolCall.args)}`, toolCall.name, toolCall.args))
		.filter((toolIntent): toolIntent is AgentToolCallIntent => toolIntent !== null && !emittedToolCallIds.has(toolIntent.id));
	directToolIntents.forEach((toolIntent) => emittedToolCallIds.add(toolIntent.id));

	const chunkToolIntents: AgentToolCallIntent[] = [];
	(message.tool_call_chunks ?? []).forEach((chunk) => {
		const index = chunk.index ?? 0;
		const existingChunk = toolCallChunks.get(index);
		const mergedChunk: ToolCallChunk = {
			id: `${existingChunk?.id ?? ""}${chunk.id ?? ""}` || undefined,
			name: `${existingChunk?.name ?? ""}${chunk.name ?? ""}` || undefined,
			args: `${existingChunk?.args ?? ""}${chunk.args ?? ""}` || undefined,
			index,
		};
		toolCallChunks.set(index, mergedChunk);

		const parsedArgs = parseToolArgs(mergedChunk.args);
		if (!parsedArgs || !mergedChunk.name) {
			return;
		}

		const toolIntent = toToolIntent(mergedChunk.id ?? `${mergedChunk.name}-${index}`, mergedChunk.name, parsedArgs);
		if (!toolIntent || emittedToolCallIds.has(toolIntent.id)) {
			return;
		}

		emittedToolCallIds.add(toolIntent.id);
		chunkToolIntents.push(toolIntent);
	});

	return [...directToolIntents, ...chunkToolIntents];
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getReasoningDelta(message: AIMessageChunk): string {
	const reasoning = message.additional_kwargs?.reasoning_content;
	return typeof reasoning === "string" ? reasoning : "";
}

function getMessageText(message: { content: unknown }): string {
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

function toSystemMessage(content: string): BaseMessageLike {
	return {
		role: "system",
		content,
	};
}

function toLangChainMessage(message: AgentChatMessage): BaseMessageLike {
	return {
		role: message.role === "porygon" || message.role === "file" ? "assistant" : message.role,
		content: message.content,
	};
}
