import { tool } from "@langchain/core/tools";
import { App } from "obsidian";
import { z } from "zod";
import { buildSemanticWikilink, intentSchema } from "./shared";

export function createActiveFileTool(app: App) {
	return tool(
		({ include_metadata: includeMetadata = false }: { include_metadata?: boolean }): string => {
			const activeFile = app.workspace.getActiveFile();
			if (!activeFile) {
				return JSON.stringify({ active_file: null, message: "No active file." });
			}

			const result = {
				active_file: {
					path: activeFile.path,
					name: activeFile.name,
					basename: activeFile.basename,
					extension: activeFile.extension,
					wikilink: buildSemanticWikilink(app, activeFile.path),
					stat: activeFile.stat,
					metadata: includeMetadata ? app.metadataCache.getFileCache(activeFile) : undefined,
				},
			};

			return JSON.stringify(result);
		},
		{
			name: "active_file",
			description: "Return the currently active Obsidian file from the workspace as JSON. Use this when the user refers to 'this note', 'the current file', or similar context without naming a path. Optionally include Obsidian cached metadata for the active file. This tool does not read file contents; use view afterwards if content is needed.",
			schema: z.object({
				intent: intentSchema,
				include_metadata: z.boolean().optional().default(false).describe("Whether to include Obsidian cached metadata such as links, tags, headings, and frontmatter for the active file. Defaults to false."),
			}),
		}
	);
}
