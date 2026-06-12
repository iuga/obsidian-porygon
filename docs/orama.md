# Orama as a RAG + semantic search provider: analysis

Evaluation of [oramasearch/orama](https://github.com/oramasearch/orama) as a second
RAG provider for Porygon, written against the `ragSQLite` branch (commit `ef106fc`,
"refactor(rag): decouple store and retrieval behind pluggable ports").

## TL;DR

Orama is an **in-memory** JS search engine whose real value here is **BM25 full-text
and hybrid (text+vector) ranking** — not vector search, where it does the same brute
force we already do. Use it as a second `RagRetriever` on top of our IndexedDB store
(Option 1). Do **not** use it as a store: its persistence model (serialize the whole
instance) is precisely the weakness obsidian-copilot hit and retreated from, and our
incremental IndexedDB layer is the strongest part of the current pipeline.

## Where this branch left off

The `ragSQLite` branch built the exact seam this feature needs:

- `RagStore` + `RagRetriever` ports in `src/rag/types.ts`, with registries in
  `src/rag/store/index.ts` and `src/rag/retrieval/index.ts` mirroring the
  `src/providers` pattern.
- Settings (`ragStoreBackend`, `ragRetrievalStrategy`) with dropdowns that are
  disabled until a second implementation registers; `rebuildRagPipeline()` in
  `src/main.ts` swaps implementations at runtime.
- Retrieval definitions declare `isCompatible(store)` so strategies that need
  store capabilities (e.g. `store.searchVectors`) can fall back gracefully.

## Current approach (baseline to compare against)

- **Embeddings:** Ollama via LangChain (`src/providers`), bring-your-own model.
- **Store:** IndexedDB (`src/rag/store/indexeddb-store.ts`) — three object stores
  (files/chunks/vectors), incremental + transactional per-file replace, orphan
  cleanup, per-vault database names, schema-versioned (`porygon~v1~<vault>`).
- **Retrieval:** `CosineBruteForceRetriever` (`src/rag/retrieval/cosine-bruteforce.ts`)
  — reads **every vector for the active model out of IndexedDB on every query**,
  scores cosine in JS, full sort, top-k.
- **Agent keyword search:** separate `search` tool (`src/agent/tools/search.ts`)
  does an unindexed full-vault line scan per query via `prepareSimpleSearch`.

Known gaps (already documented in `docs/rag.md`):

1. Query-time data path: per-query IndexedDB scan instead of an in-RAM matrix (#1).
2. Retrieval quality: vector-only misses exact tokens — function names, acronyms,
   people, project codenames. Fix is BM25 + fusion (#3, which names Orama and
   MiniSearch as candidate libraries).

## Aside: what is BM25? (ELI5)

BM25 is a scoring formula for keyword search — it ranks documents by how well they
match the query's words, like a librarian deciding which book best answers
"pokemon red guide":

- **Rare words count more:** matching "pokemon" beats matching "guide", because
  "guide" appears everywhere (so it tells you little).
- **Repetition helps, but less each time:** a note saying "pokemon" 10 times is
  not 10× better than one saying it twice — the score flattens out.
- **Short docs win ties:** if a 3-line note and a 300-line note both mention
  "pokemon red", the short one is probably *about* it; the long one just
  *mentions* it.

It is the classic battle-tested ranking used by search engines (Elasticsearch,
Lucene) — purely word matching, no understanding of meaning. That is exactly why
it complements our embeddings: BM25 nails exact tokens ("qwen3-embedding",
"Esteban", project codenames), vectors catch synonyms and concepts.

## What Orama is (verified facts)

| Question | Answer |
|---|---|
| What | In-memory JS search engine: BM25 full-text (stemming, tokenization in 30 languages, typo tolerance, field boosting, facets/filters), vector search, hybrid mode, RAG/answer-session extras (cloud-oriented). |
| License / status | Apache-2.0, v3.1.x, actively maintained (~10k stars). Pure JS, bundles cleanly with esbuild. Plugin is `isDesktopOnly: true`, so desktop constraints are fine. |
| Bundle size | Marketed as "complete search engine in less than 2kb" (marketing figure for the minimal core); realistically small either way. The persistence plugin pulls msgpack/dpack — not needed under the recommended option. |
| Embeddings | Bring your own: schema `vector[N]` fields, query with `mode: 'vector'`/`'hybrid'` passing the raw vector. Our Ollama embedding path stays unchanged. Its own `@orama/plugin-embeddings` runs tensorflow.js — avoid. |
| Incremental updates | Yes: `insert`, `remove`, `removeMultiple`, `update` on a live instance. |

### Vector search internals (read from source)

`packages/orama/src/trees/vector.ts`:

- Storage is `Map<InternalDocumentID, [Magnitude, Float32Array]>` — a plain map,
  **no HNSW/ANN**. `find()` calls `findSimilarVectors()` which linearly scans every
  vector and computes cosine via dot product / magnitudes.
- There is a `// @todo: Write plugins for Node and Browsers to use parallel
  computation for this function` — i.e. not even worker-offloaded yet.
- **Threshold quirk:** results are filtered by a similarity threshold
  (`DEFAULT_SIMILARITY = 0.8`), not pure top-k. A query whose best matches score
  0.7 returns nothing unless the threshold is lowered explicitly.

Conclusion: Orama's vector path is the same brute force we already have, minus our
control over it. It adds **zero** vector-side smarts; `docs/rag.md` #1 (in-RAM
matrix + worker + top-k heap) remains our own work regardless.

### Hybrid scoring internals (read from source)

`packages/orama/src/methods/search-hybrid.ts`:

- Runs full-text and vector searches, min-max normalizes the BM25 scores
  (`minMaxScoreNormalization`), then combines with a **weighted sum**:
  `score = textScore * textWeight + vectorScore * vectorWeight`
  (`hybridScoreBuilder`).
- Weights come from `params.hybridWeights` or are auto-derived from the query
  (`getQueryWeights`). This is **not** RRF (`docs/rag.md` #3 recommends RRF:
  `Σ 1/(60 + rank)`, which needs no score normalization and is robust to scale
  mismatches). If we want RRF we run Orama's two modes separately and fuse
  ourselves.

### Persistence internals (read from source)

`packages/plugin-data-persistence/`:

- `persist(db, format)` / `restore(format, data)` serialize/deserialize the
  **entire instance**; formats `'json' | 'dpack' | 'binary' (msgpack) | 'seqproto'`.
  File-based variants live in a server-only module (browser gets in-memory
  persist/restore only).
- `VectorIndex.toJSON()` converts every `Float32Array` to a plain `number[]` —
  JSON-bloated vectors, full re-deserialization into memory on restore.
- **No incremental persistence**: every save rewrites the world.

### Real-world Obsidian precedent: obsidian-copilot

logancyang/obsidian-copilot used `@orama/orama` (^3.0.0-rc-2) as its semantic index
store and **deprecated the entire Orama layer**:

- `src/search/dbOperations.ts`: "DEPRECATED: Orama DB operations are superseded by
  v3 MemoryIndexManager JSONL index."
- `src/search/chunkedStorage.ts`: "DEPRECATED: Legacy partitioned Orama store. v3
  uses JSONL snapshots + MemoryIndexManager." — they had to build manual
  hash-partitioned snapshot files (djb2 over doc ids, vectors split per partition)
  to cope with serialize-the-world persistence, then abandoned Orama anyway.
- `src/search/hybridRetriever.ts`, `vectorStoreManager.ts`: same deprecation notes.

The failure mode was **Orama-as-store**, not Orama-as-ranker. That maps exactly onto
our Option 3 below.

## Core tradeoff vs. the current approach

Orama is an in-memory engine; our design is a persistent store with dumb retrieval.

| | Current (IndexedDB + cosine) | Orama |
|---|---|---|
| Keyword/BM25 search | none (agent tool does raw line scans) | native, typo-tolerant, multilingual |
| Hybrid text+vector | none | native (weighted sum; RRF doable on top) |
| Vector search | brute force, per-query IndexedDB scan | brute force, in RAM (faster at query time, same algorithm) |
| Persistence | incremental, transactional, per-vault, schema-versioned | serialize whole instance; no incremental saves |
| Memory | vectors on disk, low RAM | full index in RAM (text + vectors) |
| Filters/facets | none | native (`where` filters reach the vector path too) |

What Orama is genuinely good at is the thing we lack (BM25 + hybrid in RAM); what
it is bad at is the thing we already do well (incremental persistence).

## Options

### Option 1: Orama as a second `RagRetriever` (hybrid BM25+vector) — recommended

- **Shape:** new `orama-hybrid` retrieval strategy. At startup it builds an
  in-memory Orama index (chunk id, path, title, text + `vector[N]` field) from the
  `RagStore`, kept in sync by indexer add/update/delete events. IndexedDB remains
  the single source of truth; the Orama index is derived and rebuildable.
- **Why right:**
  - Biggest retrieval-quality win available (exact names, acronyms, codenames —
    the #1 quality gap in `docs/rag.md`).
  - Kills the per-query IndexedDB scan as a side effect (vectors live in RAM).
  - Exercises the retrieval registry exactly as this branch designed it.
  - Derived index → zero data-loss risk; worst case is a rebuild.
- **Costs / risks:**
  - RAM: text + vectors duplicated in memory. ~10k chunks × 1024 dims × 4 bytes
    ≈ 41 MB of vectors plus text — acceptable on desktop, worth a note in docs.
  - Startup rebuild: ~1–2 s for vault-sized indexes; must yield to the event loop.
  - Port change: `RagRetriever.retrieve()` today receives only the query vector;
    hybrid needs the query **text** too. Extend the port signature (pass both) and
    add sync hooks so the indexer can notify retrievers of changes.
  - Fusion control: Orama's weighted sum + 0.8 similarity threshold need taming
    (lower the threshold, set explicit weights) — or run `mode: 'fulltext'` and
    `mode: 'vector'` separately and fuse with RRF ourselves for the
    `docs/rag.md`-recommended behavior.
- **Effort:** few days.

### Option 2: Orama as BM25-only sidecar + RRF in the search service

- **Shape:** `docs/rag.md` #3 verbatim, with Orama instead of MiniSearch: index
  chunk text only; `RagSemanticSearchService` runs vector search and keyword
  search, fuses with RRF.
- **Why it could be right:** smallest change for the documented quality win; no
  port changes; text-only memory footprint.
- **Costs / risks:** leaves the per-query vector scan unfixed; it is a feature
  inside the search service rather than a swappable provider — does not advance
  the multi-provider story; still needs the same indexer-sync plumbing.
- **Effort:** ~2 days.

### Option 3: Orama as full store + retriever (replace IndexedDB) — rejected

- **Shape:** the Orama instance *is* the index; persist whole-DB snapshots via
  `@orama/plugin-data-persistence`.
- **Why it tempts:** one engine, native hybrid, cleanest "Orama as RAG provider"
  narrative.
- **Why rejected:** this is the road obsidian-copilot walked and retreated from —
  whole-instance serialization, JSON-bloated vectors (`number[]`), no incremental
  saves, snapshot corruption risk, manual partitioning workarounds. It trades our
  best subsystem (incremental, transactional persistence) for a known failure
  mode.
- **Effort:** sprint+, against precedent.

## Recommendation

**Option 1.** It is what the `RagRetriever` port was built for, it subsumes
Option 2's quality win, and it uses Orama for what it is genuinely good at (BM25 +
hybrid in RAM) while keeping it away from what it is bad at (persistence).

Honest caveat: if hybrid quality were the *only* goal, MiniSearch + RRF (Option 2
shape) is the lighter dependency. Orama earns its place if we also value its
hybrid mode, `where` filters/facets (future folder/tag pre-filtering per
`docs/rag.md` #6), typo tolerance, and reusing the same index to back the agent's
keyword `search` tool (replacing the per-query full-vault line scan).

## Open decisions before implementing

1. **Fusion:** Orama's native hybrid (weighted sum, min-max normalized) vs. running
   fulltext + vector separately and fusing with RRF ourselves. RRF is the
   `docs/rag.md` recommendation and is more robust; native hybrid is less code.
2. **Port shape:** extend `RagRetriever.retrieve()` to accept `{ queryText,
   queryVector }`, and add an optional change-notification interface so in-memory
   retrievers can patch incrementally instead of rebuilding.
3. **Vector threshold:** Orama's `DEFAULT_SIMILARITY = 0.8` must be overridden or
   results will silently vanish for weak-but-valid matches.
4. **Interaction with `docs/rag.md` #1:** the in-RAM matrix + worker plan overlaps
   with Orama holding vectors in RAM. If Option 1 lands, decide whether the worker
   offload wraps Orama or replaces its vector mode (keep Orama for BM25 only, RRF
   on top — converges with Option 2 plus our own matrix).
5. **Chunking order:** `docs/rag.md` #2 (heading-aware chunks + breadcrumbs) should
   land before or with BM25 indexing so the keyword index sees breadcrumbs too.

## Sources

- Orama repo: https://github.com/oramasearch/orama (Apache-2.0, v3.1.x)
- Vector internals: `packages/orama/src/trees/vector.ts` (Map-based linear scan,
  `DEFAULT_SIMILARITY = 0.8`, parallelization `@todo`)
- Hybrid scoring: `packages/orama/src/methods/search-hybrid.ts`
  (`minMaxScoreNormalization`, `hybridScoreBuilder` weighted sum,
  `getQueryWeights` auto-weights)
- Persistence: `packages/plugin-data-persistence/src/{index,server,types}.ts`
  (formats `json | dpack | binary | seqproto`; whole-instance persist/restore;
  file APIs server-only)
- obsidian-copilot deprecation trail: `src/search/dbOperations.ts`,
  `src/search/chunkedStorage.ts`, `src/search/hybridRetriever.ts`,
  `src/search/vectorStoreManager.ts` in
  https://github.com/logancyang/obsidian-copilot
- Internal baseline + prior review: `src/rag/` on branch `ragSQLite` and
  `docs/rag.md` (notably #1 in-RAM matrix, #3 BM25 + RRF, #6 pre-filtering)
