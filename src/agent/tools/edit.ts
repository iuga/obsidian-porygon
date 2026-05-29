import { tool } from "@langchain/core/tools";
import { App, TFile } from "obsidian";
import { z } from "zod";
import {
	countOccurrences,
	intentSchema,
	normalizeMarkdownPath,
	stringifyEditMetadata,
	toToolErrorMessage,
	withApproval,
} from "./shared";

export function createEditTool(app: App, getYolo: () => boolean) {
	return tool(
		async ({ file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll = false }: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<string> => {
			const filename = normalizeMarkdownPath(filePath);
			const file = app.vault.getAbstractFileByPath(filename);

			try {
				if (!oldString) {
					if (file) {
						return `file already exists: ${filename}`;
					}

					return await withApproval(
						`Create note \`${filename}\`?`,
						`creating note: ${filename}`,
						getYolo,
						async () => {
							await app.vault.create(filename, newString);
							return stringifyEditMetadata("", newString);
						},
					);
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

				const action = newString === "" ? "Delete content from" : "Edit";
				return await withApproval(
					`${action} note \`${filename}\`?`,
					`editing note: ${filename}`,
					getYolo,
					async () => {
						await app.vault.modify(file, newContent);
						return stringifyEditMetadata(oldContent, newContent);
					},
				);
			} catch (error) {
				return toToolErrorMessage(error);
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
