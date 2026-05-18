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
