import { tool } from "@langchain/core/tools";
import { App } from "obsidian";
import { z } from "zod";
import { DEFAULT_SEARCH_LIMIT, RagIndexProgress, RagSemanticSearchService } from "../../rag";
import {
	buildSemanticWikilink,
	getSemanticSearchFallbackMessage,
	intentSchema,
	truncateSnippet,
} from "./shared";

export function createSearchTool(app: App, semanticSearch: RagSemanticSearchService, getProgress: () => RagIndexProgress) {
	return tool(
		async ({ query, limit = DEFAULT_SEARCH_LIMIT }: { query: string; limit?: number }): Promise<string> => {
			if (!semanticSearch.isConfigured()) {
				return JSON.stringify({
					results: [],
					message: "Search is disabled because no embeddings model is configured. Set one under Settings → Community plugins → Porygon to enable search.",
				});
			}

			const results = await semanticSearch.search({ query, limit });
			if (results.length === 0) {
				return JSON.stringify({ results: [], message: getSemanticSearchFallbackMessage(getProgress()) });
			}

			return JSON.stringify({
				results: results.map((result) => ({
					path: result.path,
					wikilink: buildSemanticWikilink(app, result.path),
					title: result.title,
					chunk_index: result.chunkIndex,
					score: result.score,
					snippet: truncateSnippet(result.text),
				})),
			});
		},
		{
			name: "search",
			description: "Searches indexed Markdown notes with a hybrid of keyword (BM25) and semantic vector matching, returning JSON results with note paths, wikilinks, relevance scores, and snippets. Use it for both exact text, filenames, or quoted phrases and vague or contextual requests about topics, projects, people, meetings, ideas, or concepts. Use view afterwards when you need full file context. Search is unavailable until an embeddings model is configured and indexing has run.",
			schema: z.object({
				intent: intentSchema,
				query: z.string().describe("What to find: exact words, a filename, or a natural-language description of the vault information you need."),
				limit: z.number().int().min(1).max(20).optional().default(DEFAULT_SEARCH_LIMIT).describe(`Maximum number of matching chunks to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`),
			}),
		}
	);
}
