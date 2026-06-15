# Spec: hybrid search (Orama) + unified `search` tool

Implementation spec for adding an Orama-backed hybrid (BM25 + vector) retrieval
strategy and collapsing the agent's two search tools (`search`,
`semantic_search`) into a single `search` tool. Written against branch
`ragSQLite` (commit `ef106fc`, "refactor(rag): decouple store and retrieval
behind pluggable ports").

## Goal

One agent tool: you search, you get the best results. Hybrid retrieval fuses
exact keyword matching (BM25 — nails codenames, acronyms, people, filenames)
with semantic vector search (catches synonyms and concepts), so the LLM no
longer has to choose between two tools and a wrong pick no longer means bad
recall.

## Architecture

IndexedDB stays the **single source of truth**. The Orama instance is a
derived, in-memory index: lazily built from the store, patched incrementally
via store change events, rebuildable at any time. Embeddings keep coming from
Ollama via the existing provider path.

```
                       ┌──────────────────────────────────────────────┐
                       │ RagSemanticSearchService                     │
                       │ embed query → retriever.retrieve({text,vec}) │
                       └──────────────┬───────────────────────────────┘
                                      │
                 ┌────────────────────┴──────────────────────┐
                 │ RagRetriever (registry pick)              │
                 │  - orama-hybrid (new, in-memory)          │
                 └───────┬───────────────────────▲───────────┘
                         │ lazy build / hydrate  │ change events
                         ▼                       │
                 ┌───────────────────────────────┴───────────┐
                 │ RagStore (IndexedDB, source of truth)     │
                 │ replaceFile / deleteFiles / clearIndex    │◄── RagIndexer
                 └───────────────────────────────────────────┘
```

## Hard constraints

- **Dependency:** `@orama/orama` only (pin `^3.1.x`, Apache-2.0). Do **not**
  add `@orama/plugin-data-persistence` (whole-instance serialization — known
  failure mode in Obsidian plugins) or `@orama/plugin-embeddings` (tensorflow.js).
- **Never persist the Orama instance.** It is derived state; worst case is a
  rebuild from IndexedDB.
- **Do not use Orama's `mode: 'hybrid'`.** Run `fulltext` and `vector`
  separately and fuse with RRF (see Query path).
- `RagIndexer` stays untouched — sync flows store → retriever via events.
- Default retrieval strategy stays `cosine`; `orama-hybrid` is opt-in via the
  existing settings dropdown.

## Orama facts the implementation depends on (verified in Orama source)

| Fact | Source | Consequence |
|---|---|---|
| Vector `similarity` is a hard filter, default `0.8` (`DEFAULT_SIMILARITY`); only matches with `similarity >= threshold` are returned | `packages/orama/src/trees/vector.ts`, `methods/search-vector.ts` | Always pass `similarity: -1`; let `limit` do top-k. Otherwise weak-but-valid matches silently vanish |
| Vectors need not be pre-normalized; Orama stores magnitudes and computes cosine itself | `trees/vector.ts` (`getMagnitude`, `findSimilarVectors`) | Insert stored vectors as-is |
| Vector storage is a plain `Map<id, [magnitude, Float32Array]>`, linear scan, no ANN | `trees/vector.ts` | Same brute-force as our cosine path, but in RAM — fine at vault scale |
| Document id: `doc.id` is used as the Orama id when it is a string | `components/defaults.ts` (`getDocumentIndexId`) | Our chunk ids (`"path#index"`) slot in directly; `remove`/`removeMultiple` work by those ids |
| Fulltext `threshold` default `1` = docs matching ANY query token (`0` = ALL) | `methods/search-fulltext.ts` | Leave at default initially |
| `exact: true` applies a case-sensitive word-boundary post-filter | `methods/search-fulltext.ts` | Map the tool's `exact` param to it |
| Default tokenizer stems English | tokenizer defaults | Set `stemming: false` for mixed-language vaults; revisit with `@orama/stemmers` later |
| Incremental ops exist: `insert`, `insertMultiple`, `remove`, `removeMultiple`, `update` | core methods | Event-driven patching is supported |
| Schema fixes vector size at `create()` (`vector[N]`) | schema validation | Instance must be created lazily once dims are known from stored vectors |

## Spec

### 1. Port changes (`src/rag/types.ts`)

Replace the positional `RagRetriever.retrieve(vector, model, limit)` signature
with a query object, and add optional lifecycle:

```ts
export interface RagRetrievalQuery {
	text: string;
	vector: Float32Array;
	embeddingModel: string;
	limit: number;
}

export interface RagRetriever {
	retrieve(query: RagRetrievalQuery): Promise<RagRetrievalMatch[]>;
	dispose?(): void; // unsubscribe from store events, drop the in-memory index
}
```

Make the store observable so in-memory retrievers stay in sync without
touching the indexer:

```ts
export type RagStoreChangeEvent =
	| { type: "replace"; input: RagIndexedFileInput }
	| { type: "delete"; paths: string[] }
	| { type: "clear" };

export interface RagStore {
	// ...existing methods...
	subscribe(listener: (event: RagStoreChangeEvent) => void): () => void;
}
```

### 2. Store events (`src/rag/store/indexeddb-store.ts`)

`RagIndexedDbStore` keeps a listener set and emits **after** each successful
mutation: `replaceFile` → `replace`, `deleteFile`/`deleteFiles` → `delete`,
`clearIndex` → `clear`. `subscribe` returns an unsubscribe function.

### 3. Orama retriever (`src/rag/retrieval/orama-hybrid.ts`)

Schema (chunk id doubles as the Orama document id):

```ts
const db = create({
	schema: {
		id: "string",
		path: "string",
		title: "string",
		text: "string",
		embedding: `vector[${dims}]`,
	},
	components: { tokenizer: { stemming: false } },
});
```

Lifecycle:

- **Lazy creation with runtime dims.** Dims come from stored
  `RagVectorRecord.dimensions`. Create the instance on first build; recreate
  from scratch when dims or embedding model change.
- **Build on demand, memoized.** Track `builtForModel`. On `retrieve()`, if
  `builtForModel !== query.embeddingModel`, rebuild and memoize the promise so
  concurrent queries share one build. Optionally warm-build at
  `onLayoutReady` via `requestIdleCallback`.
- **Build path:** `store.getVectorsForEmbeddingModel(model)` →
  `store.getChunks(vectorRecords.map(v => v.chunkId))` → join into docs →
  `insertMultiple(db, docs, BATCH)` with `await sleep(0)` between batches so a
  10k-chunk build never blocks the UI. Pass vectors as
  `new Float32Array(buffer)` (`VectorTypeLike` accepts `Float32Array |
  number[]`; verify schema validation accepts the typed array, else
  `Array.from`).
- **Path → chunk-id map.** Orama removes by document id only. Keep
  `Map<path, string[]>` (populated during build and inserts) so delete events
  resolve paths to ids for `removeMultiple`.

Event handling (all no-ops until the index is built):

| Store event | Orama action |
|---|---|
| `replace` | `removeMultiple(oldIdsForPath)` → `insertMultiple(newDocs)`; update path map. Skip docs whose `embeddingModel` ≠ built model |
| `delete` | `removeMultiple(idsForPaths)`; drop map entries |
| `clear` | drop instance + map; next query rebuilds |

### 4. Query path: two searches + RRF

```ts
const CANDIDATES = 20; // per list
const RRF_K = 60;

const fulltext = search(db, {
	mode: "fulltext",
	term: query.text,
	properties: ["text", "title"],
	limit: CANDIDATES,
});
const vector = search(db, {
	mode: "vector",
	vector: { value: query.vector, property: "embedding" },
	similarity: -1, // disable the 0.8 default cutoff; top-k via limit
	limit: CANDIDATES,
});
// RRF: score(id) = Σ over lists containing id of 1 / (RRF_K + rank)
// sort desc, slice to query.limit, return { chunkId, score }
```

Notes:

- If the fulltext list is empty (term tokenizes to nothing), RRF degrades to
  vector-only ranking — no special-casing needed.
- Returned scores are RRF scores (max ≈ 0.033 when rank 1 in both lists), not
  cosine similarities. The agent tool surfaces `score` as-is.
- `RagSemanticSearchService.search()` builds the `RagRetrievalQuery` with both
  the raw query text and the embedded vector. Result hydration stays via
  `store.getChunks` (source of truth), not Orama's copies.

### 5. Registry, settings, wiring

- `src/rag/retrieval/index.ts`: extend
  `RagRetrievalStrategyId = "cosine" | "orama-hybrid"`; register
  `{ id: "orama-hybrid", name: "Hybrid (BM25 + semantic)", isCompatible: () =>
  true, create: (store) => new OramaHybridRetriever(store) }`. The settings
  dropdown auto-enables once two definitions exist
  (`src/settings/settings-tab.ts:282`).
- `src/rag/retrieval/cosine-bruteforce.ts`: adapt to `retrieve(query)`;
  ignore `query.text`.
- `src/main.ts` `rebuildRagPipeline()`: keep a reference to the active
  retriever and call `retriever.dispose?.()` when swapping (today only the
  indexer is disposed and the store closed).

### 6. Unified `search` tool

Replace both agent tools with one, backed by `RagSemanticSearchService`.

Contract:

- **Name:** `search` (keep the established id). `semantic_search` is removed;
  tools are rebuilt per agent session, nothing persists old ids.
- **Schema:** `intent` (existing pattern), `query` (natural language or exact
  tokens), `limit` (1–20, default 8), optional `exact: boolean` → Orama's
  `exact: true` for quoted-phrase lookups.
- **Result shape** (per hit): `path`, `wikilink`, `title`, `chunk_index`,
  `score`, `snippet`. Line numbers are dropped; the `view` tool's
  `line`/`surrounding` options cover follow-up reading.

Degraded-mode ladder (inside the tool, invisible to the agent):

| Condition | Behavior |
|---|---|
| Index ready + embeddings reachable | full hybrid: fulltext + vector + RRF |
| Query embedding fails (Ollama down mid-session) | BM25-only over the Orama index + note in payload |
| Embeddings never configured (chunk store empty) | legacy `prepareSimpleSearch` line scan as last resort, so search works out of the box |
| Index still building | hybrid over what exists + existing progress message (`getSemanticSearchFallbackMessage`) |

Accepted behavior changes (document in release notes):

- Results come from the index, not live files: ~1.5 s modify-debounce
  staleness window (`MODIFY_DEBOUNCE_MS`); reconcile covers the rest.
- `ragIgnoredPaths` and the internal `porygon/` folder no longer appear in
  keyword results (the old scan leaked both). For user-ignored paths, mention
  in the setting description.
- Chunk-granular, score-ranked results replace line-number lists.

Prompt/docs updates in the same PR: rewrite `prompts/system.md`'s
`<semantic_search>` block as `<search>` (one tool; `exact` for quoted phrases;
remove all tool-choice guidance) and update `skills/explainer.md`'s
"`semantic_search` then `search`" instruction.

## Memory and startup budget

| Vault size | Vectors (1024 dims, f32) | Chunk text | BM25 overhead (~2–4× text) | Total ballpark |
|---|---|---|---|---|
| 1k chunks | 4 MB | ~1 MB | 2–4 MB | ~10 MB |
| 10k chunks | 41 MB | ~12 MB | 25–50 MB | ~80–100 MB |
| 50k chunks | 205 MB | ~60 MB | 120–240 MB | ~400+ MB |

Desktop-only plugin: 10k-chunk vaults are comfortable. Initial build for 10k
chunks: ~1 s IndexedDB read + 1–3 s batched inserts, off the critical path if
warmed on idle. Past ~50k chunks, revisit: keep Orama for BM25 only and score
vectors in a worker-owned Float32 matrix (`docs/rag.md` #1), RRF on top.

## Implementation order

**PR 1 — hybrid retriever:**

1. `npm install @orama/orama` (pin `^3.1.x`).
2. `src/rag/types.ts` — `RagRetrievalQuery`, new `RagRetriever.retrieve`
   signature + optional `dispose`, `RagStoreChangeEvent` + `subscribe`.
3. `src/rag/store/indexeddb-store.ts` — listener set + emits after
   `replaceFile`, `deleteFiles`, `clearIndex`.
4. `src/rag/retrieval/cosine-bruteforce.ts` — adapt signature (mechanical).
5. `src/rag/retrieval/orama-hybrid.ts` — new retriever: lazy build, path→ids
   map, event handling, two-mode search + RRF.
6. `src/rag/retrieval/index.ts` — register `orama-hybrid`, extend the id union.
7. `src/rag/semantic-search.ts` — pass `{ text, vector, embeddingModel, limit }`.
8. `src/main.ts` — dispose the previous retriever in `rebuildRagPipeline()`;
   optional idle warm-build hook.
9. `npm run build` + `npm run lint`.

**PR 2 — unified `search` tool:**

10. `src/agent/tools/search.ts` — rebuild on `RagSemanticSearchService`:
    hybrid result shape, `exact` param, degraded-mode ladder (keep the
    `prepareSimpleSearch` scan as the internal last-resort fallback).
11. Delete `src/agent/tools/semantic-search.ts`; rewire
    `src/agent/tools/index.ts` (`createSearchTool(app, semanticSearch,
    getIndexProgress)`).
12. `prompts/system.md` — replace the `<semantic_search>` block with a
    `<search>` block; `skills/explainer.md` — update tool guidance.
13. `npm run build` + `npm run lint` + manual smoke (see checklist).

## Verification checklist

Retriever (PR 1):

- Exact-token wins: a note with a codename/acronym ("qwen3-embedding", a
  person's name) that vector-only ranks poorly surfaces top-3 in hybrid.
- Conceptual recall unchanged: paraphrase queries return ≈ the cosine results.
- Sync: modify / rename / delete a note → next query reflects it (no rebuild).
- Model switch: change embedding model → retriever rebuilds for the new
  fingerprint once the indexer re-embeds; no stale-dim crashes.
- Strategy switch both directions via settings dropdown (rebuild pipeline path).
- Term that tokenizes to nothing → degrades to vector-only ranking.
- Startup: no main-thread freeze during warm build (watch long-task warnings).

Unified tool (PR 2):

- One tool visible to the agent; no `semantic_search` in the tool list.
- Exact filename / quoted phrase queries succeed (with and without `exact`).
- Concept/person/project queries succeed (the old `semantic_search` cases).
- Embeddings unconfigured → search still answers via the line-scan fallback.
- Ollama killed mid-session → BM25-only results with the degraded note, no
  tool error surfaced to the chat.
- System prompt no longer references `semantic_search`; explainer skill flow
  works end to end.

## Follow-ups (out of scope)

- Heading-aware chunking + breadcrumbs (`docs/rag.md` #2) so the BM25 index
  sees heading paths; requires reindex.
- Worker-owned Float32 matrix for vector scoring at 50k+ chunks
  (`docs/rag.md` #1), keeping Orama for BM25 only.
- Folder/tag pre-filtering via Orama `where` clauses (`docs/rag.md` #6).
