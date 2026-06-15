# Spec: Orama hybrid search + embedding/retrieval isolation

| | |
|---|---|
| Repo | `iuga/obsidian-porygon` (master, v0.16.0) |
| Status | Ready for implementation |
| Verified against | `@orama/orama@3.1.18`, `@orama/plugin-data-persistence@3.1.18` (API smoke-tested on Node 22) |
| Audience | Coding agent. Follow phases in order. Each phase must build (`npm run build`) and lint (`npm run lint`) before moving on. |

## 1. Why this change

The current retrieval layer in `src/rag/` has four concrete problems:

| # | Problem | Where |
|---|---|---|
| P1 | **No lexical recall.** `semantic_search` is embeddings-only. Exact tokens (function names, acronyms, file names, Spanish/English terms the embedding model handles poorly) miss when the vector neighborhood misses. There is no BM25 signal at all. | `src/rag/semantic-search.ts` |
| P2 | **O(N) brute force per query.** Every query loads *every* vector for the model from IndexedDB and computes cosine in JS. Cost grows linearly with vault size, on every single tool call. | `semantic-search.ts` `search()` |
| P3 | **Keyword `search` tool reads the whole vault per query.** It calls `cachedRead` on every markdown file and line-scans. No ranking, no typo tolerance, O(vault) I/O each time. | `src/agent/tools/search.ts` |
| P4 | **Embedding creation is not isolated.** `indexer.ts` calls `embeddings.embedDocuments` directly (with its own batching constant) and `semantic-search.ts` calls `embeddings.embedQuery` directly. Two call sites reach into the provider; there is no single seam for batching, dimension discovery, caching, or provider swap. | `indexer.ts:325`, `semantic-search.ts` |

Orama fixes P1 to P3: it is a pure-TypeScript in-memory engine with BM25 full-text, vector, and fused hybrid search, typo tolerance, and field boosting. It runs in Obsidian's renderer with no native deps. P4 is fixed by extracting an `EmbeddingService` (this refactor is Phase 1 and is a prerequisite, not a side quest: both the indexer and the new retrieval path need the same embedding seam).

## 2. Goals and non-goals

**Goals**

- G1: Hybrid (BM25 + vector) retrieval for the `semantic_search` agent tool, default mode `hybrid`.
- G2: IndexedDB remains the single durable source of truth. Orama is a derived, disposable, in-memory index.
- G3: Orama stays in sync with the indexer in near-real time (file modify/delete/orphan cleanup).
- G4: Vector creation isolated behind one `RagEmbeddingService` used by both indexing and querying.
- G5: Keyword `search` tool stops scanning the whole vault (Phase 3).
- G6: Graceful degradation: if Ollama is down at query time, fall back to full-text instead of returning nothing.

**Non-goals**

- New user-facing settings (all tuning is constants for now).
- Changing chunking, embedding batching behavior, freshness detection, or the IndexedDB record shapes.
- ANN indexing, quantization, multi-vault sharing, re-ranking models.
- Replacing the `semantic_search` tool name or its JSON output contract (agent prompts depend on both).

## 3. Architecture

**Invariant: Orama can be deleted at any moment and rebuilt entirely from IndexedDB. Nothing ever flows from Orama back into IndexedDB.**

```
 vault events                                   query time
      │                                              │
      ▼                                              ▼
 RagIndexer ──chunks──► RagEmbeddingService ◄── RagRetrievalService
      │                  (embedDocuments /            │
      │                   embedQuery, dims)           │ search(mode, term, vector)
      ▼                                               ▼
 RagIndexedDbStore  ──build/rebuild────────►  OramaVaultIndex
 (files/chunks/vectors,    │                  (in-memory, derived)
  SOURCE OF TRUTH)         └──upsert/remove──────────▲
                                │                    │
                                └── after every store write,
                                    indexer notifies the sink
```

**Key decisions (do not relitigate during implementation):**

