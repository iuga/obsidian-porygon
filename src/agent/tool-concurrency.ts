import { createMiddleware } from "langchain";
import { App } from "obsidian";
import {
	normalizeMarkdownPath,
	normalizeVaultPath,
	resolveMarkdownFile,
	stripWikiLinkSyntax,
} from "./tools/shared";

// Locks are shared for the plugin lifetime. Agent instances are rebuilt when
// provider settings change, but a run may still be holding a lock; keeping the
// map module-level avoids handing a rebuilt agent a different lock set.
const targetTails = new Map<string, Promise<void>>();

const MEMORY_TARGET_KEY = "memory:__store__";
const VAULT_TARGET_PREFIX = "vault:";

function asNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function pathTargetKey(path: string): string {
	// NFC keeps decomposed macOS filenames from producing two keys for one note.
	return `${VAULT_TARGET_PREFIX}${path.normalize("NFC")}`;
}

function noteTargetKey(app: App, input: string): string {
	const file = resolveMarkdownFile(app, input);
	if (file) {
		return pathTargetKey(file.path);
	}

	const withoutWikiLink = stripWikiLinkSyntax(input).replace(/\\/g, "/");
	const withoutSubpath = withoutWikiLink.split("#")[0] ?? withoutWikiLink;
	const withoutAlias = withoutSubpath.split("|")[0] ?? withoutSubpath;
	return pathTargetKey(normalizeMarkdownPath(withoutAlias.trim()));
}

function getToolCallTargets(app: App, toolName: string, args: Record<string, unknown>): string[] {
	switch (toolName) {
		case "view":
		case "backlinks": {
			const input = asNonEmptyString(args.linkToMarkdownfile);
			return input ? [noteTargetKey(app, input)] : [];
		}
		case "edit": {
			const input = asNonEmptyString(args.file_path);
			return input ? [noteTargetKey(app, input)] : [];
		}
		case "rename":
		case "copy": {
			return [asNonEmptyString(args.source_path), asNonEmptyString(args.destination_path)]
				.filter((path): path is string => path !== null)
				.map((path) => pathTargetKey(normalizeVaultPath(path)));
		}
		case "create_folder": {
			const folder = asNonEmptyString(args.folder_path);
			return folder ? [pathTargetKey(normalizeVaultPath(folder))] : [];
		}
		case "save_memory":
			return [MEMORY_TARGET_KEY];
		default:
			return [];
	}
}

async function acquireTarget(key: string): Promise<() => void> {
	const previous = targetTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => gate);
	targetTails.set(key, tail);

	await previous;

	return () => {
		if (targetTails.get(key) === tail) {
			targetTails.delete(key);
		}
		release();
	};
}

export async function withTargetLocks<T>(keys: string[], action: () => Promise<T> | T): Promise<T> {
	const releases: Array<() => void> = [];
	try {
		// Sorted acquisition prevents a rename/copy with two targets from
		// deadlocking against another call with the same pair in reverse order.
		for (const key of [...new Set(keys)].sort()) {
			releases.push(await acquireTarget(key));
		}
		return await action();
	} finally {
		for (const release of releases.reverse()) {
			release();
		}
	}
}

export function createToolConcurrencyMiddleware(app: App) {
	return createMiddleware({
		name: "PorygonToolTargetSerialization",
		wrapToolCall: async (request, handler) => {
			const targets = getToolCallTargets(app, request.toolCall.name, request.toolCall.args ?? {});
			if (targets.length === 0) {
				return handler(request);
			}

			return withTargetLocks(targets, () => handler(request));
		},
	});
}
