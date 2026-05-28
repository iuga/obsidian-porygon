export interface OllamaModel {
	name: string;
}

export interface OllamaListResponse {
	models: OllamaModel[];
}

export interface OllamaVersionResponse {
	version: string;
}

import { requestUrl } from "obsidian";

export class OllamaHttpClient {
	constructor(private readonly host: string) {}

	async version(): Promise<OllamaVersionResponse> {
		return this.get<OllamaVersionResponse>("/api/version");
	}

	async list(): Promise<OllamaListResponse> {
		return this.get<OllamaListResponse>("/api/tags");
	}

	private async get<T>(path: string): Promise<T> {
		const baseUrl = this.host.endsWith("/") ? this.host.slice(0, -1) : this.host;
		const response = await requestUrl({ url: `${baseUrl}${path}`, method: "GET", throw: false });
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`Ollama request failed: ${response.status}`);
		}

		return response.json as T;
	}
}
