import { tool } from "@langchain/core/tools";
import { App, TFile } from "obsidian";
import { z } from "zod";
import {
	buildSemanticWikilink,
	getBacklinkReferences,
	getFileNotFoundMessage,
	intentSchema,
	resolveMarkdownFile,
} from "./shared";

interface BacklinkResult {
	source_path: string;
	wikilink: string;
	link_count: number;
	references: ReturnType<typeof getBacklinkReferences>;
}

export function createBacklinksTool(app: App) {
	return tool(
		({ linkToMarkdownfile }: { linkToMarkdownfile: string }): string => {
			const targetFile = resolveMarkdownFile(app, linkToMarkdownfile);
			if (!targetFile) {
				return getFileNotFoundMessage(app, linkToMarkdownfile);
			}

			const backlinks: BacklinkResult[] = Object.entries(app.metadataCache.resolvedLinks)
				.filter(([, links]) => (links[targetFile.path] ?? 0) > 0)
				.map(([sourcePath, links]) => {
					const sourceFile = app.vault.getAbstractFileByPath(sourcePath);
					return {
						source_path: sourcePath,
						wikilink: buildSemanticWikilink(app, sourcePath),
						link_count: links[targetFile.path] ?? 0,
						references: sourceFile instanceof TFile ? getBacklinkReferences(app, sourceFile, targetFile) : [],
					};
				});

			return JSON.stringify({
				target_path: targetFile.path,
				wikilink: buildSemanticWikilink(app, targetFile.path),
				backlinks,
			});
		},
		{
			name: "backlinks",
			description: "Return notes that link to a target Markdown note using Obsidian MetadataCache resolved links. Accepts a note path or wikilink, resolves it like view, and returns JSON with the target path, target wikilink, backlink source paths, source wikilinks, link counts, and per-reference link text with 1-based line numbers when cached metadata is available. Use this to answer what references a note, find related notes, detect context around a note, or audit inbound links without scanning full note contents.",
			schema: z.object({
				intent: intentSchema,
				linkToMarkdownfile: z.string().describe("The target Markdown note path or wikilink whose backlinks should be returned. Use list to discover paths when needed."),
			}),
		}
	);
}