| Decision | Choice | Why |
|---|---|---|
| Where Orama lives | In memory only. Rebuilt from IndexedDB on plugin load, in the background. | Rebuild reads chunks+vectors once per session. The *old* design read all vectors on *every query*, so cold-start cost is strictly better than one legacy query. Snapshot persistence is an optional optimization (Phase 4), not required for correctness. |
| Sync direction | Indexer writes IndexedDB first, then notifies Orama via a sink interface. | Store write is the durability point. Orama failures must never fail indexing. |
| Document identity | Orama document `id` = `RagChunkRecord.id`. | Verified: Orama 3.1.18 accepts a custom `id: 'string'` schema field and uses it for `getByID` / `remove`. Chunk ids are `path#index` based, so they are NOT unique across file versions: always remove a file's old docs before inserting new ones. |
| Removal bookkeeping | `OramaVaultIndex` keeps `Map<path, string[]>` of doc ids per path. | Avoids relying on Orama `where` filter semantics and avoids extra IndexedDB reads per upsert. Rebuilt naturally during build. |
| Tokenizer | `components: { tokenizer: { stemming: false } }` | Vaults are mixed-language (Spanish + English). English stemming corrupts Spanish tokens. Verified working. |
| Old brute-force path | Deleted entirely (`semantic-search.ts`, `cosineSimilarity`). | One retrieval path. Grep confirmed no other consumers. |

## 4. Verified Orama 3.1.18 facts (do not re-derive, do not guess)

All of the following were executed successfully against the published package:

1. `create({ schema, components: { tokenizer: { stemming: false } } })` with schema field `embedding: 'vector[N]'`. **N is fixed at create time**; changing dimensions requires a new instance.
2. Custom ids: schema `id: 'string'` + documents carrying `id` makes `getByID(db, id)`, `remove(db, id)`, `removeMultiple(db, ids)` work with your ids.
3. `insert`, `insertMultiple`, `remove`, `removeMultiple`, `count`, `getByID`, `search` are all importable from `@orama/orama`. In v3 they are synchronous for the default in-memory components (no `await` needed, but `await` is harmless).
4. Hybrid search call shape (verified):

```ts
search(db, {
  mode: 'hybrid',
  term: query,
  vector: { value: number[], property: 'embedding' },
  similarity: 0.6,                          // vector-side floor, default 0.8
  limit: 8,
  hybridWeights: { text: 0.5, vector: 0.5 },
  properties: ['title', 'content'],         // text side only searches these
  boost: { title: 1.5 },
  tolerance: 1,                             // typo tolerance, text side
})
```

5. `mode: 'fulltext'` and `mode: 'vector'` use the same call shape minus the irrelevant parts.
6. Hits come back as `{ id, score, document }` where `document` is the full inserted doc. Hybrid `score` is a fused score, not raw cosine.
7. Persistence plugin (Phase 4 only): `const data = await persist(db, 'binary')` returns a `string`; `await restore('binary', data)` returns a working db (vector search verified after round trip).
8. Vectors must be passed as plain `number[]` (convert from the stored `ArrayBuffer` via `Array.from(new Float32Array(buf))`).

## 5. File plan

| Action | Path | Purpose |
|---|---|---|
| ADD | `src/rag/embedding-service.ts` | `RagEmbeddingService`: all embedding calls live here |
| ADD | `src/rag/orama-index.ts` | `OramaVaultIndex`: lifecycle, build, upsert/remove, search proxy |
| ADD | `src/rag/retrieval-service.ts` | `RagRetrievalService`: query orchestration, result mapping |
| MODIFY | `src/rag/indexer.ts` | Use `RagEmbeddingService`; notify sink after store writes |
| MODIFY | `src/rag/types.ts` | Add search mode/options types; keep `RagSemanticSearchResult` as-is |
| MODIFY | `src/rag/index.ts` | Update barrel exports |
| DELETE | `src/rag/semantic-search.ts` | Replaced by retrieval-service + orama-index |
| MODIFY | `src/agent/tools/semantic-search.ts` | Depend on `RagRetrievalService`; update description text |
| MODIFY | `src/agent/tools/index.ts`, `src/agent/agent.ts` | Type/param swap |
| MODIFY | `src/main.ts` | Wiring (see 6.6); also `src/view.ts:1643` passes the service through |
| MODIFY (Phase 3) | `src/agent/tools/search.ts` | Orama-ranked candidates instead of full vault scan |
| MODIFY (Phase 4) | `src/rag/indexeddb-store.ts` | Add `snapshots` object store (additive idb migration) |
| MODIFY | `package.json` | Add deps |

Known call sites to update (inventoried by grep, verify with a fresh grep for `RagSemanticSearchService|ragSemanticSearch|cosineSimilarity`): `main.ts:5,15,30,91`, `view.ts:1643`, `agent/agent.ts:6,57,93`, `agent/tools/index.ts:2,23,30`, `agent/tools/semantic-search.ts`.

