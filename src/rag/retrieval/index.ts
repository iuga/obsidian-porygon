import type { PorygonPluginSettings } from "../../settings/settings";
import type { RagRetriever, RagStore } from "../types";
import { CosineBruteForceRetriever } from "./cosine-bruteforce";

export { CosineBruteForceRetriever, cosineSimilarity } from "./cosine-bruteforce";

export type RagRetrievalStrategyId = "cosine";

export interface RagRetrievalDefinition {
	id: RagRetrievalStrategyId;
	name: string;
	// Strategies that require store capabilities (e.g. a future "store-native"
	// strategy needing store.searchVectors) declare it here so the factory can
	// fall back to a compatible strategy instead of failing at query time.
	isCompatible(store: RagStore): boolean;
	create(store: RagStore, settings: PorygonPluginSettings): RagRetriever;
}

const STRATEGIES: Record<RagRetrievalStrategyId, RagRetrievalDefinition> = {
	cosine: {
		id: "cosine",
		name: "Cosine similarity (exact)",
		isCompatible: () => true,
		create: (store) => new CosineBruteForceRetriever(store),
	},
};

export const DEFAULT_RAG_RETRIEVAL_STRATEGY: RagRetrievalStrategyId = "cosine";

export function getRagRetrievalDefinitions(): RagRetrievalDefinition[] {
	return Object.values(STRATEGIES);
}

export function createRagRetriever(settings: PorygonPluginSettings, store: RagStore): RagRetriever {
	const requested = STRATEGIES[settings.ragRetrievalStrategy] ?? STRATEGIES[DEFAULT_RAG_RETRIEVAL_STRATEGY];
	const definition = requested.isCompatible(store) ? requested : STRATEGIES[DEFAULT_RAG_RETRIEVAL_STRATEGY];
	return definition.create(store, settings);
}
