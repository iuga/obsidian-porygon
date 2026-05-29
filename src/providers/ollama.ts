import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import { requestUrl } from "obsidian";
import type { ProviderDefinition } from "./types";

interface OllamaListResponse {
	models: { name: string }[];
}

async function ollamaGet<T>(host: string, path: string): Promise<T> {
	const baseUrl = host.endsWith("/") ? host.slice(0, -1) : host;
	const response = await requestUrl({ url: `${baseUrl}${path}`, method: "GET", throw: false });
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Ollama request failed: ${response.status}`);
	}

	return response.json as T;
}

export const ollamaProvider: ProviderDefinition = {
	id: "ollama",
	displayName: "Ollama",

	createChatModel(settings, config) {
		return new ChatOllama({
			baseUrl: settings.ollamaHost,
			model: settings.ollamaChatModel,
			think: config.thinking,
			maxRetries: 0,
		});
	},

	createEmbeddings(settings) {
		return new OllamaEmbeddings({
			baseUrl: settings.ollamaHost,
			model: settings.ollamaEmbeddingModel,
		});
	},

	isConfigured(settings) {
		return Boolean(settings.ollamaHost && settings.ollamaEmbeddingModel);
	},

	embeddingsFingerprint(settings) {
		return `${settings.ollamaHost}|${settings.ollamaEmbeddingModel}`;
	},

	async checkHealth(settings) {
		try {
			await ollamaGet<{ version: string }>(settings.ollamaHost, "/api/version");
			return true;
		} catch {
			return false;
		}
	},

	async listModels(settings) {
		const response = await ollamaGet<OllamaListResponse>(settings.ollamaHost, "/api/tags");
		return response.models.map((model) => model.name);
	},
};
