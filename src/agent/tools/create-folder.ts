import { tool } from "@langchain/core/tools";
import { App, TFolder } from "obsidian";
import { z } from "zod";
import {
	getParentPath,
	intentSchema,
	normalizeVaultPath,
	toToolErrorMessage,
	withApproval,
} from "./shared";

export function createCreateFolderTool(app: App, getYolo: () => boolean) {
	return tool(
		async ({ folder_path: folderPath }: { folder_path: string }): Promise<string> => {
			const folder = normalizeVaultPath(folderPath);

			try {
				if (!folder) {
					return "folder_path is required.";
				}

				if (app.vault.getAbstractFileByPath(folder)) {
					return `folder path already exists: ${folder}`;
				}

				const parentPath = getParentPath(folder);
				const parentFolder = parentPath ? app.vault.getAbstractFileByPath(parentPath) : null;
				if (parentPath && !(parentFolder instanceof TFolder)) {
					return `parent folder does not exist: ${parentPath}`;
				}

				return await withApproval(
					`Create folder \`${folder}\`?`,
					`creating folder: ${folder}`,
					getYolo,
					async () => {
						const createdFolder = await app.vault.createFolder(folder);
						return JSON.stringify({ path: createdFolder.path, type: "folder" });
					},
				);
			} catch (error) {
				return toToolErrorMessage(error);
			}
		},
		{
			name: "create_folder",
			description: "Create a new vault folder by exact vault-relative path using Obsidian Vault.createFolder. Use forward slashes. The folder must not already exist, and its parent folder must already exist. Use this before creating or moving notes into a new folder. Returns a JSON string with path and type.",
			schema: z.object({
				intent: intentSchema,
				folder_path: z.string().describe("The exact vault-relative folder path to create. Use forward slashes. Do not include a trailing slash."),
			}),
		}
	);
}
