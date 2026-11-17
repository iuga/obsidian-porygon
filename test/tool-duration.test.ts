import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatToolDuration, formatToolElapsed } from "../src/chat/tool-duration";

void describe("formatToolDuration", () => {
	void test("uses rounded milliseconds below one second", () => {
		assert.equal(formatToolDuration(0), "0ms");
		assert.equal(formatToolDuration(200), "200ms");
		assert.equal(formatToolDuration(999), "999ms");
	});

	void test("uses rounded seconds from one second to under a minute", () => {
		assert.equal(formatToolDuration(1000), "1s");
		assert.equal(formatToolDuration(1400), "1s");
		assert.equal(formatToolDuration(1600), "2s");
		assert.equal(formatToolDuration(59_400), "59s");
	});

	void test("switches to minutes and seconds at a minute", () => {
		assert.equal(formatToolDuration(59_600), "1m 0s");
		assert.equal(formatToolDuration(60_000), "1m 0s");
		assert.equal(formatToolDuration(75_000), "1m 15s");
		assert.equal(formatToolDuration(119_600), "2m 0s");
	});

	void test("clamps negative durations", () => {
		assert.equal(formatToolDuration(-500), "0ms");
	});
});

void describe("formatToolElapsed", () => {
	void test("ticks as whole seconds from zero", () => {
		assert.equal(formatToolElapsed(1000, 1000), "0s");
		assert.equal(formatToolElapsed(1000, 1999), "0s");
		assert.equal(formatToolElapsed(1000, 2000), "1s");
		assert.equal(formatToolElapsed(1000, 6500), "5s");
	});
});
