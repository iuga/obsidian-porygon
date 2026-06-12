export interface RagFileRecord {
	path: string;
	mtime: number;
	size: number;
	contentHash: string;
	embeddingConfig: string;
	embeddingModel: string;
	indexedAt: number;
	chunkCount: number;
}

export interface RagChunkRecord {
	id: string;
	path: string;
	chunkIndex: number;
	text: string;
	title: string;
	mtime: number;
	size: number;
	embeddingModel: string;
	createdAt: number;
}

export interface RagVectorRecord {
	chunkId: string;
	path: string;
	embeddingModel: string;
	dimensions: number;
	vector: ArrayBuffer;
	createdAt: number;
}

export interface RagIndexedFileInput {
	file: RagFileRecord;
	chunks: RagChunkRecord[];
	vectors: RagVectorRecord[];
}

export interface RagFileFreshnessInput {
	path: string;
	mtime: number;
	size: number;
	contentHash: string;
	embeddingConfig: string;
}

export interface RagMarkdownChunk {
	id: string;
	path: string;
	chunkIndex: number;
	text: string;
	title: string;
	mtime: number;
	size: number;
}

export interface RagBuildChunksInput {
	path: string;
	basename: string;
	content: string;
	mtime: number;
	size: number;
	chunkSize?: number;
	chunkOverlap?: number;
}

export type RagIndexStatus = "idle" | "indexing" | "ready" | "paused" | "error";

export interface RagIndexProgress {
	status: RagIndexStatus;
	indexedFiles: number;
	totalFiles: number;
	queuedFiles: number;
	lastIndexedAt?: number;
	lastError?: string;
}

export interface RagSemanticSearchOptions {
	query: string;
	limit?: number;
}

export interface RagSemanticSearchResult {
	chunkId: string;
	path: string;
	title: string;
	chunkIndex: number;
	text: string;
	score: number;
}

export interface RagRetrievalMatch {
	chunkId: string;
	score: number;
}

export interface RagRetrievalQuery {
	text: string;
	vector: Float32Array;
	embeddingModel: string;
	limit: number;
}

// Change notifications emitted by RagStore after each successful mutation, so
// derived in-memory indexes (e.g. the Orama hybrid retriever) can stay in sync
// without coupling to the indexer.
export type RagStoreChangeEvent =
	| { type: "replace"; input: RagIndexedFileInput }
	| { type: "delete"; paths: string[] }
	| { type: "clear" };

// Port for the persistence layer of the semantic index. Implementations
// (adapters) live in `store/` and are resolved through `createRagStore`, so
// the indexer and search service never depend on a concrete database.
export interface RagStore {
	getFile(path: string): Promise<RagFileRecord | undefined>;
	getAllFiles(): Promise<RagFileRecord[]>;
	countFiles(): Promise<number>;
	replaceFile(input: RagIndexedFileInput): Promise<void>;
	deleteFile(path: string): Promise<void>;
	deleteFiles(paths: string[]): Promise<void>;
	clearIndex(): Promise<void>;
	getChunks(ids: string[]): Promise<RagChunkRecord[]>;
	getVectorsForEmbeddingModel(embeddingModel: string): Promise<RagVectorRecord[]>;
	// Emits a change event after each successful mutation. Returns an
	// unsubscribe function.
	subscribe(listener: (event: RagStoreChangeEvent) => void): () => void;
	close(): Promise<void>;
	// Optional capability for stores with native vector search (e.g. a future
	// SQLite + sqlite-vec backend). When present, a store-native retriever can
	// push KNN down to the database instead of brute-forcing in JS. Scores
	// must be similarity-ordered: higher is more similar.
	searchVectors?(queryVector: Float32Array, embeddingModel: string, limit: number): Promise<RagRetrievalMatch[]>;
}

// Port for the retrieval/ranking strategy used by semantic search.
// Implementations live in `retrieval/` and are resolved through
// `createRagRetriever`. Scores are similarity-ordered: higher is more similar.
export interface RagRetriever {
	retrieve(query: RagRetrievalQuery): Promise<RagRetrievalMatch[]>;
	// Optional cleanup for retrievers holding derived state (store
	// subscriptions, in-memory indexes).
	dispose?(): void;
}