## 6. Component specs

### 6.1 `RagEmbeddingService` (`src/rag/embedding-service.ts`)

```ts
export class RagEmbeddingService {
  constructor(settings: PorygonPluginSettings)
  updateSettings(settings: PorygonPluginSettings): void

  isConfigured(): boolean                       // delegates getActiveProvider(settings).isConfigured
  getConfig(): string                           // getActiveProvider(settings).embeddingsFingerprint(settings)
                                                // MUST equal the value indexer stores as RagFileRecord.embeddingConfig
  getModel(): string                            // settings.ollamaEmbeddingModel
  getDimensions(): Promise<number>              // probe + cache, see below

  embedQuery(text: string): Promise<Float32Array>
  embedDocuments(texts: string[]): Promise<Float32Array[]>
}
```

Behavior:

- Wraps `getEmbeddings(settings)` from `src/providers`. No other file may import `getEmbeddings` after Phase 1 (enforce by grep).
- `embedDocuments` owns batching: loop in `EMBEDDING_BATCH_SIZE = 16` slices (move the constant here from `indexer.ts`).
- `getDimensions()` probes once per `getConfig()` value: embed the literal string `"porygon dimension probe"`, cache `{config, dims}`. Invalidate on `updateSettings` when config changes. Needed because Orama's `vector[N]` is fixed at create time and Ollama models vary (e.g. nomic-embed-text 768, mxbai-embed-large 1024, qwen3-embedding:8b 4096).
- Returns `Float32Array` so callers stop re-wrapping `number[]`.

### 6.2 `OramaVaultIndex` (`src/rag/orama-index.ts`)

```ts
export interface RagIndexEventSink {
  upsertFile(path: string, chunks: RagChunkRecord[], vectors: RagVectorRecord[]): Promise<void>;
  removeFiles(paths: string[]): Promise<void>;
}

export type OramaIndexStatus = "empty" | "building" | "ready" | "error";

export class OramaVaultIndex implements RagIndexEventSink {
  constructor(store: RagIndexedDbStore, embeddings: RagEmbeddingService)

  getStatus(): OramaIndexStatus
  ensureBuilt(): Promise<void>      // idempotent; no-op while building/ready
  rebuild(): Promise<void>          // drop db + ensureBuilt; for embedding-config changes / clearIndex
  dispose(): void                   // clear timers/refs on plugin unload

  // RagIndexEventSink
  upsertFile(path, chunks, vectors): Promise<void>
  removeFiles(paths): Promise<void>

  // null when status !== "ready" AND status !== "building" with partial data
  search(params: OramaSearchParams): Promise<OramaSearchHit[] | null>
}
```

Internal state: `db: AnyOrama | null`, `indexKey: string`, `pathDocIds: Map<string, string[]>`, `status`.

**Document schema** (create once per `indexKey`):

```ts
{
  id: 'string',          // RagChunkRecord.id
  path: 'string',
  title: 'string',       // chunk title (note basename)
  content: 'string',     // chunk text
  chunkIndex: 'number',  // needed to map back to RagSemanticSearchResult losslessly
  embedding: `vector[${dims}]`,
}
```

`indexKey = "v" + ORAMA_INDEX_VERSION + "|" + embeddings.getConfig() + "|" + dims`. Bump `ORAMA_INDEX_VERSION` (const, start at 1) on any schema/tokenizer change.

**Build protocol** (`ensureBuilt`):

