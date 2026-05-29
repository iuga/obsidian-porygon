import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { Embeddings } from "@langchain/core/embeddings";
import type { PorygonPluginSettings } from "../settings/settings";

export type ProviderId = "ollama";

export interface ChatModelConfig {
	thinking: boolean;
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
}
