import { OllamaEmbeddings } from "@langchain/ollama";
import { App, TFile } from "obsidian";
import picomatch from "picomatch";
import { PorygonPluginSettings } from "../settings";
import { buildMarkdownChunks } from "./chunks";
import { float32ArrayToArrayBuffer, RagIndexedDbStore } from "./indexeddb-store";
import { RagChunkRecord, RagFileRecord, RagIndexProgress, RagVectorRecord } from "./types";

const INDEX_BATCH_SIZE = 10;
const INDEX_YIELD_MS = 25;
const MODIFY_DEBOUNCE_MS = 1500;
const SETTINGS_RECONCILE_DEBOUNCE_MS = 1000;
const MAX_CHUNKS_PER_FILE = 256;
const EMBEDDING_BATCH_SIZE = 16;

type IgnoreMatcher = (path: string) => boolean;
type PrefetchedFile = { content: string; contentHash: string };

export class RagIndexer {
	private app: App;
	private settings: PorygonPluginSettings;
	private store: RagIndexedDbStore;
	private queue: TFile[] = [];
	private queuedPaths = new Set<string>();
	private prefetchedFiles = new Map<string, PrefetchedFile>();
	private isRunning = false;
	private isReconciling = false;
	private disposed = false;
	private cachedEmbeddings: { host: string; model: string; client: OllamaEmbeddings } | null = null;
	private ignoreMatcher: IgnoreMatcher;
	private ignoreSource = "";
	private progress: RagIndexProgress = {
		status: "idle",
		indexedFiles: 0,
		totalFiles: 0,
		queuedFiles: 0,
	};
	private listeners = new Set<(progress: RagIndexProgress) => void>();
	private modifyDebounceTimeouts = new Map<string, number>();
	private settingsReconcileTimeout: number | null = null;

	constructor(app: App, settings: PorygonPluginSettings, store: RagIndexedDbStore) {
		this.app = app;
		this.settings = settings;
		this.store = store;
		this.ignoreMatcher = compileIgnoreMatcher(settings.ragIgnoredPaths);
		this.ignoreSource = settings.ragIgnoredPaths;
	}

	getProgress(): RagIndexProgress {
		return { ...this.progress };
	}

	onProgress(listener: (progress: RagIndexProgress) => void): () => void {
		this.listeners.add(listener);
		listener(this.getProgress());
		return () => this.listeners.delete(listener);
	}

	dispose(): void {
		this.disposed = true;
		for (const timeout of this.modifyDebounceTimeouts.values()) {
			window.clearTimeout(timeout);
		}
		this.modifyDebounceTimeouts.clear();
		if (this.settingsReconcileTimeout !== null) {
			window.clearTimeout(this.settingsReconcileTimeout);
			this.settingsReconcileTimeout = null;
		}
		this.queue = [];
		this.queuedPaths.clear();
		this.prefetchedFiles.clear();
		this.listeners.clear();
		this.cachedEmbeddings = null;
	}

	async reconcile(): Promise<void> {
		if (this.disposed || this.isReconciling) {
			return;
		}

		this.isReconciling = true;
		try {
			const markdownFiles = this.app.vault.getMarkdownFiles().filter((file) => !this.isIgnored(file.path));
			const vaultPaths = new Set(markdownFiles.map((file) => file.path));
			const indexedFiles = await this.store.getAllFiles();
			const orphanedPaths = indexedFiles
				.filter((file) => !vaultPaths.has(file.path))
				.map((file) => file.path);
			if (orphanedPaths.length > 0) {
				await this.store.deleteFiles(orphanedPaths);
			}

			// Index stored records by path for cheap freshness lookup.
			const indexedByPath = new Map(indexedFiles.map((file) => [file.path, file]));
			const embeddingConfig = this.getEmbeddingConfig();

			// Decide work up front so progress counters reflect reality (#9).
			const staleFiles: TFile[] = [];
			let freshCount = 0;
			for (const file of markdownFiles) {
				if (this.disposed) {
					return;
				}

				const stored = indexedByPath.get(file.path);
				// Cheap path (#1): mtime + size + embeddingConfig match → trust it,
				// skip the read and SHA-256.
				const cheapMatch = stored
					&& stored.mtime === file.stat.mtime
					&& stored.size === file.stat.size
					&& stored.embeddingConfig === embeddingConfig;
				if (cheapMatch) {
					freshCount += 1;
					continue;
				}

				// Fall back to content hash for ambiguous cases (e.g. Sync rewrote
				// the file with an unchanged body but a new mtime).
				const content = await this.app.vault.cachedRead(file);
				const contentHash = await hashText(content);
				const fullyFresh = stored
					&& stored.contentHash === contentHash
					&& stored.embeddingConfig === embeddingConfig
					&& stored.size === file.stat.size;
				if (fullyFresh) {
					freshCount += 1;
					continue;
				}

				staleFiles.push(file);
				// Pass the freshly read content downstream so indexFile can reuse it (#6).
				this.prefetchedFiles.set(file.path, { content, contentHash });
				await sleep(0);
			}

			this.setProgress({
				status: staleFiles.length > 0 ? "indexing" : "ready",
				indexedFiles: freshCount,
				totalFiles: markdownFiles.length,
				queuedFiles: this.queue.length + staleFiles.length,
				lastError: undefined,
			});

			for (const file of staleFiles) {
				this.enqueue(file);
			}

			this.start();
		} finally {
			this.isReconciling = false;
		}
	}

