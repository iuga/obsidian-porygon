import defaultPersonalPrompt from "../prompts/personal.md";

export interface PorygonPluginSettings {
	ollamaHost: string;
	ollamaChatModel: string;
	ollamaEmbeddingModel: string;
	ollamaThinking: boolean;
	showToolUsage: boolean;
	ragIgnoredPaths: string;
	personalPrompt: string;
}

export interface LegacyPorygonPluginSettings extends Partial<PorygonPluginSettings> {
	chatSystemPrompt?: string;
	ragDatabasePath?: string;
}

export const DEFAULT_PERSONAL_PROMPT = defaultPersonalPrompt.trim();

export const DEFAULT_SETTINGS: PorygonPluginSettings = {
	ollamaHost: "",
	ollamaChatModel: "",
	ollamaEmbeddingModel: "",
	ollamaThinking: false,
	showToolUsage: false,
	ragIgnoredPaths: "",
	personalPrompt: DEFAULT_PERSONAL_PROMPT,
};

export const ONBOARDING_DEFAULTS: PorygonPluginSettings = {
	ollamaHost: "http://localhost:11434",
	ollamaChatModel: "gemma4",
	ollamaEmbeddingModel: "nomic-embed-text",
	ollamaThinking: false,
	showToolUsage: false,
	ragIgnoredPaths: "",
	personalPrompt: DEFAULT_PERSONAL_PROMPT,
};
