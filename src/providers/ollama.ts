import { ChatOllama, OllamaEmbeddings } from "@langchain/ollama";
import { requestUrl } from "obsidian";
import type { ModelInfo, ProviderDefinition } from "./types";

interface OllamaListResponse {
	models: { name: string }[];
}

interface OllamaShowResponse {
	capabilities?: string[];
	details?: { family?: string };
}

async function ollamaGet<T>(host: string, path: string): Promise<T> {
	const baseUrl = host.endsWith("/") ? host.slice(0, -1) : host;
	const response = await requestUrl({ url: `${baseUrl}${path}`, method: "GET", throw: false });
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Ollama request failed: ${response.status}`);
	}

	return response.json as T;
}

async function ollamaPost<T>(host: string, path: string, body: unknown): Promise<{ status: number; json: T }> {
	const baseUrl = host.endsWith("/") ? host.slice(0, -1) : host;
	const response = await requestUrl({
		url: `${baseUrl}${path}`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify(body),
		throw: false,
	});

	return { status: response.status, json: response.json as T };
}

export const ollamaProvider: ProviderDefinition = {
	id: "ollama",
	displayName: "Ollama",

	createChatModel(settings, config) {
		// Ollama's `think` field accepts a boolean or, for graded models like
		// gpt-oss, a "low"|"medium"|"high" string. The langchain types only
		// expose `boolean`, so the graded value is forwarded via a cast.
		const think = config.thinkingEffort === "off" ? false : config.thinkingEffort;
		return new ChatOllama({
			baseUrl: settings.ollamaHost,
			model: settings.ollamaChatModel,
			think: think as boolean,
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

	async showModel(settings, model): Promise<ModelInfo | null> {
		const { status, json } = await ollamaPost<OllamaShowResponse>(settings.ollamaHost, "/api/show", { model });
		if (status < 200 || status >= 300) {
			return null;
		}

		return {
			model,
			capabilities: json.capabilities ?? [],
			details: { family: json.details?.family ?? null },
		};
	},
};
