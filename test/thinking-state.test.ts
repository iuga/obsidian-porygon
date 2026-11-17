import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { getThinkingTitle, isThinkingExpanded } from "../src/chat/thinking-state";

void describe("getThinkingTitle", () => {
	void test("uses a live title while reasoning streams", () => {
		assert.equal(getThinkingTitle({ thinking: "hmm", isStreaming: true }), "Thinking...");
	});

	void test("uses a neutral title when the duration is unknown", () => {
		assert.equal(getThinkingTitle({ thinking: "hmm" }), "Thought");
	});

	void test("pluralizes a one-second duration", () => {
		assert.equal(getThinkingTitle({ thinkingDurationSeconds: 1 }), "Thought for 1 second");
	});

	void test("uses seconds for longer durations", () => {
		assert.equal(getThinkingTitle({ thinkingDurationSeconds: 45 }), "Thought for 45 seconds");
	});
});

void describe("isThinkingExpanded", () => {
	void test("treats an explicit collapse flag as authoritative", () => {
		assert.equal(
			isThinkingExpanded({ isStreaming: true, isThinkingCollapsed: true, showThinkingByDefault: true }),
			false,
		);
	});

	void test("treats an explicit expand flag as authoritative", () => {
		assert.equal(
			isThinkingExpanded({ isStreaming: true, isThinkingCollapsed: false, showThinkingByDefault: false }),
			true,
		);
	});

	void test("streams expanded when enabled by default", () => {
		assert.equal(isThinkingExpanded({ isStreaming: true, showThinkingByDefault: true }), true);
	});

	void test("streams collapsed when disabled by default", () => {
		assert.equal(isThinkingExpanded({ isStreaming: true, showThinkingByDefault: false }), false);
	});

	void test("collapses finished turns regardless of the default", () => {
		assert.equal(isThinkingExpanded({ showThinkingByDefault: true }), false);
		assert.equal(isThinkingExpanded({ showThinkingByDefault: false }), false);
	});
});