	enqueue(file: TFile): void {
		if (this.disposed || this.isIgnored(file.path) || this.queuedPaths.has(file.path)) {
			return;
		}

		this.queue.push(file);
		this.queuedPaths.add(file.path);
		this.setProgress({
			status: "indexing",
			queuedFiles: this.queue.length,
			totalFiles: Math.max(this.progress.totalFiles, this.progress.indexedFiles + this.queue.length),
		});
		this.start();
	}

	debounceEnqueue(file: TFile): void {
		if (this.disposed) {
			return;
		}

		const existingTimeout = this.modifyDebounceTimeouts.get(file.path);
		if (existingTimeout !== undefined) {
			window.clearTimeout(existingTimeout);
		}

		const timeout = window.setTimeout(() => {
			this.modifyDebounceTimeouts.delete(file.path);
			// Local-modify path invalidates any reconcile prefetch we may have cached
			// before the user kept typing.
			this.prefetchedFiles.delete(file.path);
			this.enqueue(file);
		}, MODIFY_DEBOUNCE_MS);
		this.modifyDebounceTimeouts.set(file.path, timeout);
	}

	async deleteFile(path: string): Promise<void> {
		const existingTimeout = this.modifyDebounceTimeouts.get(path);
		if (existingTimeout !== undefined) {
			window.clearTimeout(existingTimeout);
			this.modifyDebounceTimeouts.delete(path);
		}

		this.queue = this.queue.filter((file) => file.path !== path);
		this.queuedPaths.delete(path);
		this.prefetchedFiles.delete(path);
		await this.store.deleteFile(path);
		this.setProgress({ queuedFiles: this.queue.length });
	}

	updateSettings(settings: PorygonPluginSettings): void {
		const hostOrModelChanged = this.settings.ollamaHost !== settings.ollamaHost ||
			this.settings.ollamaEmbeddingModel !== settings.ollamaEmbeddingModel;
		const ignoreChanged = this.ignoreSource !== settings.ragIgnoredPaths;
		this.settings = settings;

		if (ignoreChanged) {
			this.ignoreMatcher = compileIgnoreMatcher(settings.ragIgnoredPaths);
			this.ignoreSource = settings.ragIgnoredPaths;
		}

		if (hostOrModelChanged) {
			this.cachedEmbeddings = null;
		}

		if (hostOrModelChanged || ignoreChanged) {
			this.scheduleReconcile();
		}
	}

	private scheduleReconcile(): void {
		if (this.disposed) {
			return;
		}

		if (this.settingsReconcileTimeout !== null) {
			window.clearTimeout(this.settingsReconcileTimeout);
		}
		this.settingsReconcileTimeout = window.setTimeout(() => {
			this.settingsReconcileTimeout = null;
			void this.reconcile();
		}, SETTINGS_RECONCILE_DEBOUNCE_MS);
	}

	private start(): void {
		if (this.isRunning || this.disposed) {
			return;
		}

		this.isRunning = true;
		void this.processQueue();
	}

	private async processQueue(): Promise<void> {
		while (this.queue.length > 0) {
			if (this.disposed) {
				this.isRunning = false;
				return;
			}

			const batch = this.queue.splice(0, INDEX_BATCH_SIZE);
			for (const file of batch) {
				this.queuedPaths.delete(file.path);
				try {
					await this.indexFile(file);
					this.setProgress({
						indexedFiles: this.progress.indexedFiles + 1,
						queuedFiles: this.queue.length,
						lastIndexedAt: Date.now(),
					});
				} catch (error) {
					// Record the error but keep draining the queue so a single bad
					// file (e.g. Ollama hiccup) does not stall the whole index (#2).
					console.error(`[Porygon RAG] failed to index ${file.path}`, error);
					this.setProgress({
						status: "error",
						queuedFiles: this.queue.length,
						lastError: error instanceof Error ? error.message : String(error),
					});
				} finally {
					this.prefetchedFiles.delete(file.path);
				}
			}
			await sleep(INDEX_YIELD_MS);
		}

		this.isRunning = false;
		// Re-check after releasing the running flag in case work was enqueued
		// between the loop exit and this point.
		if (this.queue.length > 0) {
			this.start();
			return;
		}

		// Preserve the error status if any file failed during this drain so the
		// user can still see what went wrong; otherwise mark the index as ready.
		if (this.progress.status !== "error") {
			this.setProgress({ status: "ready", queuedFiles: 0 });
		} else {
			this.setProgress({ queuedFiles: 0 });
		}
	}

