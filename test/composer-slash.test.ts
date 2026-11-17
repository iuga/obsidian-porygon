import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripSlashTrigger } from "../src/chat/composer-slash";

void describe("stripSlashTrigger", () => {
	/**
	 * Verifies that a lone trigger character at the caret is removed and the
	 * composer is reported as empty.
	 */
	void test("removes a lone slash", () => {
		assert.deepEqual(stripSlashTrigger("/", 0), { value: "", caret: 0 });
	});

	/**
	 * Verifies that only the trigger character is removed: a draft typed before
	 * the slash is preserved and the caret stays where the slash was.
	 */
	void test("preserves the surrounding draft", () => {
		assert.deepEqual(stripSlashTrigger("my draft /", 9), { value: "my draft ", caret: 9 });
	});

	/**
	 * Verifies that a trigger in the middle of the value is removed without
	 * touching the text after it.
	 */
	void test("removes a slash between text", () => {
		assert.deepEqual(stripSlashTrigger("hello /world", 6), { value: "hello world", caret: 6 });
	});

	/**
	 * Verifies that no removal happens when the popover was opened from the
	 * toolbar, since no index is recorded for that path.
	 */
	void test("ignores a null index", () => {
		assert.equal(stripSlashTrigger("keep / me", null), null);
	});

	/**
	 * Verifies that out-of-range indexes are ignored instead of producing
	 * malformed text.
	 */
	void test("ignores out-of-range indexes", () => {
		assert.equal(stripSlashTrigger("short", -1), null);
		assert.equal(stripSlashTrigger("short", 5), null);
	});

	/**
	 * Verifies that a stale index pointing at another character leaves the
	 * composer untouched.
	 */
	void test("ignores an index that is not a slash", () => {
		assert.equal(stripSlashTrigger("no trigger here", 3), null);
	});
});
