import { deleteDB, DBSchema, IDBPDatabase, IDBPTransaction, openDB } from "idb";
import type { App } from "obsidian";
import { RagChunkRecord, RagFileFreshnessInput, RagFileRecord, RagIndexedFileInput, RagStore, RagVectorRecord } from "../types";

const RAG_DATABASE_PREFIX = "porygon";
const LEGACY_RAG_DATABASE_NAME = "porygon-rag";
// Semantic schema version baked into the database name. Bump this on a breaking
// change to the stored shape: every vault starts fresh on the new database and
// the previous versions are deleted by deleteStaleDatabases. Distinct from
// RAG_DATABASE_VERSION below, which is idb's internal object-store version used
// for additive, non-breaking migrations within a single database.
const RAG_SCHEMA_VERSION = 1;
const RAG_DATABASE_VERSION = 1;
const FILES_STORE = "files";
const CHUNKS_STORE = "chunks";
const VECTORS_STORE = "vectors";

interface PorygonRagDatabase extends DBSchema {
	files: {
		key: string;
		value: RagFileRecord;
		indexes: {
			embeddingModel: string;
			indexedAt: number;
		};
	};
	chunks: {
		key: string;
		value: RagChunkRecord;
		indexes: {
			path: string;
			embeddingModel: string;
			pathAndEmbeddingModel: [string, string];
		};
	};
	vectors: {
		key: string;
		value: RagVectorRecord;
		indexes: {
			path: string;
			embeddingModel: string;
			pathAndEmbeddingModel: [string, string];
		};
	};
}

type RagStoreNames = ["files", "chunks", "vectors"];

export class RagIndexedDbStore implements RagStore {
	private dbPromise: Promise<IDBPDatabase<PorygonRagDatabase>> | null = null;
	private readonly databaseName: string;

	constructor(app: App) {
		this.databaseName = buildRagDatabaseName(app);
		void this.deleteStaleDatabases(app);
	}

	// One-time cleanup of databases superseded by the current schema version so
	// already-leaked or outdated content does not linger on disk: the legacy shared
	// database plus every prior per-vault schema version. Runs fire-and-forget;
	// deleting a non-existent database is a no-op.
	private async deleteStaleDatabases(app: App): Promise<void> {
		const staleNames = [LEGACY_RAG_DATABASE_NAME];
		for (let version = 1; version < RAG_SCHEMA_VERSION; version++) {
			staleNames.push(buildRagDatabaseName(app, version));
		}

		await Promise.all(staleNames.map(async (name) => {
			try {
				await deleteDB(name);
			} catch (error) {
				console.warn(`[Porygon RAG] failed to delete stale database ${name}`, error);
			}
		}));
	}

	async close(): Promise<void> {
		const db = await this.getOpenDatabase();
		db.close();
		this.dbPromise = null;
	}

	async getFile(path: string): Promise<RagFileRecord | undefined> {
		const db = await this.getOpenDatabase();
		return db.get(FILES_STORE, path);
	}

	async getAllFiles(): Promise<RagFileRecord[]> {
		const db = await this.getOpenDatabase();
		return db.getAll(FILES_STORE);
	}

	async countFiles(): Promise<number> {
		const db = await this.getOpenDatabase();
		return db.count(FILES_STORE);
	}

	async getFilesByEmbeddingModel(embeddingModel: string): Promise<RagFileRecord[]> {
		const db = await this.getOpenDatabase();
		return db.getAllFromIndex(FILES_STORE, "embeddingModel", embeddingModel);
	}

	async isFileFresh(input: RagFileFreshnessInput): Promise<boolean> {
		const file = await this.getFile(input.path);
		return file?.mtime === input.mtime &&
			file.size === input.size &&
			file.contentHash === input.contentHash &&
			file.embeddingConfig === input.embeddingConfig;
	}

	async replaceFile(input: RagIndexedFileInput): Promise<void> {
		const db = await this.getOpenDatabase();
		const tx = db.transaction([FILES_STORE, CHUNKS_STORE, VECTORS_STORE], "readwrite");
		await this.deleteFileRecordsInTransaction(tx, input.file.path);

		const filesStore = tx.objectStore(FILES_STORE);
		const chunksStore = tx.objectStore(CHUNKS_STORE);
		const vectorsStore = tx.objectStore(VECTORS_STORE);
		await filesStore.put(input.file);
		await Promise.all([
			...input.chunks.map((chunk) => chunksStore.put(chunk)),
			...input.vectors.map((vector) => vectorsStore.put(vector)),
		]);
		await tx.done;
	}

	async deleteFile(path: string): Promise<void> {
		await this.deleteFiles([path]);
	}

	async deleteFiles(paths: string[]): Promise<void> {
		if (paths.length === 0) {
			return;
		}

		const db = await this.getOpenDatabase();
		const tx = db.transaction([FILES_STORE, CHUNKS_STORE, VECTORS_STORE], "readwrite");
		for (const path of paths) {
			await this.deleteFileRecordsInTransaction(tx, path);
		}
		await tx.done;
	}

