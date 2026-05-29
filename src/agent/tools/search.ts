import { tool } from "@langchain/core/tools";
import { App, prepareSimpleSearch } from "obsidian";
import { z } from "zod";
import { intentSchema } from "./shared";

interface SearchResult {
	note: string;
	lines: number[];
}

export function createSearchTool(app: App) {
	return tool(
		async ({ queryString }: { queryString: string }): Promise<string> => {
			const search = prepareSimpleSearch(queryString);
			const results: SearchResult[] = [];

			for (const file of app.vault.getMarkdownFiles()) {
				const content = await app.vault.cachedRead(file);
				const lines = content.split(/\r?\n/);
				const matchingLines: number[] = [];

				lines.forEach((line, index) => {
					if (search(line)) {
						matchingLines.push(index + 1);
					}
				});

				if (matchingLines.length > 0) {
					results.push({ note: file.path, lines: matchingLines });
				}
			}

			return JSON.stringify(results);
		},
		{
			name: "search",
			description: "Searches all markdown notes for the query string and returns a JSON string of matching note paths with 1-based line numbers.",
			schema: z.object({
				intent: intentSchema,
				queryString: z.string().describe("The query string to search for in all markdown notes."),
			}),
		}
	);
}
