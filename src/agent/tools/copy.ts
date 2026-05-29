import { tool } from "@langchain/core/tools";
import { App, TFolder } from "obsidian";
import { z } from "zod";
import {
	intentSchema,
	normalizeVaultPath,
	stringifyRenameMetadata,
	toToolErrorMessage,
	validateMovePaths,
} from "./shared";

export function createCopyTool(app: App) {
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
				const copiedFile = await app.vault.copy(file, destination);
				return stringifyRenameMetadata(source, copiedFile.path, copiedFile instanceof TFolder ? "folder" : "file");
			} catch (error) {
				return toToolErrorMessage(error);
			}
		},
		{
			name: "copy",
			description: "Copy a vault file or folder by exact vault-relative path using Obsidian Vault.copy. Use list first to confirm the source path and avoid filename guessing. source_path and destination_path must be vault-relative, use forward slashes, and destination_path must not already exist. Parent folders must already exist. Include the file extension when copying files. Returns a JSON string with source_path, destination_path, and type.",
			schema: z.object({
				intent: intentSchema,
				source_path: z.string().describe("The exact vault-relative path of the file or folder to copy. Use list to discover paths. Use forward slashes."),
				destination_path: z.string().describe("The exact vault-relative destination path for the copy. It must not already exist, and its parent folder must already exist. Include the file extension for files."),
			}),
		}
	);
}
