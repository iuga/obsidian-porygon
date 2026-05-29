import { tool } from "@langchain/core/tools";
import { App, TFolder } from "obsidian";
import { z } from "zod";
import {
	intentSchema,
	normalizeVaultPath,
	stringifyRenameMetadata,
	toToolErrorMessage,
	validateMovePaths,
	withApproval,
} from "./shared";

export function createRenameTool(app: App, getYolo: () => boolean) {
	return tool(
		async ({ source_path: sourcePath, destination_path: destinationPath }: { source_path: string; destination_path: string }): Promise<string> => {
			const source = normalizeVaultPath(sourcePath);
			const destination = normalizeVaultPath(destinationPath);

			try {
				const validationError = validateMovePaths(app, source, destination);
				if (validationError) {
					return validationError;
				}

				const file = app.vault.getAbstractFileByPath(source)!;
				const kind = file instanceof TFolder ? "folder" : "file";

				return await withApproval(
					`Rename ${kind} \`${source}\` to \`${destination}\`?`,
					`renaming ${kind}: ${source} -> ${destination}`,
					getYolo,
					async () => {
						await app.fileManager.renameFile(file, destination);
						return stringifyRenameMetadata(source, destination, kind);
					},
				);
			} catch (error) {
				return toToolErrorMessage(error);
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
