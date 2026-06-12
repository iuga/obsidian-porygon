# RAG pipeline review: Obsidian plugin

## Verdict

The architecture is sound and matches what mature plugins (Smart Connections, Copilot) do: local embeddings, incremental indexing, IndexedDB persistence. Keep it. The gaps are (a) the query-time data path and (b) retrieval quality, which is vector-only with structure-blind chunks. Recommendations below, in priority order.

## 1. Keep brute force. Do not add HNSW

Counterintuitive but well measured: at real embedding dimensions (512-3072), optimized brute force beats HNSW in the browser at every practical scale. HNSW only wins past ~500k vectors at low dims, and persisting a graph index to IndexedDB is slow and corruption-prone. A 100k-chunk vault is brute-force territory.

What to optimize instead:

- Hold all vectors for the active model in RAM as **one contiguous `Float32Array`** (a matrix), loaded from IndexedDB once at startup, patched incrementally as files change. Never scan IndexedDB per query.
- **Normalize vectors at index time.** Cosine becomes a plain dot product, no norms at query time.
- Score in a **Web Worker**. Keep the matrix there; send only the query vector and get back top results.
- Use partial top-k selection (small max-heap), not a full sort of all scores.

Expected result: sub-50ms query on ~100k chunks before any quantization.

Agent prompt:

```
In src/rag/, the semantic search scans stored vectors per query. Refactor the query path: load all vectors for the active embedding model from IndexedDB once into a single contiguous Float32Array matrix (one row per chunk, plus a parallel array of chunk ids), cache it across queries, and patch rows incrementally when the indexer adds, updates, or deletes chunks. Normalize vectors at index time and the query vector at query time so similarity is a plain dot product. Move scoring into a Web Worker that owns the matrix; the main thread sends only the query vector and receives top-k ids and scores. Replace the full sort with a fixed-size max-heap for top-k selection. Do not change the IndexedDB schema.
```

## 2. Binary quantization (the big win for large vaults)

100k chunks at 768 dims is ~300 MB of Float32 in RAM. Quantized to binary it is ~9.6 MB.

- Threshold each normalized dimension at 0 → 1 bit. Pack into `Uint32Array` (768 dims → 24 words).
- Search with **Hamming distance** (XOR + popcount), which is far cheaper than float dot products.
- **Always rescore:** take the top `k * 4` candidates by Hamming, fetch only those Float32 vectors from IndexedDB, rescore with the full-precision query, return top 8.

This retains ~96% of retrieval quality with 32x less memory and up to ~30-40x faster scoring. Store binary alongside Float32 at index time; it costs almost nothing.

Make it conditional: below ~20k chunks plain Float32 brute force is already fast, so quantization can kick in only for large vaults.

Agent prompt:

```
Add binary quantization to the RAG pipeline in src/rag/. At index time, after normalizing each embedding, derive a binary signature: threshold each dimension at 0 and pack the bits into a Uint32Array (dims/32 words); store it alongside the Float32 vector in IndexedDB and bump the index schema version. At query time, when the chunk count for the active model exceeds a threshold (default 20000), score all signatures in RAM with Hamming distance (XOR plus popcount), take the top k*4 candidates, fetch only their Float32 vectors from IndexedDB, rescore them with a dot product against the full-precision query embedding, and return the top k. Below the threshold keep the existing Float32 path unchanged.
```

## 3. Add keyword search (BM25) and fuse results

Embeddings miss exact matches: function names, acronyms, people, project codenames. This is the biggest *quality* gap in a vector-only pipeline.

- Build an in-memory keyword index over the same chunks (MiniSearch or Orama, both small JS libs with BM25-style scoring). Rebuild from the chunk store at startup; update incrementally.
- Run both searches, merge with **reciprocal rank fusion** (RRF): `score = Σ 1/(60 + rank)`. No score normalization needed.

Anthropic's published pipeline (context-enriched chunks + embeddings + BM25) cut top-20 retrieval failures from 5.7% to 2.9%; adding a reranker reached 1.9%.

Agent prompt:

```
Add hybrid retrieval to src/rag/semantic-search.ts. Build an in-memory keyword index with MiniSearch over the same chunk records used for vector search, indexing the chunk text with the chunk id as key; populate it from the chunk store at startup and keep it in sync with the indexer's add, update, and delete flow. At query time run the vector search and the keyword search, take the top 20 from each, and merge with reciprocal rank fusion: score(chunk) = sum over both lists of 1/(60 + rank). Return the top N fused results in the existing record shape (text, title, path, score). Add a setting to disable keyword search and fall back to vector-only.
```

## 4. Heading-aware chunking with breadcrumb prefix

Markdown-aware splitting (on headings) beats fixed-size splitting by 5-10 points in published evals, and notes are heading-structured.

