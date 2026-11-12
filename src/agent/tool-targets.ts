/**
 * Maps a tool call to the lock targets it needs.
 *
 * Kept free of Obsidian imports so the mapping (the part that is easy to get
 * wrong) is unit-testable. The vault lookups it needs are injected as a
 * `VaultTargetLookup`; `tool-concurrency.ts` wires the real implementations.
 *
 * Keying rules:
 *
 *  - `view`, `edit` and `backlinks` all derive the key from the *resolved*
 *    note path. Resolving first matters: the model may pass `Notes/A`,
 *    `[[Notes/A]]`, `Notes/A#heading`, or a path that only resolves through
 *    Obsidian's link resolution (`A` -> `Folder/A.md`). All of those must land
 *    on the same key as `edit("Notes/A.md")`, otherwise the lock silently does
 *    nothing and the calls run concurrently.
 *  - `save_memory` uses one synthetic key because it replaces the whole store.
 *  - `rename`, `copy` and `create_folder` take the exclusive structural lock
 *    instead of keys. Their blast radius includes every child path, which a
 *    fixed key list cannot express.
 *  - Anything else (read-only discovery, `ask_user`, `load_skill`) takes no
 *    target keys, so those calls stay parallel.
 */

import type { ToolLockTargets } from "./tool-locks";

export const MEMORY_TARGET_KEY = "memory:__store__";
const VAULT_TARGET_PREFIX = "vault:";

const NO_TARGETS: ToolLockTargets = { exclusive: false, keys: [] };
const STRUCTURAL_TARGETS: ToolLockTargets = { exclusive: true, keys: [] };

export interface VaultTargetLookup {
	/** Resolved path of an existing note for a path or wikilink, or null. */
	existingNotePath(input: string): string | null;
	/** Normalized `.md` path for a note reference that may not exist yet. */
	prospectiveNotePath(input: string): string;
}

function asNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalizes the raw `toolCall.args` payload. LangChain types this as a record,
 * but providers that emit unparsable tool-call JSON can leave it as a string,
 * and a few leave it undefined. Returning null means "we could not understand
 * the arguments", which the caller treats as unsafe to run concurrently.
 */
export function normalizeToolArgs(raw: unknown): Record<string, unknown> | null {
	if (raw === undefined || raw === null) {
		return {};
	}

	if (isRecord(raw)) {
		return raw;
	}

	if (typeof raw === "string") {
		try {
			const parsed: unknown = JSON.parse(raw);
			return isRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}

	return null;
}

function pathTargetKey(path: string): string {
	// NFC keeps decomposed macOS filenames from producing two keys for one note.
	return `${VAULT_TARGET_PREFIX}${path.normalize("NFC")}`;
}

function noteTargetKeys(lookup: VaultTargetLookup, input: string): string[] {
	const existing = lookup.existingNotePath(input);
	return [pathTargetKey(existing ?? lookup.prospectiveNotePath(input))];
}

export function getToolCallTargets(
	lookup: VaultTargetLookup,
	toolName: string,
	rawArgs: unknown,
): ToolLockTargets {
	const args = normalizeToolArgs(rawArgs);
	if (!args) {
		// Unknown arguments: we cannot prove this call is independent of the
		// vault, so serialize it against every other vault operation. The tool
		// will fail validation anyway; this just keeps that failure from racing
		// a concurrent mutation.
		return STRUCTURAL_TARGETS;
	}

	switch (toolName) {
		case "view":
		case "backlinks": {
			const input = asNonEmptyString(args.linkToMarkdownfile);
			return input ? { exclusive: false, keys: noteTargetKeys(lookup, input) } : NO_TARGETS;
		}
		case "edit": {
			const input = asNonEmptyString(args.file_path);
			return input ? { exclusive: false, keys: noteTargetKeys(lookup, input) } : NO_TARGETS;
		}
		case "rename":
		case "copy":
		case "create_folder":
			return STRUCTURAL_TARGETS;
		case "save_memory":
			return { exclusive: false, keys: [MEMORY_TARGET_KEY] };
		default:
			return NO_TARGETS;
	}
}
