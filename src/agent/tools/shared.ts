import { interrupt, isGraphBubbleUp } from "@langchain/langgraph";
import { App, normalizePath, TFile, TFolder } from "obsidian";
import { z } from "zod";
import { RagIndexProgress } from "../../rag";

export interface AskUserInterruptPayload {
	question: string;
	options: string[];
}

export type ApprovalDecision =
	| { kind: "approve" }
	| { kind: "deny" }
	| { kind: "deny_with_feedback"; feedback: string };

export interface EditResponseMetadata {
	additions: number;
	removals: number;
	old_content?: string;
	new_content?: string;
}

export interface RenameResponseMetadata {
	source_path: string;
	destination_path: string;
	type: "file" | "folder";
}

export interface BacklinkReference {
	link: string;
	original: string;
	display_text?: string;
	line: number;
}

export const APPROVE_LABEL = "Approve";
export const DENY_LABEL = "Deny";
// Reserved labels above must stay in sync with the popover UI in
// view.ts (Approve/Deny buttons). Any other reply is treated as
// `deny_with_feedback` so the agent gets the user's free-form rationale.

export const DEFAULT_VIEW_LIMIT = 2000;
export const SEMANTIC_SNIPPET_MAX_CHARS = 320;
export const MAX_VIEW_SIZE_BYTES = 200 * 1024;
export const MAX_VIEW_LINE_LENGTH = 2000;

export const intentSchema = z.string().describe("Brief explanation in ten words or less of why you're calling this function and how it helps achieve the current goal. Use present participle form (e.g., 'Fetching...', 'Calculating...', 'Validating...'). Examples: 'Fetching all notes that contain order to gather context', 'Adding a new paragraph into the orders.md document'");

export function requestApproval(question: string, getYolo: () => boolean): ApprovalDecision {
	if (getYolo()) {
		return { kind: "approve" };
	}
	const payload: AskUserInterruptPayload = {
		question,
		options: [APPROVE_LABEL, DENY_LABEL],
	};
	const reply = interrupt<AskUserInterruptPayload, unknown>(payload);
	const text = typeof reply === "string" ? reply.trim() : "";
	if (text === APPROVE_LABEL) {
		return { kind: "approve" };
	}
	if (text === DENY_LABEL || text === "") {
		return { kind: "deny" };
	}
	return { kind: "deny_with_feedback", feedback: text };
}

// Wraps a mutating action with the approval flow. If the user denies (with or
// without feedback), returns the formatted denial message; otherwise runs the
// action and returns its result. `denialSubject` is the human-readable action
// being denied, e.g. "editing note: foo.md".
export async function withApproval<T>(
	question: string,
	denialSubject: string,
	getYolo: () => boolean,
	action: () => Promise<T> | T,
): Promise<T | string> {
	const decision = requestApproval(question, getYolo);
	if (decision.kind === "deny") {
		return `User denied ${denialSubject}`;
	}
	if (decision.kind === "deny_with_feedback") {
		return `User denied ${denialSubject}. Feedback: ${decision.feedback}`;
	}
	return action();
}

export function toToolErrorMessage(error: unknown): string {
	if (isGraphBubbleUp(error)) {
		throw error;
	}
	return error instanceof Error ? error.message : String(error);
}

export function normalizeMarkdownPath(filenameMd: string): string {
	const normalizedFilename = normalizePath(stripWikiLinkSyntax(filenameMd).replace(/\\/g, "/"));
	return normalizedFilename.endsWith(".md") ? normalizedFilename : `${normalizedFilename}.md`;
}

export function normalizeVaultPath(path: string): string {
	return normalizePath(stripWikiLinkSyntax(path).replace(/\\/g, "/"));
}

export function getParentPath(path: string): string {
	return path.split("/").slice(0, -1).join("/");
}

export function stripWikiLinkSyntax(link: string): string {
	const trimmedLink = link.trim();
	if (trimmedLink.startsWith("[[") && trimmedLink.endsWith("]]")) {
		return trimmedLink.slice(2, -2);
	}

	return trimmedLink;
}