- Split on headings first, then apply the recursive splitter *within* sections that exceed ~1200 chars. Keep 200 overlap inside sections only. Do not split code blocks or tables.
- Prepend a breadcrumb to each chunk's text before embedding and BM25 indexing: `Note Title > H2 > H3`. This is the free, deterministic version of Anthropic's contextual retrieval (theirs uses an LLM per chunk; the heading path gives most of the benefit at zero cost).
- The breadcrumb must be in the chunk text itself, not just metadata, so both the vector and the keyword index see it.

Requires a reindex (bump your schema version, which you already support).

Agent prompt:

```
Rework chunking in src/rag/chunks.ts. After stripping frontmatter, split the note on markdown headings first, tracking the heading path of each section; apply the existing recursive character splitter (1200 chars, 200 overlap) only inside sections that exceed ~1200 chars, and never split fenced code blocks or tables. Prepend a breadcrumb line to each chunk's text before it is embedded or keyword-indexed, formatted as "Note Title > H2 > H3" using the file basename and the section's heading path (title only when there are no headings). Keep the 256-chunk-per-file cap. Bump the index schema version so existing indexes rebuild.
```

## 5. Optional: rerank before returning

Retrieve top 30-50 candidates, rerank to 8 with a cross-encoder. Largest single precision gain in published pipelines, but the local story is awkward: Ollama has no official rerank API (community Qwen3-Reranker models exist via a scoring workaround), so the practical route is a small ONNX cross-encoder via transformers.js inside the plugin (Smart Connections proves that runtime works in Obsidian). Adds a few hundred ms. Ship behind a setting, after 1-4 are done.

Agent prompt:

```
Add an optional reranking stage to src/rag/semantic-search.ts, off by default behind a setting. When enabled, retrieve the top 40 candidates from the existing retrieval path, score each (query, chunk text) pair with a local cross-encoder running on transformers.js (a small ONNX reranker such as mxbai-rerank-xs or a bge-reranker variant), sort by reranker score, and return the top N. Lazy-load the model on first use, run inference off the main thread, truncate chunk text to the model's max input length, and fall back silently to the unreranked results if the model fails to load or errors.
```

## 6. Smaller wins

- Initial indexing: Ollama's `/api/embed` accepts arrays; raise batch size and run 2-3 batches concurrently. Indexing speed is usually model-bound, not pipeline-bound.
- Return **neighbor chunks** of each hit (prev/next in the same file) instead of raising top-k. Better answer context, same retrieval cost.
- Add a minimum-score threshold next to top-8 so weak matches drop out on small vaults.
- If the UI allows folder/tag filtering, filter *before* scoring; pre-filtering eliminates compute, it doesn't hide it.

Agent prompt:

```
Make four small improvements to src/rag/. One: in the indexer, raise the Ollama embedding batch size from 16 to 32 and run up to 3 batch requests concurrently, keeping the existing debounced, yield-to-event-loop behavior. Two: in semantic-search, after selecting the top results, fetch each hit's previous and next chunk from the same file and attach them as neighbor context on the result record, without changing the returned count. Three: add a configurable minimum similarity score so weak matches are dropped even if fewer than N results remain. Four: accept an optional folder or tag filter on the search call and apply it before scoring so excluded chunks are never scored.
```

## Keep as is

mtime+size staleness with hash fallback, per-model keying, transactional replace + orphan cleanup, schema-versioned DB names, debounced incremental batches, 256-chunk cap, ~1200/200 chunk size (within sections).

## Suggested order

1. In-RAM matrix + normalization + worker (speed, no reindex)
2. Heading-aware chunking + breadcrumbs (quality, needs reindex, do before #3 so BM25 indexes the breadcrumbs)
3. BM25 + RRF (quality)
4. Binary quantization (speed/memory at scale)
5. Reranker (optional)

## Sources

- Brute force vs HNSW in browser/WASM benchmarks: https://dev.to/thealpha93/i-built-a-vector-search-library-in-rustwasm-heres-what-i-learned-about-performance-browser-172c
- Binary quantization + rescoring (~96% quality, 32x memory): https://www.sbert.net/examples/sentence_transformer/applications/embedding-quantization/README.html
- Qdrant: use binary quantization only with rescoring: https://qdrant.tech/documentation/manage-data/quantization/
- Anthropic contextual retrieval (hybrid + rerank failure rates): https://www.anthropic.com/news/contextual-retrieval
- Markdown-aware chunking +5-10 pts (Snowflake finance RAG eval): https://www.snowflake.com/en/engineering-blog/impact-retrieval-chunking-finance-rag/
- Free contextual chunk headers (breadcrumb prefix for hybrid): https://dev.to/kartikeyraj/free-contextual-chunk-headers-heading-aware-chunking-for-hybrid-retrieval-560
- HNSW-on-IndexedDB pain (MeMemo, WebANNS papers): https://arxiv.org/abs/2407.01972 , https://arxiv.org/abs/2507.00521