	private async indexFile(file: TFile): Promise<void> {
		// Reuse content + hash captured during reconcile when available (#6).
		const prefetched = this.prefetchedFiles.get(file.path);
		const content = prefetched?.content ?? await this.app.vault.cachedRead(file);
		const contentHash = prefetched?.contentHash ?? await hashText(content);
		const chunks = await buildMarkdownChunks({
			path: file.path,
			basename: file.basename,
			content,
			mtime: file.stat.mtime,
			size: file.stat.size,
		});
		const cappedChunks = chunks.length > MAX_CHUNKS_PER_FILE ? chunks.slice(0, MAX_CHUNKS_PER_FILE) : chunks;
		if (chunks.length > MAX_CHUNKS_PER_FILE) {
			console.warn(`[Porygon RAG] truncating ${file.path}: ${chunks.length} chunks exceeds cap of ${MAX_CHUNKS_PER_FILE}`);
		}

		const embeddings = this.getEmbeddingsClient();
		const vectors: number[][] = [];
		for (let offset = 0; offset < cappedChunks.length; offset += EMBEDDING_BATCH_SIZE) {
			if (this.disposed) {
				return;
			}

			const batchTexts = cappedChunks.slice(offset, offset + EMBEDDING_BATCH_SIZE).map((chunk) => chunk.text);
			const batchVectors = await embeddings.embedDocuments(batchTexts);
			vectors.push(...batchVectors);
		}

		const now = Date.now();
		const chunkRecords: RagChunkRecord[] = cappedChunks.map((chunk) => ({
			...chunk,
			embeddingModel: this.settings.ollamaEmbeddingModel,
			createdAt: now,
		}));
		const vectorRecords: RagVectorRecord[] = vectors.map((vector, index) => ({
			chunkId: cappedChunks[index]?.id ?? `${file.path}#${index}`,
			path: file.path,
			embeddingModel: this.settings.ollamaEmbeddingModel,
			dimensions: vector.length,
			vector: float32ArrayToArrayBuffer(new Float32Array(vector)),
			createdAt: now,
		}));
		const fileRecord: RagFileRecord = {
			path: file.path,
			mtime: file.stat.mtime,
			size: file.stat.size,
			contentHash,
			embeddingConfig: this.getEmbeddingConfig(),
			embeddingModel: this.settings.ollamaEmbeddingModel,
			indexedAt: now,
			chunkCount: cappedChunks.length,
		};

		await this.store.replaceFile({ file: fileRecord, chunks: chunkRecords, vectors: vectorRecords });
	}

	private getEmbeddingsClient(): OllamaEmbeddings {
		const host = this.settings.ollamaHost;
		const model = this.settings.ollamaEmbeddingModel;
		if (!this.cachedEmbeddings || this.cachedEmbeddings.host !== host || this.cachedEmbeddings.model !== model) {
			this.cachedEmbeddings = {
				host,
				model,
				client: new OllamaEmbeddings({ baseUrl: host, model }),
			};
		}
		return this.cachedEmbeddings.client;
	}

	private isIgnored(path: string): boolean {
		return this.ignoreMatcher(path);
	}

	private getEmbeddingConfig(): string {
		return `${this.settings.ollamaHost}|${this.settings.ollamaEmbeddingModel}`;
	}

	private setProgress(progress: Partial<RagIndexProgress>): void {
		this.progress = { ...this.progress, ...progress };
		for (const listener of this.listeners) {
			listener(this.getProgress());
		}
	}
}

// Exposed for unit testing; consumers should go through RagIndexer.
export function compileIgnoreMatcher(source: string): IgnoreMatcher {
	const patterns = parseIgnorePatterns(source);
	if (patterns.length === 0) {
		return () => false;
	}

	const isMatch = picomatch(patterns, { dot: true });
	return (path) => isMatch(normalizeIndexPath(path));
}

function parseIgnorePatterns(source: string): string[] {
	const expanded: string[] = [];
	for (const raw of source.split(/\r?\n/)) {
		const pattern = normalizeIndexPath(raw);
		if (!pattern) {
			continue;
		}

		// "Archive/" → "Archive/**" so trailing slashes match folder contents.
		if (pattern.endsWith("/")) {
			expanded.push(`${pattern}**`);
			continue;
		}

		// Bare folder names like "Archive" should match both the folder and its
		// contents to preserve the previous (homegrown) behavior.
		if (!pattern.includes("*") && !pattern.includes("/")) {
			expanded.push(pattern, `${pattern}/**`);
			continue;
		}

		expanded.push(pattern);
	}
	return expanded;
}

async function hashText(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeIndexPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
