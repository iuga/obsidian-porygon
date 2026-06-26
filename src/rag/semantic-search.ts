import { AnyOrama, create, insertMultiple, search } from "@orama/orama";
import type { Embeddings } from "@langchain/core/embeddings";
import { getActiveProvider, getEmbeddings } from "../providers";
import { PorygonPluginSettings } from "../settings/settings";
import { arrayBufferToFloat32Array, RagIndexedDbStore } from "./indexeddb-store";
import { RagChunkRecord, RagSemanticSearchOptions, RagSemanticSearchResult, RagVectorRecord } from "./types";

export const DEFAULT_SEARCH_LIMIT = 8;

// Minimum cosine similarity for a chunk to enter the vector candidate set
// (Orama defaults to 0.8, which silently drops semantically-relevant chunks).
// A low floor of 0.4 trims obvious noise while letting hybrid ranking and the
// caller's `limit` decide the final top results.
const HYBRID_SIMILARITY_THRESHOLD = 0.4;

interface OramaDocument {
	chunkId: string;
	path: string;
	title: string;
	text: string;
	chunkIndex: number;
	embedding: number[];
}

interface CachedIndex {
	embeddingModel: string;
	mutationVersion: number;
	db: AnyOrama;
}

export class RagSemanticSearchService {
	private settings: PorygonPluginSettings;
	private store: RagIndexedDbStore;
	private cachedIndex: CachedIndex | null = null;
	// Shares a single in-flight build across concurrent searches so two queries
	// racing on a cold cache don't both rebuild the same index.
	private buildPromise: Promise<CachedIndex | null> | null = null;

	constructor(settings: PorygonPluginSettings, store: RagIndexedDbStore) {
		this.settings = settings;
		this.store = store;
	}

	updateSettings(settings: PorygonPluginSettings): void {
		this.settings = settings;
	}

	isConfigured(): boolean {
		return getActiveProvider(this.settings).isConfigured(this.settings);
	}

	async search(options: RagSemanticSearchOptions): Promise<RagSemanticSearchResult[]> {
		const query = options.query.trim();
		const limit = Math.max(1, options.limit ?? DEFAULT_SEARCH_LIMIT);
		if (!query || !this.isConfigured()) {
			console.debug("[Porygon RAG] search skipped", {
				query,
				isConfigured: this.isConfigured(),
			});
			return [];
		}

		const embeddingModel = this.settings.ollamaEmbeddingModel;
		console.debug("[Porygon RAG] semantic search", { query, limit, embeddingModel });

		const index = await this.getIndex(embeddingModel);
		if (!index) {
			console.debug("[Porygon RAG] search results", { query, vectorCount: 0, results: [] });
			return [];
		}

		const embeddings = this.getEmbeddingsClient();
		const queryVector = await embeddings.embedQuery(query);
		const response = await search(index.db, {
			mode: "hybrid",
			term: query,
			vector: { value: queryVector, property: "embedding" },
			similarity: HYBRID_SIMILARITY_THRESHOLD,
			limit,
		});

		const results = response.hits.map((hit) => {
			const document = hit.document as unknown as OramaDocument;
			return {
				chunkId: document.chunkId,
				path: document.path,
				title: document.title,
				chunkIndex: document.chunkIndex,
				text: document.text,
				score: hit.score,
			};
		});
		console.debug("[Porygon RAG] search results", {
			query,
			vectorCount: response.count,
			results: results.map((result) => ({
				path: result.path,
				chunkIndex: result.chunkIndex,
				score: result.score,
				snippet: result.text.slice(0, 200),
			})),
		});
		return results;
	}

	// Lazily builds (or rebuilds) the in-memory Orama index from the store. The
	// cache is keyed on the active embedding model plus the store's mutation
	// version, so any indexing write or model switch transparently triggers a
	// rebuild on the next search. Returns null when there is nothing to index yet.
	private async getIndex(embeddingModel: string): Promise<CachedIndex | null> {
		const mutationVersion = this.store.getMutationVersion();
		if (this.cachedIndex
			&& this.cachedIndex.embeddingModel === embeddingModel
			&& this.cachedIndex.mutationVersion === mutationVersion) {
			return this.cachedIndex;
		}

		this.buildPromise ??= this.buildIndex(embeddingModel, mutationVersion);
		try {
			const built = await this.buildPromise;
			this.cachedIndex = built;
			return built;
		} finally {
			this.buildPromise = null;
		}
	}

	private async buildIndex(embeddingModel: string, mutationVersion: number): Promise<CachedIndex | null> {
		const startedAt = performance.now();
		const [chunks, vectors] = await Promise.all([
			this.store.getChunksForEmbeddingModel(embeddingModel),
			this.store.getVectorsForEmbeddingModel(embeddingModel),
		]);
		const documents = buildOramaDocuments(chunks, vectors);
		const firstDocument = documents[0];
		if (!firstDocument) {
			return null;
		}

		const dimensions = firstDocument.embedding.length;
		const db = create({
			schema: {
				chunkId: "string",
				path: "string",
				title: "string",
				text: "string",
				chunkIndex: "number",
				embedding: `vector[${dimensions}]`,
			},
		});
		await insertMultiple(db, documents);
		console.debug("[Porygon RAG] rag index built", {
			embeddingModel,
			mutationVersion,
			documents: documents.length,
			dimensions,
			buildMs: Math.round(performance.now() - startedAt),
		});
		return { embeddingModel, mutationVersion, db };
	}

	private getEmbeddingsClient(): Embeddings {
		return getEmbeddings(this.settings);
	}
}

// Joins chunk text with its vector by chunkId, skipping any chunk missing a
// vector (or vice versa) so a partially-written file never produces a malformed
// Orama document.
function buildOramaDocuments(chunks: RagChunkRecord[], vectors: RagVectorRecord[]): OramaDocument[] {
	const vectorsByChunkId = new Map(vectors.map((vector) => [vector.chunkId, vector]));
	const documents: OramaDocument[] = [];
	for (const chunk of chunks) {
		const vector = vectorsByChunkId.get(chunk.id);
		if (!vector) {
			continue;
		}

		documents.push({
			chunkId: chunk.id,
			path: chunk.path,
			title: chunk.title,
			text: chunk.text,
			chunkIndex: chunk.chunkIndex,
			embedding: Array.from(arrayBufferToFloat32Array(vector.vector)),
		});
	}

	return documents;
}
