import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getToolCallTargets, MEMORY_TARGET_KEY, type VaultTargetLookup } from "../src/agent/tool-targets";

// Minimal stand-in for Obsidian's vault: paths are canonical case-insensitively
// and link syntax is stripped, like resolveMarkdownFile does.
const EXISTING = ["Notes/A.md", "Notes/B.md", "Folder/Deep.md"];
const CANONICAL = new Map(EXISTING.map((path) => [path.toLowerCase(), path]));

function stripLinkSyntax(input: string): string {
	let value = input.trim();
	value = value.replace(/^\[\[/, "").replace(/\]\]$/, "");
	value = value.split("#")[0] ?? value;
	value = value.split("|")[0] ?? value;
	return value.replace(/\\/g, "/");
}

function withMarkdownExtension(path: string): string {
	return path.endsWith(".md") ? path : `${path}.md`;
}

const lookup: VaultTargetLookup = {
	existingNotePath: (input) => {
		const normalized = stripLinkSyntax(input);
		const candidates = normalized.endsWith(".md") ? [normalized] : [normalized, `${normalized}.md`];
		for (const candidate of candidates) {
			const canonical = CANONICAL.get(candidate.toLowerCase());
			if (canonical) {
				return canonical;
			}
		}
		return null;
	},
	prospectiveNotePath: (input) => withMarkdownExtension(stripLinkSyntax(input)),
};

function keysFor(toolName: string, args: unknown): readonly string[] {
	return getToolCallTargets(lookup, toolName, args).keys;
}

void describe("getToolCallTargets", () => {
	/**
	 * Verifies that every accepted spelling of an existing note maps to one
	 * canonical lock key.
	 *
	 * The expectation is that `view`, `edit` and `backlinks` all produce
	 * `vault:Notes/A.md` for paths, `.md` paths, wikilinks, subpaths and
	 * different casing.
	 *
	 * This is important because a spelling mismatch would silently drop the
	 * lock and let two edits race on the same note.
	 */
	void test("maps every spelling of an existing note to one canonical key", () => {
		const expected = ["vault:Notes/A.md"];
		const spellings = ["Notes/A", "Notes/A.md", "[[Notes/A]]", "[[Notes/A|alias]]", "Notes/A#Heading", "notes/a"];

		for (const spelling of spellings) {
			assert.deepEqual(keysFor("view", { linkToMarkdownfile: spelling }), expected, `view(${spelling})`);
			assert.deepEqual(keysFor("edit", { file_path: spelling }), expected, `edit(${spelling})`);
			assert.deepEqual(keysFor("backlinks", { linkToMarkdownfile: spelling }), expected, `backlinks(${spelling})`);
		}
	});

	/**
	 * Verifies that a note which does not exist yet still gets a stable key.
	 *
	 * The expectation is that `view` and `edit` on `New` and `New.md` all
	 * target `vault:New.md`.
	 *
	 * This is important because creating and editing a new note in the same
	 * batch must not run concurrently.
	 */
	void test("gives a not-yet-created note a stable key", () => {
		assert.deepEqual(keysFor("view", { linkToMarkdownfile: "New" }), ["vault:New.md"]);
		assert.deepEqual(keysFor("edit", { file_path: "New" }), ["vault:New.md"]);
		assert.deepEqual(keysFor("edit", { file_path: "New.md" }), ["vault:New.md"]);
	});

	/**
	 * Verifies that folder-level tools take the exclusive structural lock.
	 *
	 * The expectation is that `rename`, `copy` and `create_folder` are marked
	 * exclusive and carry no per-path keys.
	 *
	 * This is important because their blast radius includes every child path,
	 * which a fixed key list cannot express.
	 */
	void test("folder-level tools take the exclusive structural lock", () => {
		for (const toolName of ["rename", "copy", "create_folder"]) {
			assert.deepEqual(
				getToolCallTargets(lookup, toolName, {
					source_path: "Notes/A.md",
					destination_path: "B.md",
					folder_path: "X",
				}),
				{ exclusive: true, keys: [] },
				toolName,
			);
		}
	});

	/**
	 * Verifies that `save_memory` uses the shared memory key instead of the
	 * structural lock.
	 *
	 * The expectation is that the operation is non-exclusive and targets
	 * `MEMORY_TARGET_KEY`.
	 *
	 * This is important because memory writes must serialize with each other
	 * without blocking unrelated vault operations.
	 */
	void test("save_memory uses the shared memory key", () => {
		assert.deepEqual(getToolCallTargets(lookup, "save_memory", { memory: [] }), {
			exclusive: false,
			keys: [MEMORY_TARGET_KEY],
		});
	});

	/**
	 * Verifies that tools without vault or memory targets stay fully parallel.
	 *
	 * The expectation is that discovery and interaction tools report no
	 * targets and are not marked exclusive.
	 *
	 * This is important because over-locking would serialize calls that are
	 * safe to run together.
	 */
	void test("leaves untargeted tools fully parallel", () => {
		for (const toolName of ["list", "search", "ask_user", "load_skill", "web_search"]) {
			assert.deepEqual(getToolCallTargets(lookup, toolName, {}), { exclusive: false, keys: [] }, toolName);
		}
	});

	/**
	 * Verifies that tool arguments delivered as a JSON string are parsed like
	 * an object.
	 *
	 * The expectation is that the string payload still yields the note key.
	 *
	 * This is important because some providers stringify tool arguments, and
	 * missing the path would silently drop the lock.
	 */
	void test("parses stringified tool arguments", () => {
		assert.deepEqual(keysFor("edit", '{"file_path":"Notes/A.md"}'), ["vault:Notes/A.md"]);
	});

	/**
	 * Verifies that arguments the resolver cannot understand fail closed.
	 *
	 * The expectation is that the call takes the exclusive structural lock
	 * instead of running without a lock.
	 *
	 * This is important because an unknown payload could hide a vault
	 * mutation, and serializing is cheap compared to a lost update.
	 */
	void test("fails closed on unparseable arguments", () => {
		assert.deepEqual(getToolCallTargets(lookup, "edit", "{not json"), { exclusive: true, keys: [] });
		assert.deepEqual(getToolCallTargets(lookup, "view", 42), { exclusive: true, keys: [] });
	});
});