	async clearIndex(): Promise<void> {
		const db = await this.getOpenDatabase();
		const tx = db.transaction([FILES_STORE, CHUNKS_STORE, VECTORS_STORE], "readwrite");
		await Promise.all([
			tx.objectStore(FILES_STORE).clear(),
			tx.objectStore(CHUNKS_STORE).clear(),
			tx.objectStore(VECTORS_STORE).clear(),
		]);
		await tx.done;
	}

	async getChunksForFile(path: string): Promise<RagChunkRecord[]> {
		const db = await this.getOpenDatabase();
		return db.getAllFromIndex(CHUNKS_STORE, "path", path);
	}

	async getChunksForEmbeddingModel(embeddingModel: string): Promise<RagChunkRecord[]> {
		const db = await this.getOpenDatabase();
		return db.getAllFromIndex(CHUNKS_STORE, "embeddingModel", embeddingModel);
	}

	async getVectorsForFile(path: string): Promise<RagVectorRecord[]> {
		const db = await this.getOpenDatabase();
		return db.getAllFromIndex(VECTORS_STORE, "path", path);
	}

	async getVectorsForEmbeddingModel(embeddingModel: string): Promise<RagVectorRecord[]> {
		const db = await this.getOpenDatabase();
		return db.getAllFromIndex(VECTORS_STORE, "embeddingModel", embeddingModel);
	}

	async getChunk(id: string): Promise<RagChunkRecord | undefined> {
		const db = await this.getOpenDatabase();
		return db.get(CHUNKS_STORE, id);
	}

	async getChunks(ids: string[]): Promise<RagChunkRecord[]> {
		const db = await this.getOpenDatabase();
		const chunks = await Promise.all(ids.map((id) => db.get(CHUNKS_STORE, id)));
		return chunks.filter((chunk): chunk is RagChunkRecord => chunk !== undefined);
	}

	private getOpenDatabase(): Promise<IDBPDatabase<PorygonRagDatabase>> {
		this.dbPromise ??= openDB<PorygonRagDatabase>(this.databaseName, RAG_DATABASE_VERSION, {
			upgrade(db) {
				if (!db.objectStoreNames.contains(FILES_STORE)) {
					const filesStore = db.createObjectStore(FILES_STORE, { keyPath: "path" });
					filesStore.createIndex("embeddingModel", "embeddingModel");
					filesStore.createIndex("indexedAt", "indexedAt");
				}

				if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
					const chunksStore = db.createObjectStore(CHUNKS_STORE, { keyPath: "id" });
					chunksStore.createIndex("path", "path");
					chunksStore.createIndex("embeddingModel", "embeddingModel");
					chunksStore.createIndex("pathAndEmbeddingModel", ["path", "embeddingModel"]);
				}

				if (!db.objectStoreNames.contains(VECTORS_STORE)) {
					const vectorsStore = db.createObjectStore(VECTORS_STORE, { keyPath: "chunkId" });
					vectorsStore.createIndex("path", "path");
					vectorsStore.createIndex("embeddingModel", "embeddingModel");
					vectorsStore.createIndex("pathAndEmbeddingModel", ["path", "embeddingModel"]);
				}
			},
		});
		return this.dbPromise;
	}

	private async deleteFileRecordsInTransaction(tx: IDBPTransaction<PorygonRagDatabase, RagStoreNames, "readwrite">, path: string): Promise<void> {
		const filesStore = tx.objectStore(FILES_STORE);
		const chunksStore = tx.objectStore(CHUNKS_STORE);
		const vectorsStore = tx.objectStore(VECTORS_STORE);
		const [chunkKeys, vectorKeys] = await Promise.all([
			chunksStore.index("path").getAllKeys(path),
			vectorsStore.index("path").getAllKeys(path),
		]);
		await Promise.all([
			filesStore.delete(path),
			...chunkKeys.map((key) => chunksStore.delete(key)),
			...vectorKeys.map((key) => vectorsStore.delete(key)),
		]);
	}
}

// IndexedDB is scoped by origin, and every vault in the same Obsidian install
// shares one origin. Without a per-vault qualifier the index database is shared
// across vaults, leaking indexed content. `appId` is the stable, unique per-vault
// id at runtime (absent from the public typings); `vault.getName()` is the
// fallback when it is unavailable. We join with `~` (which the legacy name never
// contains) so the result can never collide with `porygon-rag`, even for a vault
// literally named "rag". The schema version segment lets a future breaking change
// move every vault to a fresh database.
function buildRagDatabaseName(app: App, version = RAG_SCHEMA_VERSION): string {
	const appId = (app as App & { appId?: string }).appId;
	const vault = (appId || app.vault.getName()).toLowerCase().replace(/[^a-z0-9]/g, "");
	return `${RAG_DATABASE_PREFIX}~v${version}~${vault}`;
}
