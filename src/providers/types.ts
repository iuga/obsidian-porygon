import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Embeddings } from "@langchain/core/embeddings";
import type { PorygonPluginSettings, ThinkingEffort } from "../settings/settings";

export type ProviderId = "ollama";

export interface ChatModelConfig {
	thinkingEffort: ThinkingEffort;
}

export interface ModelDetails {
	// Model architecture/family, e.g. "gemma3", "llama". Null when unknown.
	family: string | null;
}

export interface ModelInfo {
	// The model name this info was resolved for.
	model: string;
	// Capability flags as reported by the provider, e.g. "completion", "vision".
	capabilities: string[];
	// Normalized subset of provider model details.
	details: ModelDetails;
}

export interface ProviderDefinition {
	id: ProviderId;
	displayName: string;
	createChatModel(settings: PorygonPluginSettings, config: ChatModelConfig): BaseChatModel;
	createEmbeddings(settings: PorygonPluginSettings): Embeddings;
	isConfigured(settings: PorygonPluginSettings): boolean;
	// Stable string that changes whenever the embeddings client needs
	// rebuilding (host/model/auth/etc.). Used by the shared embeddings memo.
	embeddingsFingerprint(settings: PorygonPluginSettings): string;
	// Reachability probe used for status indicators and onboarding.
	checkHealth(settings: PorygonPluginSettings): Promise<boolean>;
	// Available model names, or `null` when the provider can't enumerate them
	// (e.g. a future cloud provider with a fixed catalog handled in the UI).
	listModels(settings: PorygonPluginSettings): Promise<string[] | null>;
	// Model details and capabilities, or `null` when the model is unknown /
	// the provider can't describe it. Never throws for "not found".
	showModel(settings: PorygonPluginSettings, model: string): Promise<ModelInfo | null>;
}
