import { tool } from "@langchain/core/tools";
import { App, TFolder } from "obsidian";
import { z } from "zod";
import { intentSchema } from "./shared";

const MAX_FOLDER_DEPTH = 16;

export function createListTool(app: App) {
	return tool(
		({ filter = "" }: { filter?: string }): string => {
			const trimmedFilter = filter.trim();
			const regex = trimmedFilter ? new RegExp(trimmedFilter) : null;
			const notes = app.vault.getMarkdownFiles()
				.filter((file) => !regex || regex.test(file.basename) || regex.test(file.name) || regex.test(file.path))
				.map((file) => ({ path: file.path, type: "file" as const }));
			const folders: { path: string; type: "folder" }[] = [];
			const root = app.vault.getRoot();
			const walk = (folder: TFolder, depth: number) => {
				if (depth > MAX_FOLDER_DEPTH) {
					return;
				}
				folder.children.forEach((child) => {
					if (child instanceof TFolder) {
						// Skip hidden/system folders (e.g. .obsidian, .trash).
						if (child.name.startsWith(".")) {
							return;
						}
						const path = child.path;
						if (!regex || regex.test(child.name) || regex.test(path)) {
							folders.push({ path, type: "folder" });
						}
						walk(child, depth + 1);
					}
				});
			};
			walk(root, 0);

			return JSON.stringify([...folders, ...notes]);
		},
		{
			name: "list",
			description: "Lists vault entries (both markdown notes and folders). If filter is provided, only returns entries whose name or path matches the regex filter. Returns a JSON string array of objects with `path` and `type` (\"file\" or \"folder\"). Use it to find notes or folders and discover paths for view, edit, rename, copy, and create_folder tools.",
			schema: z.object({
				intent: intentSchema,
				filter: z.string().optional().default("").describe("Optional regex used to filter entry names or paths."),
			}),
		}
	);
}
