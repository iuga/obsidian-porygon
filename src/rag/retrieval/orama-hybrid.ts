import { create, insertMultiple, removeMultiple, search, type AnyOrama } from "@orama/orama";
import { arrayBufferToFloat32Array } from "../store/vector-codec";
import type {
	RagChunkRecord,
	RagRetrievalMatch,
	RagRetrievalQuery,
	RagRetriever,
	RagStore,
	RagStoreChangeEvent,
	RagVectorRecord,
} from "../types";

// Candidates fetched per list (fulltext, vector) before rank fusion.
const CANDIDATES = 20;
// Reciprocal Rank Fusion constant: score(id) = Σ 1 / (RRF_K + rank).
const RRF_K = 60;
// Inserts per batch during the initial build; yields to the event loop in
// between so a large vault never blocks the UI.
const BUILD_BATCH_SIZE = 200;
// Orama's vector search filters out matches below `similarity` (default 0.8).
// We want pure top-k ranking, so disable the cutoff entirely.
const DISABLE_SIMILARITY_CUTOFF = -1;

interface OramaChunkDocument {
	id: string;
	path: string;
	title: string;
	text: string;
	embedding: number[];
}

// Hybrid retrieval: BM25 fulltext + vector search over an in-memory Orama
// index, fused with Reciprocal Rank Fusion. The Orama instance is derived
// state — lazily built from the RagStore (the source of truth), patched
// incrementally via store change events, and rebuilt from scratch whenever
// the embedding model changes or the index is cleared. It is never persisted.
export class OramaHybridRetriever implements RagRetriever {
	private store: RagStore;
	private unsubscribe: (() => void) | null;
	private db: AnyOrama | null = null;
	private dims: number | null = null;
	private builtForModel: string | null = null;
	private buildPromise: Promise<boolean> | null = null;
	// Orama removes documents by id only, so deletes need a path → chunk-id
	// map maintained alongside the index.
	private pathToChunkIds = new Map<string, string[]>();
	// Store mutations are applied strictly in order; events arriving during a
	// build are queued behind it so no change is lost or applied twice.
	private mutationChain: Promise<void> = Promise.resolve();

	constructor(store: RagStore) {
		this.store = store;
		this.unsubscribe = store.subscribe((event) => this.handleStoreChange(event));
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.dropIndex();
	}

	// Optional pre-build (e.g. on idle after layout-ready) so the first query
	// doesn't pay the build cost. Errors are swallowed: the next retrieve()
	// simply rebuilds.
	warmUp(embeddingModel: string): void {
		if (!embeddingModel) {
			return;
		}
		void this.ensureBuilt(embeddingModel).catch((error) => {
			console.debug("[Porygon RAG] hybrid index warm build failed", error);
		});
	}

	async retrieve(query: RagRetrievalQuery): Promise<RagRetrievalMatch[]> {
		// Apply queued store changes first (a pending `clear` must drop the
		// index before we decide whether to rebuild), then build if needed,
		// then let patches queued during the build land before querying.
		await this.mutationChain;
		const ready = await this.ensureBuilt(query.embeddingModel);
		await this.mutationChain;
		const db = this.db;
		if (!ready || !db) {
			console.debug("[Porygon RAG] hybrid retrieve skipped (no index)", {
				text: query.text,
				embeddingModel: query.embeddingModel,
			});
			return [];
		}

		const [fulltext, vector] = await Promise.all([
			search(db, {
				mode: "fulltext",
				term: query.text,
				properties: ["text", "title"],
				limit: CANDIDATES,
			}),
			search(db, {
				mode: "vector",
				vector: { value: query.vector, property: "embedding" },
				similarity: DISABLE_SIMILARITY_CUTOFF,
				limit: CANDIDATES,
			}),
		]);

		const fused = fuseWithReciprocalRank([fulltext.hits, vector.hits], query.limit);
		console.debug("[Porygon RAG] hybrid retrieve", {
			text: query.text,
			fulltextHits: fulltext.hits.map((hit) => ({ id: hit.id, score: hit.score })),
			vectorHits: vector.hits.map((hit) => ({ id: hit.id, score: hit.score })),
			fused,
		});
		return fused;
	}

	// Memoized lazy build: concurrent queries share one in-flight build, and a
	// model switch triggers a rebuild for the new fingerprint.
	private async ensureBuilt(embeddingModel: string): Promise<boolean> {
		while (this.buildPromise) {
			await this.buildPromise;
		}
		if (this.db && this.builtForModel === embeddingModel) {
			return true;
		}

		this.buildPromise = this.build(embeddingModel).finally(() => {
			this.buildPromise = null;
		});
		return this.buildPromise;
	}