1. If `!embeddings.isConfigured()` stay `empty` and return.
2. `dims = await embeddings.getDimensions()`; `create` db with tokenizer `{ stemming: false }`; status `building`.
3. Load `store.getChunksForEmbeddingModel(model)` and `store.getVectorsForEmbeddingModel(model)`; join by `chunkId` into a Map; skip chunks whose vector is missing or whose `dimensions !== dims` (log count).
4. `insertMultiple` in batches of `ORAMA_INSERT_BATCH = 200`, with `await sleep(0)` between batches (reuse the indexer's yield pattern) so Obsidian stays responsive.
5. Populate `pathDocIds` as you go. Set `ready`. `console.debug("[Porygon RAG] orama built", { docs, files, dims, ms })`.
6. Any throw: status `error`, log, leave `db = null`.

**Upsert protocol** (`upsertFile`): if `db` is null, return (the eventual build will pick the data up from the store). Else: convert each `RagVectorRecord.vector` via `Array.from(arrayBufferToFloat32Array(buf))`, skip records with `dimensions !== dims`; `removeMultiple(db, pathDocIds.get(path) ?? [])`; `insertMultiple(db, docs)`; update `pathDocIds`. Wrap the whole body in try/catch: on error, log and `void this.rebuild()` (self-heal). **Never throw to the caller.**

**Remove protocol** (`removeFiles`): for each path `removeMultiple` its known ids, drop map entries. Same no-throw rule.

**Queries during `building`** return whatever is already inserted (partial results are fine and better than nothing). Queries while `empty`/`error` return `null`.

### 6.3 `RagRetrievalService` (`src/rag/retrieval-service.ts`)

```ts
export type RagSearchMode = "hybrid" | "vector" | "fulltext";

export interface RagRetrievalOptions {
  query: string;
  limit?: number;          // default DEFAULT_SEMANTIC_SEARCH_LIMIT (8), keep the existing constant
  mode?: RagSearchMode;    // default "hybrid"
}

export class RagRetrievalService {
  constructor(settings: PorygonPluginSettings, index: OramaVaultIndex, embeddings: RagEmbeddingService)
  updateSettings(settings: PorygonPluginSettings): void
  search(options: RagRetrievalOptions): Promise<RagSemanticSearchResult[]>
}
```

`search` behavior:

1. Trim query; empty or `!embeddings.isConfigured()` returns `[]` (mirror current guard + debug logs).
2. If mode needs vectors (`hybrid`/`vector`): `embedQuery`. **If embedding throws** (Ollama down), log a warn and downgrade `mode` to `fulltext` for this call (G6).
3. Call `index.search` with: `term: query`, `vector: { value, property: 'embedding' }` (when applicable), `similarity: HYBRID_SIMILARITY_FLOOR`, `limit`, `hybridWeights: HYBRID_WEIGHTS`, `properties: ['title', 'content']`, `boost: { title: TITLE_BOOST }`, `tolerance: FULLTEXT_TOLERANCE`. `null` result returns `[]` (the tool's existing fallback message, driven by `getProgress()`, already covers "still indexing").
4. Map hits to the **unchanged** `RagSemanticSearchResult`: `{ chunkId: doc.id, path, title, chunkIndex, text: doc.content, score: hit.score }`. Keep the existing `console.debug` result logging shape from the old service.

### 6.4 Indexer changes (`src/rag/indexer.ts`)

- Constructor gains `embeddings: RagEmbeddingService` and `sink: RagIndexEventSink` (depend on the interface, not on `OramaVaultIndex`, so the indexer stays decoupled/testable).
- Replace the inline embedding loop (`getEmbeddingsClient` + `EMBEDDING_BATCH_SIZE` loop at ~`indexer.ts:319-328`) with `const vectors = await this.embeddings.embedDocuments(texts)`. Delete `getEmbeddingsClient` and the local `EMBEDDING_BATCH_SIZE`. Replace `getEmbeddingConfig()` body with `this.embeddings.getConfig()` and `isEmbeddingConfigured()` with `this.embeddings.isConfigured()` (or inline them).
- After `await this.store.replaceFile(...)` succeeds in `indexFile`: `await this.sink.upsertFile(file.path, chunkRecords, vectorRecords)`.
- In `deleteFile`, after `store.deleteFile(path)`: `await this.sink.removeFiles([path])`.
- In `reconcile`, after `store.deleteFiles(orphanedPaths)`: `await this.sink.removeFiles(orphanedPaths)`.
- Sink calls are already no-throw by contract (6.2), so no extra try/catch needed here.
- Grep for any caller of `store.clearIndex()`; after each, call `oramaIndex.rebuild()` (wire via plugin instance).

### 6.5 Agent tool changes

`src/agent/tools/semantic-search.ts`:
- Swap the dependency type to `RagRetrievalService`; call stays `search({ query, limit })` (hybrid by default). Output JSON shape unchanged.
- Update `description` to: searches notes with **hybrid keyword + semantic** matching; good for both exact terms (names, identifiers) and vague conceptual queries. Keep tool name `semantic_search`.

`src/agent/tools/search.ts` (Phase 3 only):
- New flow: `index.search({ mode: 'fulltext', term, limit: SEARCH_CANDIDATE_LIMIT, properties: ['title','content'], tolerance: 1 })` to get ranked candidate chunks; reduce to unique paths preserving rank; run the existing `prepareSimpleSearch` line scan **only over those files**; return the same `{note, lines}[]` JSON contract.
- If `index.search` returns `null` (not ready), fall back to the current full-vault scan unchanged.
- Pass `OramaVaultIndex` (or the retrieval service) into `createSearchTool` via `createAgentTools`.

### 6.6 Wiring (`src/main.ts`)

Construction order in `onload`:

```ts
this.ragStore = new RagIndexedDbStore(this.app);
this.ragEmbeddings = new RagEmbeddingService(this.settings);
this.ragOramaIndex = new OramaVaultIndex(this.ragStore, this.ragEmbeddings);
this.ragIndexer = new RagIndexer(this.app, this.settings, this.ragStore, this.ragEmbeddings, this.ragOramaIndex);
this.ragRetrieval = new RagRetrievalService(this.settings, this.ragOramaIndex, this.ragEmbeddings);
// after existing indexer startup:
void this.ragOramaIndex.ensureBuilt();
```

- Replace the `ragSemanticSearch` field/usages (`main.ts:15,30,91`, `view.ts:1643`, agent plumbing) with `ragRetrieval`.
- On settings save (where `updateSettings` is fanned out today at `main.ts:91`): capture `before = ragEmbeddings.getConfig()`, update embeddings/retrieval/indexer, and if config changed: `void this.ragOramaIndex.rebuild()` (the indexer's existing reconcile will re-embed stale files; upserts flow in as they land).
- `onunload`: `this.ragOramaIndex.dispose()`.

### 6.7 Constants (single block in `orama-index.ts` / `retrieval-service.ts`)

| Constant | Value | Note |
|---|---|---|
| `ORAMA_INDEX_VERSION` | `1` | bump on schema/tokenizer change |
| `ORAMA_INSERT_BATCH` | `200` | rebuild batch size, yields between batches |
| `HYBRID_WEIGHTS` | `{ text: 0.5, vector: 0.5 }` | |
| `HYBRID_SIMILARITY_FLOOR` | `0.6` | lower than Orama's 0.8 default; BM25 side compensates |
| `FULLTEXT_TOLERANCE` | `1` | typo tolerance |
| `TITLE_BOOST` | `1.5` | |
| `SEARCH_CANDIDATE_LIMIT` | `40` | Phase 3 |
| `ORAMA_PERSIST_DEBOUNCE_MS` | `5000` | Phase 4 |

## 7. Implementation phases

### Phase 0: dependency

`npm i @orama/orama@^3.1.18`. Accept: `npm run build` green; note the `main.js` size delta in the PR description.

### Phase 1: isolate embeddings (no behavior change)

Create `RagEmbeddingService`; rewire `indexer.ts` and (temporarily) the existing `semantic-search.ts` to use it; thread it through `main.ts`.

Accept: build + lint green; `grep -rn "getEmbeddings(" src --include="*.ts"` matches only `providers/` and `embedding-service.ts`; indexing and semantic search behave exactly as before on a test vault.

### Phase 2: Orama hybrid retrieval (the core)

Add `orama-index.ts`, `retrieval-service.ts`, sink hooks in the indexer, wiring, tool swap; delete `semantic-search.ts` and `cosineSimilarity`; update the barrel and types.

Accept, on a test vault with Ollama running:
1. Cold start: debug log shows built doc count == chunk count in IndexedDB for the active model.
2. Lexical recall (the P1 fix): a rare exact keyword that exists in exactly one note ranks that note in the top 3 via `semantic_search`. Verify this query class failed or ranked poorly before the change.
3. Edit a note: within the indexer debounce, the query reflects new content; old chunk count for the path is fully replaced (no stale hits from the previous version).
4. Delete a note: its chunks stop appearing.
5. Switch embedding model in settings: index rebuilds; no dimension-mismatch errors; queries work after reconcile completes.
6. Stop Ollama, run `semantic_search`: results still come back (fulltext degrade path) with a warn log.
7. `grep -rn "RagSemanticSearchService\|cosineSimilarity" src` returns nothing.

### Phase 3: keyword `search` tool upgrade

As specced in 6.5. Accept: identical output contract; with a 500+ file vault, add a temporary debug counter to confirm `cachedRead` is called for at most `SEARCH_CANDIDATE_LIMIT` files per query; not-ready fallback still scans everything.

### Phase 4 (optional, only if startup rebuild proves slow on real vaults): snapshot persistence

- `npm i @orama/plugin-data-persistence@^3.1.18`.
- Additive idb migration: bump `RAG_DATABASE_VERSION` to `2` (NOT `RAG_SCHEMA_VERSION`, which renames the database and destroys data; the code comment at `indexeddb-store.ts:7-13` already designates `RAG_DATABASE_VERSION` for exactly this) and create a `snapshots` object store, `keyPath: "indexKey"`, value `{ indexKey, data: string, docCount: number, pathDocIds: Record<string, string[]>, savedAt: number }`.
- On `ensureBuilt`: try snapshot first; valid iff `indexKey` matches AND `docCount` equals the store's current chunk count for the model; `restore('binary', data)` then restore `pathDocIds`; any mismatch or throw falls back to full rebuild and deletes the snapshot.
- Persist with `persist(db, 'binary')` debounced `ORAMA_PERSIST_DEBOUNCE_MS` after any mutation, plus once in `dispose()`.

Accept: second plugin load logs "restored snapshot" and skips the full vector read; corrupting the snapshot value manually falls back to rebuild without errors surfacing to the user.

## 8. Risks and mitigations

| Risk | Detail | Mitigation |
|---|---|---|
| Renderer memory | Orama holds vectors as JS `number[]` (8 bytes/dim). Per chunk: nomic-embed-text (768d) ~6 KB, mxbai-embed-large (1024d) ~8 KB, qwen3-embedding:8b (4096d, the README's suggested model) ~32 KB. A 5,000-chunk vault on 4096d is ~160 MB of vectors alone. | Accept for v1; log an estimated memory figure at build time (`docs * dims * 8`). Document in README that 768 to 1024-dim models are recommended for large vaults. Future options (out of scope): drop the vector from the stored document and keep a side Float32Array table, or fulltext-only Orama + manual RRF fusion. |
| Startup rebuild cost | Full read of chunks + vectors object stores per session. | Equal to ONE query under the old design (which read all vectors per query). Background + batched + yielding. Phase 4 removes it if needed. |
| Score semantics | Hybrid `score` is a fused value, not cosine; numbers shown to the agent change scale. | Acceptable; results are ranked. Note it in the tool description if the agent over-interprets scores. |
| Spanish/English tokenization | Default Orama tokenizer stems English. | `stemming: false` (verified). Revisit per-language stemmers later. |
| Bundle | Pure ESM TS, esbuild-friendly. | Accept criterion in Phase 0 records the size delta. |
| Sync drift (crash between store write and upsert) | Orama could briefly miss a file in the current session. | Self-heals next session (rebuild from store). `upsertFile` errors already trigger `rebuild()`. |

## 9. Out of scope

User-tunable weights/similarity, frontmatter/tag fields in the Orama schema, heading-aware chunking, ANN/quantization, persisting Orama as the source of anything.

## Appendix A: verified snippets (copy these shapes)

```ts
import { create, insertMultiple, removeMultiple, search, count } from '@orama/orama'

const db = create({
  schema: {
    id: 'string', path: 'string', title: 'string', content: 'string',
    chunkIndex: 'number', embedding: `vector[${dims}]`,
  },
  components: { tokenizer: { stemming: false } },
})

insertMultiple(db, docs)                 // docs carry your `id`; embedding is number[]
removeMultiple(db, idsForPath)           // by your custom ids

const r = search(db, {
  mode: 'hybrid',
  term: query,
  vector: { value: Array.from(queryVec), property: 'embedding' },
  similarity: 0.6,
  limit: 8,
  hybridWeights: { text: 0.5, vector: 0.5 },
  properties: ['title', 'content'],
  boost: { title: 1.5 },
  tolerance: 1,
})
// r.hits: [{ id, score, document: { id, path, title, content, chunkIndex, embedding } }]
```

```ts
// Phase 4 only
import { persist, restore } from '@orama/plugin-data-persistence'
const data = await persist(db, 'binary')   // string, store it in the snapshots object store
const db2 = await restore('binary', data)  // vector + hybrid search verified working after restore
```
