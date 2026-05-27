import { AIMessageChunk, BaseMessage, BaseMessageLike, SystemMessage } from "@langchain/core/messages";
import { ToolCallChunk } from "@langchain/core/messages/tool";
import { Command, MemorySaver } from "@langchain/langgraph";
import { ChatOllama } from "@langchain/ollama";
import { App, Platform } from "obsidian";
import { createAgent, dynamicSystemPromptMiddleware } from "langchain";
import defaultSystemPrompt from "../prompts/system.md";
import { RagIndexProgress, RagSemanticSearchService } from "./rag";
import { buildAvailableSkillsPrompt, SkillsService } from "./skills";
import { buildMemoryPromptBlock, MemoriesStore } from "./memories";
import { AskUserInterruptPayload, createAgentTools } from "./tools";

export type { AskUserInterruptPayload };

const agentCheckpointer = new MemorySaver();

// One agent for the whole plugin lifetime. The system prompt is the only
// thing that varies per send (datetime, memories, skills, personal prompt)
// so it's injected via a mutable ref read by dynamicSystemPromptMiddleware.
// Call resetAgent() if the user changes host/model/thinking in settings.
let agent: ReturnType<typeof createAgent> | null = null;
const currentSystemPrompt = { value: "" };

export function resetAgent(): void {
	agent = null;
}

export async function clearAgentMemory(sessionId: string): Promise<void> {
	try {
		await agentCheckpointer.deleteThread(sessionId);
	} catch (error) {
		console.error("Unable to clear Porygon agent memory", sessionId, error);
	}
}

export type AgentChatRole = "user" | "porygon" | "file";

export interface AgentChatMessage {
	role: AgentChatRole;
	content: string;
}

export interface LocalAgentOptions {
	app: App;
	semanticSearch: RagSemanticSearchService;
	getIndexProgress: () => RagIndexProgress;
	getYolo: () => boolean;
	ollamaHost: string;
	ollamaChatModel: string;
	ollamaThinking: boolean;
	personalPrompt: string;
	messages: AgentChatMessage[];
	skills: SkillsService;
	sessionId: string;
	memoriesStore: MemoriesStore;
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
	onAskUser?: (payload: AskUserInterruptPayload) => Promise<string> | string;
}

export interface SessionTitleAgentOptions {
	ollamaHost: string;
	ollamaChatModel: string;
	userMessages: string[];
}

const MODEL_NODE_NAME = "model_request";
const MAX_INTERRUPT_RESUME_CYCLES = 16;
const DEFAULT_SYSTEM_PROMPT = defaultSystemPrompt.trim();
const SESSION_TITLE_SYSTEM_PROMPT = "Generate a short, concise title (max 6 words) for a conversation that starts with this message. Return ONLY the title, nothing else. Use the user's initial message as context when generating your response.";

export async function streamLocalAgent(options: LocalAgentOptions, handlers: LocalAgentStreamHandlers = {}): Promise<LocalAgentResponse> {
	const defaultPrompt = DEFAULT_SYSTEM_PROMPT;
	const skillsPrompt = buildAvailableSkillsPrompt(options.skills.getSkills());
	const contextPrompt = buildContextPromptBlock();
	const memoryPrompt = buildMemoryPromptBlock(options.memoriesStore.get());
	const personalPrompt = options.personalPrompt.trim();
	currentSystemPrompt.value = [defaultPrompt, skillsPrompt, contextPrompt, memoryPrompt, personalPrompt].filter(Boolean).join("\n\n");

	if (!agent) {
		agent = createAgent({
			model: new ChatOllama({
				baseUrl: options.ollamaHost,
				model: options.ollamaChatModel,
				think: options.ollamaThinking,
				maxRetries: 0,
			}),
			tools: createAgentTools(options.app, options.semanticSearch, options.getIndexProgress, options.skills, options.getYolo, options.memoriesStore),
			middleware: [
				dynamicSystemPromptMiddleware(() => new SystemMessage(currentSystemPrompt.value)),
			],
			checkpointer: agentCheckpointer,
		});
	}
	const activeAgent = agent;

	const config = { configurable: { thread_id: options.sessionId }, streamMode: "messages" as const };
	const turnMessages = options.messages.map(toLangChainMessage);

	let content = "";
	let thinking = "";
	const toolIntents: AgentToolCallIntent[] = [];
	const toolCallChunks = new Map<number, ToolCallChunk>();
	const emittedToolCallIds = new Set<string>();

	let nextInput: { messages: BaseMessageLike[] } | Command = { messages: turnMessages };
	for (let cycle = 0; cycle < MAX_INTERRUPT_RESUME_CYCLES; cycle += 1) {
		const stream = await activeAgent.stream(nextInput, config);
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

		const askPayloads = await getPendingAskUserPayloads(activeAgent, config);
		if (askPayloads.length === 0) {
			return { content, thinking, toolIntents };
		}

		if (!handlers.onAskUser) {
			throw new Error("Agent requested user input but no askUser handler was provided.");
		}

		// Resume each pending interrupt sequentially with the user's reply.
		// LangGraph stores the resume map keyed by interrupt id; we collect
		// them all so multiple interrupts in one turn don't get dropped.
		const resumeMap: Record<string, string> = {};
		for (const { id, payload } of askPayloads) {
			resumeMap[id] = await handlers.onAskUser(payload);
		}
		nextInput = new Command({ resume: resumeMap });
	}

	throw new Error(`Agent exceeded ${MAX_INTERRUPT_RESUME_CYCLES} interrupt/resume cycles in a single turn.`);
}

interface AgentLike {
	getState: (config: unknown) => Promise<{ tasks?: Array<{ interrupts?: Array<{ id?: string; value?: unknown }> }> }>;
}

interface PendingAskUser {
	id: string;
	payload: AskUserInterruptPayload;
}

async function getPendingAskUserPayloads(agent: AgentLike, config: unknown): Promise<PendingAskUser[]> {
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

function normalizeAskUserPayload(value: unknown): AskUserInterruptPayload | null {
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

function buildContextPromptBlock(): string {
	const now = new Date();
	const datetimeUtc = now.toISOString();
	const datetimeLocal = formatLocalDatetime(now);
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
	const currentOs = detectOs();
	return `<context>\n- datetime: ${datetimeLocal}\n- datetime_utc: ${datetimeUtc}\n- tz: ${timezone}\n- os: ${currentOs}\n</context>`;
}

function formatLocalDatetime(date: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	const absOffset = Math.abs(offsetMinutes);
	const offset = `${offsetSign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

function detectOs(): string {
	if (Platform.isMacOS) return "macos";
	if (Platform.isWin) return "windows";
	if (Platform.isLinux) return "linux";
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	return "unknown";
}