	private async build(embeddingModel: string): Promise<boolean> {
		this.dropIndex();
		const vectors = await this.store.getVectorsForEmbeddingModel(embeddingModel);
		if (vectors.length === 0) {
			return false;
		}

		// Vector dimensions are only known at runtime, from the stored
		// records; Orama fixes the vector size in the schema at create().
		const dims = vectors[0]?.dimensions ?? 0;
		if (dims <= 0) {
			return false;
		}

		const chunks = await this.store.getChunks(vectors.map((vector) => vector.chunkId));
		const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
		const documents = vectors.flatMap((vector) => {
			const chunk = chunksById.get(vector.chunkId);
			if (!chunk || vector.dimensions !== dims) {
				return [];
			}
			return [toDocument(chunk, vector)];
		});

		const db = createOramaInstance(dims);
		const pathToChunkIds = new Map<string, string[]>();
		for (const document of documents) {
			const ids = pathToChunkIds.get(document.path) ?? [];
			ids.push(document.id);
			pathToChunkIds.set(document.path, ids);
		}
		for (let index = 0; index < documents.length; index += BUILD_BATCH_SIZE) {
			await insertMultiple(db, documents.slice(index, index + BUILD_BATCH_SIZE));
			await sleep(0);
		}

		this.db = db;
		this.dims = dims;
		this.builtForModel = embeddingModel;
		this.pathToChunkIds = pathToChunkIds;
		return true;
	}

	private handleStoreChange(event: RagStoreChangeEvent): void {
		// Without an index (and no build in flight) there is nothing to patch:
		// the next build reads the fresh store state anyway.
		if (!this.db && !this.buildPromise) {
			return;
		}

		this.mutationChain = this.mutationChain
			.then(async () => {
				if (this.buildPromise) {
					await this.buildPromise.catch(() => undefined);
				}
				await this.applyEvent(event);
			})
			.catch((error) => {
				console.warn("[Porygon RAG] failed to apply store change to hybrid index", error);
			});
	}

	private async applyEvent(event: RagStoreChangeEvent): Promise<void> {
		if (event.type === "clear") {
			// Drop the derived index entirely; the next query rebuilds.
			this.dropIndex();
			return;
		}

		const db = this.db;
		if (!db) {
			return;
		}

		if (event.type === "delete") {
			const ids = event.paths.flatMap((path) => this.pathToChunkIds.get(path) ?? []);
			if (ids.length > 0) {
				await removeMultiple(db, ids);
			}
			for (const path of event.paths) {
				this.pathToChunkIds.delete(path);
			}
			return;
		}

		const path = event.input.file.path;
		const previousIds = this.pathToChunkIds.get(path) ?? [];
		if (previousIds.length > 0) {
			await removeMultiple(db, previousIds);
		}

		const chunksById = new Map(event.input.chunks.map((chunk) => [chunk.id, chunk]));
		const documents = event.input.vectors.flatMap((vector) => {
			// Skip vectors for a different model/dimensionality than the built
			// index; they belong to a future rebuild.
			if (vector.embeddingModel !== this.builtForModel || vector.dimensions !== this.dims) {
				return [];
			}
			const chunk = chunksById.get(vector.chunkId);
			return chunk ? [toDocument(chunk, vector)] : [];
		});
		if (documents.length > 0) {
			await insertMultiple(db, documents);
			this.pathToChunkIds.set(path, documents.map((document) => document.id));
		} else {
			this.pathToChunkIds.delete(path);
		}
	}

	private dropIndex(): void {
		this.db = null;
		this.dims = null;
		this.builtForModel = null;
		this.pathToChunkIds = new Map();
	}
}

function createOramaInstance(dims: number): AnyOrama {
	return create({
		schema: {
			id: "string",
			path: "string",
			title: "string",
			text: "string",
			embedding: `vector[${dims}]`,
		} as const,
		components: {
			// The default tokenizer stems English; vault content is often
			// mixed-language, so index raw tokens instead.
			tokenizer: { stemming: false },
		},
	});
}

function toDocument(chunk: RagChunkRecord, vector: RagVectorRecord): OramaChunkDocument {
	return {
		id: chunk.id,
		path: chunk.path,
		title: chunk.title,
		text: chunk.text,
		// Orama's schema validation only accepts plain arrays for vector
		// properties (Array.isArray), so typed arrays must be converted.
		embedding: Array.from(arrayBufferToFloat32Array(vector.vector)),
	};
}

// Reciprocal Rank Fusion over result lists: each list contributes
// 1 / (RRF_K + rank) per document, ranks starting at 1. An empty list (e.g.
// a term that tokenizes to nothing) simply contributes nothing, degrading to
// the other list's ranking.
function fuseWithReciprocalRank(lists: { id: string; score: number }[][], limit: number): RagRetrievalMatch[] {
	const scores = new Map<string, number>();
	for (const hits of lists) {
		for (const [index, hit] of hits.entries()) {
			const id = String(hit.id);
			scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
		}
	}

	return Array.from(scores.entries())
		.map(([chunkId, score]) => ({ chunkId, score }))
		.sort((left, right) => right.score - left.score)
		.slice(0, limit);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
