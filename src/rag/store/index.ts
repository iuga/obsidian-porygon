import type { App } from "obsidian";
import type { PorygonPluginSettings } from "../../settings/settings";
import type { RagStore } from "../types";
import { RagIndexedDbStore } from "./indexeddb-store";

export { RagIndexedDbStore } from "./indexeddb-store";
export { arrayBufferToFloat32Array, float32ArrayToArrayBuffer } from "./vector-codec";

export type RagStoreBackendId = "indexeddb";

export interface RagStoreDefinition {
	id: RagStoreBackendId;
	name: string;
	create(app: App, settings: PorygonPluginSettings): RagStore;
}

// Single source of truth for the available store backends, mirroring the
// `src/providers` registry pattern. Adding a backend (e.g. SQLite + sqlite-vec)
// means one adapter file plus one entry here — consumers stay untouched.
const STORES: Record<RagStoreBackendId, RagStoreDefinition> = {
	indexeddb: {
		id: "indexeddb",
		name: "IndexedDB",
		create: (app) => new RagIndexedDbStore(app),
	},
};

export const DEFAULT_RAG_STORE_BACKEND: RagStoreBackendId = "indexeddb";

export function getRagStoreDefinitions(): RagStoreDefinition[] {
	return Object.values(STORES);
}

export function createRagStore(app: App, settings: PorygonPluginSettings): RagStore {
	const definition = STORES[settings.ragStoreBackend] ?? STORES[DEFAULT_RAG_STORE_BACKEND];
	return definition.create(app, settings);
}
