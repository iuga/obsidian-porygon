import { BaseMessageLike, SystemMessage } from "@langchain/core/messages";
import { Command, MemorySaver } from "@langchain/langgraph";
import { App } from "obsidian";
import { createAgent, dynamicSystemPromptMiddleware } from "langchain";
import { getActiveProvider, resetEmbeddings } from "../providers";
import { RagIndexProgress, RagSemanticSearchService } from "../rag";
import type { PorygonPluginSettings } from "../settings/settings";
import { MemoriesStore } from "./memories";
import { buildSystemPrompt } from "./prompt";
import { SkillsService } from "./skills";
import { AgentLike, AgentTokenUsage, consumeAgentStream, createStreamAccumulator, getPendingAskUserPayloads, readUsageFromState, toLangChainMessage, ToolIntentTracker } from "./streaming";
import { AskUserInterruptPayload, createAgentTools } from "./tools";

export { generateSessionTitle, type SessionTitleAgentOptions } from "./model";
export type { AskUserInterruptPayload } from "./tools";
export type { AgentTokenUsage } from "./streaming";

export type AgentChatRole = "user" | "porygon" | "file";

export interface AgentChatMessage {
	role: AgentChatRole;
	content: string;
}

export interface AgentToolCallIntent {
	id: string;
	name: string;
	intent: string;
}

const agentCheckpointer = new MemorySaver();

// One agent for the whole plugin lifetime. The system prompt is the only
// thing that varies per send (datetime, memories, skills, personal prompt)
// so it's injected via a mutable ref read by dynamicSystemPromptMiddleware.
// Call resetAgent() when provider/model/host/thinking change in settings.
let agent: ReturnType<typeof createAgent> | null = null;
const currentSystemPrompt = { value: "" };

export function resetAgent(): void {
	agent = null;
	// Embeddings client is also provider-scoped; rebuild in lockstep so a
	// settings change can't leave a stale client behind.
	resetEmbeddings();
}

export async function clearAgentMemory(sessionId: string): Promise<void> {
	try {
		await agentCheckpointer.deleteThread(sessionId);
	} catch (error) {
		console.error("Unable to clear Porygon agent memory", sessionId, error);
	}
}

export interface LocalAgentOptions {
	app: App;
	settings: PorygonPluginSettings;
	semanticSearch: RagSemanticSearchService;
	getIndexProgress: () => RagIndexProgress;
	getYolo: () => boolean;
	messages: AgentChatMessage[];
	skills: SkillsService;
	sessionId: string;
	memoriesStore: MemoriesStore;
	signal?: AbortSignal;
}

export interface LocalAgentResponse {
	content: string;
	thinking: string;
	toolIntents: AgentToolCallIntent[];
	usage: AgentTokenUsage | null;
}

export interface LocalAgentStreamHandlers {
	onContentDelta?: (delta: string) => void;
	onThinkingDelta?: (delta: string) => void;
	onToolIntent?: (toolIntent: AgentToolCallIntent) => void;
	onUsage?: (usage: AgentTokenUsage) => void;
	onAskUser?: (payload: AskUserInterruptPayload) => Promise<string> | string;
}

const MAX_INTERRUPT_RESUME_CYCLES = 16;

export async function streamLocalAgent(options: LocalAgentOptions, handlers: LocalAgentStreamHandlers = {}): Promise<LocalAgentResponse> {
	currentSystemPrompt.value = buildSystemPrompt({
		skills: options.skills,
		memoriesStore: options.memoriesStore,
		personalPrompt: options.settings.personalPrompt,
	});

	if (!agent) {
		const provider = getActiveProvider(options.settings);
		agent = createAgent({
			model: provider.createChatModel(options.settings, { thinkingEffort: options.settings.thinkingEffort }),
			tools: createAgentTools(options.app, options.semanticSearch, options.getIndexProgress, options.skills, options.getYolo, options.memoriesStore),
			middleware: [
				dynamicSystemPromptMiddleware(() => new SystemMessage(currentSystemPrompt.value)),
			],
			checkpointer: agentCheckpointer,
		});
	}
	const activeAgent = agent;

	const config = { configurable: { thread_id: options.sessionId }, streamMode: "messages" as const, signal: options.signal };
	const turnMessages = options.messages.map(toLangChainMessage);

	const acc = createStreamAccumulator();
	const tracker = new ToolIntentTracker();

	let nextInput: { messages: BaseMessageLike[] } | Command = { messages: turnMessages };
	for (let cycle = 0; cycle < MAX_INTERRUPT_RESUME_CYCLES; cycle += 1) {
		const stream = await activeAgent.stream(nextInput, config);
		await consumeAgentStream(stream, tracker, acc, handlers);

		// The live `messages` stream drops the usage-bearing final chunk, so
		// pull token counts from the checkpointed state after each pass and
		// surface the freshest reading (input_tokens already includes the
		// full prompt + history + tool results = context-window fill).
		const stateUsage = await readUsageFromState(activeAgent as unknown as AgentLike, config);
		if (stateUsage) {
			acc.usage = stateUsage;
			handlers.onUsage?.(stateUsage);
		}

		const askPayloads = await getPendingAskUserPayloads(activeAgent as unknown as AgentLike, config);
		if (askPayloads.length === 0) {
			return { content: acc.content, thinking: acc.thinking, toolIntents: acc.toolIntents, usage: acc.usage };
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