export function resolveMarkdownFile(app: App, linkToMarkdownfile: string): TFile | null {
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

export function getFileNotFoundMessage(app: App, linkToMarkdownfile: string): string {
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

export function buildSemanticWikilink(app: App, path: string): string {
	const file = app.vault.getAbstractFileByPath(path);
	if (file instanceof TFile) {
		return `[[${app.metadataCache.fileToLinktext(file, "", true)}]]`;
	}

	return `[[${path.replace(/\.md$/, "")}]]`;
}

export function truncateSnippet(text: string): string {
	if (text.length <= SEMANTIC_SNIPPET_MAX_CHARS) {
		return text;
	}

	return `${text.slice(0, SEMANTIC_SNIPPET_MAX_CHARS)}…`;
}

export function getSemanticSearchFallbackMessage(progress: RagIndexProgress): string {
	if (progress.status === "indexing") {
		return `Semantic index is still building: ${progress.indexedFiles} / ${progress.totalFiles} notes indexed. Use search, list, or view for exact lookup while indexing continues.`;
	}

	if (progress.status === "error") {
		return `Semantic index is unavailable due to an indexing error: ${progress.lastError ?? "unknown error"}. Use search, list, or view as fallback.`;
	}

	return "No semantic index results found. The index may be empty or unavailable. Use search, list, or view as fallback.";
}

export function getViewOffset(line: number | undefined, surrounding: number | undefined, offset: number | undefined): number {
	if (line !== undefined) {
		return Math.max(0, line - Math.max(0, surrounding ?? 5) - 1);
	}

	return Math.max(0, offset ?? 0);
}

export function getViewLimit(line: number | undefined, surrounding: number | undefined, limit: number | undefined): number {
	if (line !== undefined) {
		return Math.max(1, (Math.max(0, surrounding ?? 5) * 2) + 1);
	}

	return Math.max(1, limit ?? DEFAULT_VIEW_LIMIT);
}

export function truncateViewLine(line: string): string {
	return line.length > MAX_VIEW_LINE_LENGTH ? `${line.slice(0, MAX_VIEW_LINE_LENGTH)}...` : line;
}

export function addLineNumbers(content: string, startLine: number): string {
	if (!content) {
		return "";
	}

	return content.split("\n").map((line, index) => {
		const lineNumber = String(startLine + index).padStart(6, " ");
		return `${lineNumber}|${line.replace(/\r$/, "")}`;
	}).join("\n");
}

export function stringifyEditMetadata(oldContent: string, newContent: string): string {
	const { additions, removals } = countLineChanges(oldContent, newContent);
	const result: EditResponseMetadata = {
		additions,
		removals,
		old_content: oldContent,
		new_content: newContent,
	};
	return JSON.stringify(result);
}

export function stringifyRenameMetadata(sourcePath: string, destinationPath: string, type: "file" | "folder"): string {
	const result: RenameResponseMetadata = {
		source_path: sourcePath,
		destination_path: destinationPath,
		type,
	};
	return JSON.stringify(result);
}

export function getBacklinkReferences(app: App, sourceFile: TFile, targetFile: TFile): BacklinkReference[] {
	const sourceCache = app.metadataCache.getFileCache(sourceFile);
	const references = sourceCache?.links ?? [];
	return references
		.filter((reference) => app.metadataCache.getFirstLinkpathDest(reference.link, sourceFile.path)?.path === targetFile.path)
		.map((reference) => ({
			link: reference.link,
			original: reference.original,
			display_text: reference.displayText,
			line: reference.position.start.line + 1,
		}));
}

export function countOccurrences(content: string, searchValue: string): number {
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

export function countLineChanges(oldContent: string, newContent: string): { additions: number; removals: number } {
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

// Validates that a move/copy from `source` to `destination` is structurally
// possible. Returns an error string when invalid, or null when the operation
// can proceed. Used by both rename and copy tools.
export function validateMovePaths(app: App, source: string, destination: string): string | null {
	if (!source) {
		return "source_path is required.";
	}

	if (!destination) {
		return "destination_path is required.";
	}

	if (!app.vault.getAbstractFileByPath(source)) {
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

	return null;
}
