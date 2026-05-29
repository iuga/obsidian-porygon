import { tool } from "@langchain/core/tools";
import { App } from "obsidian";
import { z } from "zod";
import { DEFAULT_SEMANTIC_SEARCH_LIMIT, RagIndexProgress, RagSemanticSearchService } from "../../rag";
import {
	buildSemanticWikilink,
	getSemanticSearchFallbackMessage,
	intentSchema,
	truncateSnippet,
} from "./shared";

export function createSemanticSearchTool(app: App, semanticSearch: RagSemanticSearchService, getProgress: () => RagIndexProgress) {
	return tool(
		async ({ query, limit = DEFAULT_SEMANTIC_SEARCH_LIMIT }: { query: string; limit?: number }): Promise<string> => {
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
			name: "semantic_search",
			description: "Semantically searches indexed Markdown notes using natural language and returns JSON results with matching note paths, wikilinks, similarity scores, and snippets. Use this for vague or contextual requests about notes, projects, concepts, people, meetings, ideas, or related information when exact keyword search may miss relevant files. Use view afterwards when you need full file context.",
			schema: z.object({
				intent: intentSchema,
				query: z.string().describe("Natural-language description of the vault information to find."),
				limit: z.number().int().min(1).max(20).optional().default(DEFAULT_SEMANTIC_SEARCH_LIMIT).describe(`Maximum number of matching chunks to return. Defaults to ${DEFAULT_SEMANTIC_SEARCH_LIMIT}.`),
			}),
		}
	);
}
