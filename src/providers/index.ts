import type { Embeddings } from "@langchain/core/embeddings";
import type { PorygonPluginSettings } from "../settings/settings";
import { ollamaProvider } from "./ollama";
import type { ProviderDefinition, ProviderId } from "./types";

export type { ChatModelConfig, ProviderDefinition, ProviderId } from "./types";

// Single source of truth for which providers exist. Only ONE provider is
// active at any moment — `getActiveProvider` resolves it from settings.
const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
	ollama: ollamaProvider,
};

// Today there's only one provider. When a second is added, this will read
// a discriminator from settings (e.g. `settings.provider`) and return the
// matching entry, while the rest of the codebase keeps calling
// `getActiveProvider(settings)` unchanged.
export function getActiveProviderId(_settings: PorygonPluginSettings): ProviderId {
	return "ollama";
}

export function getActiveProvider(settings: PorygonPluginSettings): ProviderDefinition {
	return PROVIDERS[getActiveProviderId(settings)];
}

// Single live embeddings client shared by every consumer (RAG indexer +
// semantic search). Rebuilt only when the active provider OR its embeddings
// fingerprint changes, which enforces the "one provider at a time" invariant
// at the runtime instance level.
let currentEmbeddings: { providerId: ProviderId; fingerprint: string; client: Embeddings } | null = null;

export function getEmbeddings(settings: PorygonPluginSettings): Embeddings {
	const provider = getActiveProvider(settings);
	const fingerprint = provider.embeddingsFingerprint(settings);
	if (currentEmbeddings && currentEmbeddings.providerId === provider.id && currentEmbeddings.fingerprint === fingerprint) {
		return currentEmbeddings.client;
	}

	const client = provider.createEmbeddings(settings);
	currentEmbeddings = { providerId: provider.id, fingerprint, client };
	return client;
}

export function resetEmbeddings(): void {
	currentEmbeddings = null;
}
