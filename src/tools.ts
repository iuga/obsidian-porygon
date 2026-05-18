import { tool } from "@langchain/core/tools";
import { App, normalizePath, prepareSimpleSearch, TFile, TFolder } from "obsidian";
import { DEFAULT_SEMANTIC_SEARCH_LIMIT, RagIndexProgress, RagSemanticSearchService } from "./rag";
import { z } from "zod";

const DEFAULT_VIEW_LIMIT = 2000;
const SEMANTIC_SNIPPET_MAX_CHARS = 320;
const MAX_VIEW_SIZE_BYTES = 200 * 1024;
const MAX_VIEW_LINE_LENGTH = 2000;

interface SearchResult {
	note: string;
	lines: number[];
}

interface EditResponseMetadata {
	additions: number;
	removals: number;
	old_content?: string;
	new_content?: string;
}

interface RenameResponseMetadata {
	source_path: string;
	destination_path: string;
	type: "file" | "folder";
}

const intentSchema = z.string().describe("Brief explanation in ten words or less of why you're calling this function and how it helps achieve the current goal. Use present participle form (e.g., 'Fetching...', 'Calculating...', 'Validating...'). Examples: 'Fetching all notes that contain order to gather context', 'Adding a new paragraph into the orders.md document'");

export const currentTimestampTool = tool(
	() => new Date().toISOString(),
	{
		name: "current_timestamp",
		description: "Returns the current timestamp in ISO 8601 format.",
		schema: z.object({
			intent: intentSchema,
		}),
	}
);

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

export function createListTool(app: App) {
	return tool(
		({ filter = "" }: { filter?: string }): string => {
			const trimmedFilter = filter.trim();
			const regex = trimmedFilter ? new RegExp(trimmedFilter) : null;
			const notes = app.vault.getMarkdownFiles()
				.filter((file) => !regex || regex.test(file.basename) || regex.test(file.name) || regex.test(file.path))
				.map((file) => file.path);

			return JSON.stringify(notes);
		},
		{
			name: "list",
			description: "Lists markdown note paths. If filter is provided, only returns notes whose filename or path matches the regex filter. Returns a JSON string array. Use it to find notes or discover paths for the view and edit tools. You can also use it to fix typos in links by listing notes with a regex that matches part of the path.",
			schema: z.object({
				intent: intentSchema,
				filter: z.string().optional().default("").describe("Optional regex used to filter note filenames or paths."),
			}),
		}
	);
}

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

