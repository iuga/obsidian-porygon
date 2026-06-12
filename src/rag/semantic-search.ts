import type { Embeddings } from "@langchain/core/embeddings";
import { getActiveProvider, getEmbeddings } from "../providers";
import { PorygonPluginSettings } from "../settings/settings";
import { RagRetriever, RagSemanticSearchOptions, RagSemanticSearchResult, RagStore } from "./types";

export const DEFAULT_SEMANTIC_SEARCH_LIMIT = 8;

// Orchestrates semantic search against the RagStore/RagRetriever ports:
// embed the query, delegate ranking to the retriever, hydrate chunks from
// the store. Storage backend and retrieval strategy are swappable without
// touching this class.
export class RagSemanticSearchService {
	private settings: PorygonPluginSettings;
	private store: RagStore;
	private retriever: RagRetriever;

	constructor(settings: PorygonPluginSettings, store: RagStore, retriever: RagRetriever) {
		this.settings = settings;
		this.store = store;
		this.retriever = retriever;
	}

	updateSettings(settings: PorygonPluginSettings): void {
		this.settings = settings;
	}

	async search(options: RagSemanticSearchOptions): Promise<RagSemanticSearchResult[]> {
		const query = options.query.trim();
		const limit = Math.max(1, options.limit ?? DEFAULT_SEMANTIC_SEARCH_LIMIT);
		if (!query || !getActiveProvider(this.settings).isConfigured(this.settings)) {
			console.debug("[Porygon RAG] semantic search skipped", {
				query,
				isConfigured: getActiveProvider(this.settings).isConfigured(this.settings),
			});
			return [];
		}

		console.debug("[Porygon RAG] semantic search", {
			query,
			limit,
			embeddingModel: this.settings.ollamaEmbeddingModel,
		});

		const embeddings = this.getEmbeddingsClient();
		const queryVector = new Float32Array(await embeddings.embedQuery(query));
		const matches = await this.retriever.retrieve({
			text: query,
			vector: queryVector,
			embeddingModel: this.settings.ollamaEmbeddingModel,
			limit,
		});
		if (matches.length === 0) {
			console.debug("[Porygon RAG] semantic search results", {
				query,
				matchCount: 0,
				results: [],
			});
			console.debug(`[Porygon RAG] search "${query}" → 0 results`);
			return [];
		}

		const chunks = await this.store.getChunks(matches.map((match) => match.chunkId));
		const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
		const results = matches.flatMap((match) => {
			const chunk = chunksById.get(match.chunkId);
			if (!chunk) {
				return [];
			}

			return [{
				chunkId: chunk.id,
				path: chunk.path,
				title: chunk.title,
				chunkIndex: chunk.chunkIndex,
				text: chunk.text,
				score: match.score,
			}];
		});
		console.debug("[Porygon RAG] semantic search results", {
			query,
			matchCount: matches.length,
			results: results.map((result) => ({
				path: result.path,
				chunkIndex: result.chunkIndex,
				score: result.score,
				snippet: result.text.slice(0, 200),
			})),
		});
		console.debug(`[Porygon RAG] search "${query}" → ${results.length} results`);
		// eslint-disable-next-line obsidianmd/rule-custom-message -- dev-facing ranking table; console.table has no debug-level equivalent.
		console.table(results.map((result) => ({
			path: result.path,
			i: result.chunkIndex,
			score: result.score.toFixed(4),
			snippet: result.text.slice(0, 80),
		})));
		return results;
	}

	private getEmbeddingsClient(): Embeddings {
		return getEmbeddings(this.settings);
	}
}
