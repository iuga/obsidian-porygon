import { tool } from "@langchain/core/tools";
import { App } from "obsidian";
import { z } from "zod";
import {
	addLineNumbers,
	DEFAULT_VIEW_LIMIT,
	getFileNotFoundMessage,
	getViewLimit,
	getViewOffset,
	intentSchema,
	MAX_VIEW_SIZE_BYTES,
	resolveMarkdownFile,
	truncateViewLine,
} from "./shared";

export function createViewTool(app: App) {
	return tool(
		async ({ linkToMarkdownfile, line, surrounding = 5, offset, limit }: { linkToMarkdownfile: string; line?: number; surrounding?: number; offset?: number; limit?: number }): Promise<string> => {
			const file = resolveMarkdownFile(app, linkToMarkdownfile);
			if (!file) {
				return getFileNotFoundMessage(app, linkToMarkdownfile);
			}

			if (file.stat.size > MAX_VIEW_SIZE_BYTES) {
				return `File is too large (${file.stat.size} bytes). Maximum size is ${MAX_VIEW_SIZE_BYTES} bytes`;
			}

			const content = await app.vault.cachedRead(file);
			const lines = content.split(/\r?\n/);
			const readOffset = getViewOffset(line, surrounding, offset);
			const readLimit = getViewLimit(line, surrounding, limit);
			const selectedLines = lines.slice(readOffset, readOffset + readLimit).map(truncateViewLine);
			const hasMore = readOffset + selectedLines.length < lines.length;
			let output = `<file path="${file.path}">\n`;
			output += addLineNumbers(selectedLines.join("\n"), readOffset + 1);
			if (hasMore) {
				output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${readOffset + selectedLines.length})`;
			}
			output += "\n</file>";

			return output;
		},
		{
			name: "view",
			description: "Read a markdown note by path or wikilink with line numbers. Supports offset and line limit; default limit is 2000 lines and max file size is 200KB. Use list to find note paths first. Use view before edit so exact whitespace, indentation, and surrounding context can be copied. If line is provided, returns that 1-based line with surrounding lines before and after it; surrounding defaults to 5. Very long lines are truncated for display. Use offset to continue reading large files when the response says more lines are available.",
			schema: z.object({
				intent: intentSchema,
				linkToMarkdownfile: z.string().describe("The note path or wikilink to read. Use list to discover paths."),
				line: z.number().int().positive().optional().describe("Optional 1-based line number to center the returned excerpt on."),
				surrounding: z.number().int().min(0).optional().default(5).describe("Optional number of lines before and after the target line. Defaults to 5."),
				offset: z.number().int().min(0).optional().describe("Optional 0-based line offset to start reading from. Ignored when line is provided."),
				limit: z.number().int().positive().optional().default(DEFAULT_VIEW_LIMIT).describe("Optional number of lines to read. Defaults to 2000. Ignored when line is provided."),
			}),
		}
	);
}