export function createEditTool(app: App) {
	return tool(
		async ({ file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll = false }: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<string> => {
			const filename = normalizeMarkdownPath(filePath);
			const file = app.vault.getAbstractFileByPath(filename);

			try {
				if (!oldString) {
					if (file) {
						return `file already exists: ${filename}`;
					}

					await app.vault.create(filename, newString);
					return stringifyEditMetadata("", newString);
				}

				if (!(file instanceof TFile)) {
					return `file not found: ${filename}`;
				}

				const oldContent = await app.vault.cachedRead(file);
				const matchCount = countOccurrences(oldContent, oldString);
				if (matchCount === 0) {
					return "old_string not found in file. Make sure it matches exactly, including whitespace and line breaks.";
				}

				if (!replaceAll && matchCount > 1) {
					return "old_string appears multiple times in the file. Please provide more context to ensure a unique match, or set replace_all to true";
				}

				const newContent = replaceAll ? oldContent.split(oldString).join(newString) : oldContent.replace(oldString, newString);
				if (oldContent === newContent) {
					return "new content is the same as old content. No changes made.";
				}

				await app.vault.modify(file, newContent);
				return stringifyEditMetadata(oldContent, newContent);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
		{
			name: "edit",
			description: "Edit a markdown note by exact find-and-replace; can also create a new note or delete content. For existing files, old_string is mandatory and must never be empty: use view first, then copy exact text including whitespace, indentation, blank lines, and line breaks. Empty old_string is only allowed when creating a brand-new file that does not already exist. When replace_all is false, old_string must uniquely identify one occurrence; include 3-5 lines of surrounding context before and after the change. Delete content by providing old_string and leaving new_string empty. If old_string is not found, view the file again and copy a larger exact block; never guess. Correct example: old_string='## Summary\\n\\nThe catalog supports locale-aware attributes.\\n\\n## Details' and new_string='## Summary\\n\\nThe catalog supports locale-aware attributes and recommendations.\\n\\n## Details'. Incorrect examples: old_string='## Summary' because it lacks context, or old_string with one blank line when the file has two. Exact whitespace matters. Returns a JSON string with additions, removals, old_content, and new_content.",
			schema: z.object({
				intent: intentSchema,
				file_path: z.string().describe("The vault note path to create or modify. Use forward slashes. .md is appended if missing."),
				old_string: z.string().describe("The exact text to replace. Required and non-empty for existing files. Must match whitespace and line breaks exactly. Use an empty string only to create a brand-new note."),
				new_string: z.string().describe("The text to replace old_string with. Use an empty string to delete old_string."),
				replace_all: z.boolean().optional().default(false).describe("Replace all occurrences of old_string. Defaults to false; when false, old_string must match exactly one location."),
			}),
		}
	);
}

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

function buildSemanticWikilink(app: App, path: string): string {
	const file = app.vault.getAbstractFileByPath(path);
	if (file instanceof TFile) {
		return `[[${app.metadataCache.fileToLinktext(file, "", true)}]]`;
	}

	return `[[${path.replace(/\.md$/, "")}]]`;
}

function truncateSnippet(text: string): string {
	if (text.length <= SEMANTIC_SNIPPET_MAX_CHARS) {
		return text;
	}

	return `${text.slice(0, SEMANTIC_SNIPPET_MAX_CHARS)}…`;
}

export function createRenameTool(app: App) {
	return tool(
		async ({ source_path: sourcePath, destination_path: destinationPath }: { source_path: string; destination_path: string }): Promise<string> => {
			const source = normalizeVaultPath(sourcePath);
			const destination = normalizeVaultPath(destinationPath);
			const file = app.vault.getAbstractFileByPath(source);

			try {
				if (!source) {
					return "source_path is required.";
				}

				if (!destination) {
					return "destination_path is required.";
				}

				if (!file) {
					return `source path not found: ${source}`;
				}

				if (source === destination) {
					return "destination_path is the same as source_path. No changes made.";
				}

				if (app.vault.getAbstractFileByPath(destination)) {
					return `destination path already exists: ${destination}`;
				}

				const parentPath = getParentPath(destination);
				const parentFolder = parentPath ? app.vault.getAbstractFileByPath(parentPath) : null;
				if (parentPath && !(parentFolder instanceof TFolder)) {
					return `destination parent folder does not exist: ${parentPath}`;
				}

				await app.fileManager.renameFile(file, destination);
				return stringifyRenameMetadata(source, destination, file instanceof TFolder ? "folder" : "file");
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
		{
			name: "rename",
			description: "Rename or move a vault file or folder by exact vault-relative path. Use list first to confirm the source path and avoid filename guessing. source_path and destination_path must be vault-relative, use forward slashes, and destination_path must not already exist. Parent folders must already exist. Include the file extension when renaming files. Uses Obsidian FileManager.renameFile so internal links are updated safely according to Obsidian behavior. Returns a JSON string with source_path, destination_path, and type.",
			schema: z.object({
				intent: intentSchema,
				source_path: z.string().describe("The exact vault-relative path of the file or folder to rename or move. Use list to discover paths. Use forward slashes."),
				destination_path: z.string().describe("The exact vault-relative destination path. It must not already exist, and its parent folder must already exist. Include the file extension for files."),
			}),
		}
	);
}

export function createAgentTools(app: App, semanticSearch: RagSemanticSearchService, getIndexProgress: () => RagIndexProgress) {
	return [currentTimestampTool, createSemanticSearchTool(app, semanticSearch, getIndexProgress), createSearchTool(app), createListTool(app), createViewTool(app), createEditTool(app), createRenameTool(app)];
}

function getSemanticSearchFallbackMessage(progress: RagIndexProgress): string {
	if (progress.status === "indexing") {
		return `Semantic index is still building: ${progress.indexedFiles} / ${progress.totalFiles} notes indexed. Use search, list, or view for exact lookup while indexing continues.`;
	}

	if (progress.status === "error") {
		return `Semantic index is unavailable due to an indexing error: ${progress.lastError ?? "unknown error"}. Use search, list, or view as fallback.`;
	}

	return "No semantic index results found. The index may be empty or unavailable. Use search, list, or view as fallback.";
}

function normalizeMarkdownPath(filenameMd: string): string {
	const normalizedFilename = normalizePath(stripWikiLinkSyntax(filenameMd).replace(/\\/g, "/"));
	return normalizedFilename.endsWith(".md") ? normalizedFilename : `${normalizedFilename}.md`;
}

function normalizeVaultPath(path: string): string {
	return normalizePath(stripWikiLinkSyntax(path).replace(/\\/g, "/"));
}

function getParentPath(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

function getViewOffset(line: number | undefined, surrounding: number | undefined, offset: number | undefined): number {
	if (line !== undefined) {
		return Math.max(0, line - Math.max(0, surrounding ?? 5) - 1);
	}

	return Math.max(0, offset ?? 0);
}

function getViewLimit(line: number | undefined, surrounding: number | undefined, limit: number | undefined): number {
	if (line !== undefined) {
		return Math.max(1, (Math.max(0, surrounding ?? 5) * 2) + 1);
	}

	return Math.max(1, limit ?? DEFAULT_VIEW_LIMIT);
}

function truncateViewLine(line: string): string {
	return line.length > MAX_VIEW_LINE_LENGTH ? `${line.slice(0, MAX_VIEW_LINE_LENGTH)}...` : line;
}

function addLineNumbers(content: string, startLine: number): string {
	if (!content) {
		return "";
	}

	return content.split("\n").map((line, index) => {
		const lineNumber = String(startLine + index).padStart(6, " ");
		return `${lineNumber}|${line.replace(/\r$/, "")}`;
	}).join("\n");
}

function getFileNotFoundMessage(app: App, linkToMarkdownfile: string): string {
	const searchPath = stripWikiLinkSyntax(linkToMarkdownfile).replace(/\\/g, "/").toLowerCase();
	const searchBasename = searchPath.split("/").last()?.replace(/\.md$/, "") ?? searchPath;
	const suggestions = app.vault.getMarkdownFiles()
		.filter((file) => file.path.toLowerCase().contains(searchBasename) || searchBasename.contains(file.basename.toLowerCase()))
		.slice(0, 3)
		.map((file) => file.path);

	if (suggestions.length > 0) {
		return `File not found: ${linkToMarkdownfile}\n\nDid you mean one of these?\n${suggestions.join("\n")}`;
	}

	return `File not found: ${linkToMarkdownfile}`;
}

function stringifyEditMetadata(oldContent: string, newContent: string): string {
	const { additions, removals } = countLineChanges(oldContent, newContent);
	const result: EditResponseMetadata = {
		additions,
		removals,
		old_content: oldContent,
		new_content: newContent,
	};
	return JSON.stringify(result);
}

function stringifyRenameMetadata(sourcePath: string, destinationPath: string, type: "file" | "folder"): string {
	const result: RenameResponseMetadata = {
		source_path: sourcePath,
		destination_path: destinationPath,
		type,
	};
	return JSON.stringify(result);
}

function countOccurrences(content: string, searchValue: string): number {
	let count = 0;
	let startIndex = 0;
	while (startIndex < content.length) {
		const index = content.indexOf(searchValue, startIndex);
		if (index === -1) {
			break;
		}

		count += 1;
		startIndex = index + searchValue.length;
	}

	return count;
}

function countLineChanges(oldContent: string, newContent: string): { additions: number; removals: number } {
	const oldLines = splitDiffLines(oldContent);
	const newLines = splitDiffLines(newContent);
	const commonLineCount = countCommonSubsequence(oldLines, newLines);
	return {
		additions: newLines.length - commonLineCount,
		removals: oldLines.length - commonLineCount,
	};
}

function splitDiffLines(content: string): string[] {
	return content.length === 0 ? [] : content.split(/\r?\n/);
}

function countCommonSubsequence(oldLines: string[], newLines: string[]): number {
	const previousRow = new Array<number>(newLines.length + 1).fill(0);
	const currentRow = new Array<number>(newLines.length + 1).fill(0);

	oldLines.forEach((oldLine) => {
		newLines.forEach((newLine, newIndex) => {
			currentRow[newIndex + 1] = oldLine === newLine
				? (previousRow[newIndex] ?? 0) + 1
				: Math.max(previousRow[newIndex + 1] ?? 0, currentRow[newIndex] ?? 0);
		});

		for (let index = 0; index < currentRow.length; index += 1) {
			previousRow[index] = currentRow[index] ?? 0;
			currentRow[index] = 0;
		}
	});

	return previousRow[newLines.length] ?? 0;
}

function resolveMarkdownFile(app: App, linkToMarkdownfile: string): TFile | null {
	const normalizedLink = stripWikiLinkSyntax(linkToMarkdownfile).replace(/\\/g, "/");
	const withoutSubpath = normalizedLink.split("#")[0] ?? normalizedLink;
	const withoutAlias = withoutSubpath.split("|")[0] ?? withoutSubpath;
	const trimmedPath = withoutAlias.trim();
	const pathCandidates = trimmedPath.endsWith(".md") ? [trimmedPath] : [trimmedPath, `${trimmedPath}.md`];

	for (const pathCandidate of pathCandidates) {
		const file = app.vault.getAbstractFileByPath(pathCandidate);
		if (file instanceof TFile) {
			return file;
		}
	}

	const destination = app.metadataCache.getFirstLinkpathDest(trimmedPath, "");
	return destination instanceof TFile ? destination : null;
}

function stripWikiLinkSyntax(link: string): string {
	const trimmedLink = link.trim();
	if (trimmedLink.startsWith("[[") && trimmedLink.endsWith("]]")) {
		return trimmedLink.slice(2, -2);
	}

	return trimmedLink;
}
