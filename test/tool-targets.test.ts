import assert from "node:assert/strict";
import { test } from "node:test";
import { getToolCallTargets, MEMORY_TARGET_KEY, VaultTargetLookup } from "../src/agent/tool-targets";

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

void test("every spelling of an existing note maps to one canonical key", () => {
	const expected = ["vault:Notes/A.md"];
	const spellings = ["Notes/A", "Notes/A.md", "[[Notes/A]]", "[[Notes/A|alias]]", "Notes/A#Heading", "notes/a"];

	for (const spelling of spellings) {
		assert.deepEqual(keysFor("view", { linkToMarkdownfile: spelling }), expected, `view(${spelling})`);
		assert.deepEqual(keysFor("edit", { file_path: spelling }), expected, `edit(${spelling})`);
		assert.deepEqual(keysFor("backlinks", { linkToMarkdownfile: spelling }), expected, `backlinks(${spelling})`);
	}
});

void test("a note that does not exist yet still gets a stable key", () => {
	assert.deepEqual(keysFor("view", { linkToMarkdownfile: "New" }), ["vault:New.md"]);
	assert.deepEqual(keysFor("edit", { file_path: "New" }), ["vault:New.md"]);
	assert.deepEqual(keysFor("edit", { file_path: "New.md" }), ["vault:New.md"]);
});

void test("folder-level tools take the exclusive structural lock", () => {
	for (const toolName of ["rename", "copy", "create_folder"]) {
		assert.deepEqual(
			getToolCallTargets(lookup, toolName, { source_path: "Notes/A.md", destination_path: "B.md", folder_path: "X" }),
			{ exclusive: true, keys: [] },
			toolName,
		);
	}
});

void test("save_memory uses the shared memory key, not the structural lock", () => {
	assert.deepEqual(getToolCallTargets(lookup, "save_memory", { memory: [] }), {
		exclusive: false,
		keys: [MEMORY_TARGET_KEY],
	});
});

void test("tools without vault or memory targets stay fully parallel", () => {
	for (const toolName of ["list", "search", "ask_user", "load_skill", "web_search"]) {
		assert.deepEqual(getToolCallTargets(lookup, toolName, {}), { exclusive: false, keys: [] }, toolName);
	}
});

void test("stringified tool arguments are parsed like objects", () => {
	assert.deepEqual(keysFor("edit", '{"file_path":"Notes/A.md"}'), ["vault:Notes/A.md"]);
});

void test("unparseable arguments fail closed", () => {
	assert.deepEqual(getToolCallTargets(lookup, "edit", "{not json"), { exclusive: true, keys: [] });
	assert.deepEqual(getToolCallTargets(lookup, "view", 42), { exclusive: true, keys: [] });
});

void test("missing or empty arguments produce no targets", () => {
	assert.deepEqual(getToolCallTargets(lookup, "view", undefined), { exclusive: false, keys: [] });
	assert.deepEqual(getToolCallTargets(lookup, "edit", {}), { exclusive: false, keys: [] });
	assert.deepEqual(keysFor("edit", { file_path: "   " }), []);
});
