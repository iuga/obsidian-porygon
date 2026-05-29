import type { Embeddings } from "@langchain/core/embeddings";
import { getActiveProvider, getEmbeddings } from "../providers";
import { PorygonPluginSettings } from "../settings/settings";
import { arrayBufferToFloat32Array, RagIndexedDbStore } from "./indexeddb-store";
import { RagSemanticSearchOptions, RagSemanticSearchResult } from "./types";

export const DEFAULT_SEMANTIC_SEARCH_LIMIT = 8;

export class RagSemanticSearchService {
	private settings: PorygonPluginSettings;
	private store: RagIndexedDbStore;

	constructor(settings: PorygonPluginSettings, store: RagIndexedDbStore) {
		this.settings = settings;
		this.store = store;
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

		const vectors = await this.store.getVectorsForEmbeddingModel(this.settings.ollamaEmbeddingModel);
		if (vectors.length === 0) {
			console.debug("[Porygon RAG] semantic search results", {
				query,
				vectorCount: 0,
				results: [],
			});
			return [];
		}

		const embeddings = this.getEmbeddingsClient();
		const queryVector = new Float32Array(await embeddings.embedQuery(query));
		const scored = vectors
			.map((vector) => ({
				chunkId: vector.chunkId,
				score: cosineSimilarity(queryVector, arrayBufferToFloat32Array(vector.vector)),
			}))
			.filter((result) => Number.isFinite(result.score))
			.sort((left, right) => right.score - left.score)
			.slice(0, limit);

		const chunks = await this.store.getChunks(scored.map((result) => result.chunkId));
		const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
		const results = scored.flatMap((result) => {
			const chunk = chunksById.get(result.chunkId);
			if (!chunk) {
				return [];
			}

			return [{
				chunkId: chunk.id,
				path: chunk.path,
				title: chunk.title,
				chunkIndex: chunk.chunkIndex,
				text: chunk.text,
				score: result.score,
			}];
		});
		console.debug("[Porygon RAG] semantic search results", {
			query,
			vectorCount: vectors.length,
			results: results.map((result) => ({
				path: result.path,
				chunkIndex: result.chunkIndex,
				score: result.score,
				snippet: result.text.slice(0, 200),
			})),
		});
		return results;
	}

	private getEmbeddingsClient(): Embeddings {
		return getEmbeddings(this.settings);
	}
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
	if (left.length === 0 || left.length !== right.length) {
		return Number.NEGATIVE_INFINITY;
	}

	let dotProduct = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index++) {
		const leftValue = left[index] ?? 0;
		const rightValue = right[index] ?? 0;
		dotProduct += leftValue * rightValue;
		leftMagnitude += leftValue * leftValue;
		rightMagnitude += rightValue * rightValue;
	}

	if (leftMagnitude === 0 || rightMagnitude === 0) {
		return Number.NEGATIVE_INFINITY;
	}

	return dotProduct / Math.sqrt(leftMagnitude * rightMagnitude);
}
