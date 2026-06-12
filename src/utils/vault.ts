import { App, normalizePath, TFolder } from "obsidian";

/**
 * Ensures a folder exists at the given vault path, creating any missing
 * ancestor folders along the way. Idempotent and race-tolerant: concurrent
 * callers that lose the create race are treated as no-ops. Throws if a
 * non-folder file already occupies any segment of the path.
 */
export async function ensureFolderExists(app: App, folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath);
	if (!normalized || normalized === "/") {
		return;
	}

	const segments = normalized.split("/");
	let current = "";
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;
		const existing = app.vault.getAbstractFileByPath(current);
		if (existing instanceof TFolder) {
			continue;
		}

		if (existing) {
			throw new Error(`Cannot create folder because a file already exists at ${current}`);
		}

		try {
			await app.vault.createFolder(current);
		} catch (error) {
			// Race or pre-existing folder: treat as a no-op.
			if (app.vault.getAbstractFileByPath(current) instanceof TFolder) {
				continue;
			}

			throw error;
		}
	}
}
