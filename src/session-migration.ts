import { App, normalizePath, TFile, TFolder } from "obsidian";
import { LEGACY_SESSION_EXTENSION, PORYGON_SESSIONS_SUBFOLDER, PORYGON_SESSION_EXTENSION } from "./view";

// A single in-flight pass per app session. onLayoutReady can fire more than
// once, and a folder move can re-ask for a pass; coalescing concurrent calls
// keeps the rename/trash work from running in parallel.
let migrating: Promise<void> | null = null;

/**
 * One-time migration from the legacy `.md` session files to the canonical
 * `.session` suffix (issue #45). Each `<id>.md` directly under the sessions
 * folder is brought over so the sessions folder settles on one canonical file
 * per session, which a FileView can then bind to.
 *
 * Safe to call on every launch:
 *  - it is a no-op once no legacy `.md` sessions remain,
 *  - it never overwrites an existing destination, and
 *  - per-file failures are logged instead of aborting the batch, so a vault
 *    with one bad file still migrates every other session.
 *
 * New autosaves already write `<id>.session`, so a legacy file can only ever
 * exist because it predates this change; once migrated it is never recreated,
 * which is what makes this a finite, self-stopping pass.
 */
export function migrateLegacySessionFiles(app: App, porygonFolder: string): Promise<void> {
	if (migrating) {
		return migrating;
	}

	migrating = runMigration(app, porygonFolder).finally(() => {
		migrating = null;
	});
	return migrating;
}

async function runMigration(app: App, porygonFolder: string): Promise<void> {
	const sessionsFolder = normalizePath(`${porygonFolder}/${PORYGON_SESSIONS_SUBFOLDER}`);
	const folder = app.vault.getAbstractFileByPath(sessionsFolder);
	if (!(folder instanceof TFolder)) {
		return;
	}

	const legacySessions = folder.children
		.filter((child): child is TFile => child instanceof TFile && child.extension === LEGACY_SESSION_EXTENSION)
		// Newest first so the most recent conversations migrate before older ones;
		// order does not affect correctness, only the sequence of disk operations.
		.sort((first, second) => second.stat.mtime - first.stat.mtime);

	for (const session of legacySessions) {
		const destination = `${sessionsFolder}/${session.basename}.${PORYGON_SESSION_EXTENSION}`;
		await migrateOneSession(app, session, destination);
	}
}

async function migrateOneSession(app: App, session: TFile, destination: string): Promise<void> {
	// A `.session` twin may already exist: a legacy session was resumed and its
	// next autosave continued it under the canonical name before this pass ran.
	// That twin supersedes the legacy copy, so the migration for this id is
	// already complete — drop the stale `.md` so the folder keeps one canonical
	// file per session rather than a duplicate the /resume list would show twice.
	if (app.vault.getAbstractFileByPath(destination) instanceof TFile) {
		try {
			await app.fileManager.trashFile(session);
		} catch (error) {
			console.error(`Unable to remove migrated Porygon session ${session.path}`, error);
		}
		return;
	}

	// No twin: rename into place. A concurrent writer may create the destination
	// between the check and the call; that surfaces as a rename conflict, which we
	// log rather than throw. A later launch re-runs the check above and trashes it.
	try {
		await app.fileManager.renameFile(session, destination);
	} catch (error) {
		console.error(`Unable to migrate Porygon session ${session.path}`, error);
	}
}
