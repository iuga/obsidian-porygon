import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyToolExecution, type ToolExecutionTimingState } from "../src/agent/tool-events";

function intent(overrides: Partial<ToolExecutionTimingState> & { name: string }): ToolExecutionTimingState {
	return { id: overrides.id ?? `${overrides.name}-id`, ...overrides };
}

void describe("applyToolExecution", () => {
	void test("start marks the matching intent as executing at the event time", () => {
		const target = intent({ id: "call-1", name: "view", durationMs: 500 });
		const result = applyToolExecution([target], { id: "call-1", name: "view", phase: "start", at: 1000 });

		assert.equal(result, target);
		assert.equal(target.isExecuting, true);
		assert.equal(target.executionStartedAt, 1000);
		assert.equal(target.durationMs, undefined);
	});

	void test("finish freezes the duration and clears the executing state", () => {
		const target = intent({ id: "call-1", name: "view", isExecuting: true, executionStartedAt: 1000 });
		applyToolExecution([target], { id: "call-1", name: "view", phase: "finish", at: 3000, durationMs: 2000 });

		assert.equal(target.isExecuting, false);
		assert.equal(target.durationMs, 2000);
		assert.equal(target.executionStartedAt, undefined);
	});

	void test("finish falls back to the event time when no duration is provided", () => {
		const target = intent({ id: "call-1", name: "view", isExecuting: true, executionStartedAt: 1000 });
		applyToolExecution([target], { id: "call-1", name: "view", phase: "finish", at: 1750 });

		assert.equal(target.durationMs, 750);
	});

	void test("interrupted discards the paused attempt so the resume starts from scratch", () => {
		const target = intent({ id: "call-1", name: "edit", isExecuting: true, executionStartedAt: 1000 });
		applyToolExecution([target], { id: "call-1", name: "edit", phase: "interrupted", at: 9000 });

		assert.equal(target.isExecuting, false);
		assert.equal(target.executionStartedAt, undefined);
		assert.equal(target.durationMs, undefined);
	});

	void test("matches by name when the provider omitted tool-call ids", () => {
		const first = intent({ id: "view-0", name: "view" });
		const second = intent({ id: "view-1", name: "view" });

		applyToolExecution([first, second], { id: "", name: "view", phase: "start", at: 1000 });
		assert.equal(first.isExecuting, true);
		assert.equal(second.isExecuting, undefined);

		applyToolExecution([first, second], { id: "", name: "view", phase: "finish", at: 1500, durationMs: 500 });
		assert.equal(first.isExecuting, false);
		assert.equal(first.durationMs, 500);
	});

	void test("ignores unknown tools and empty intent lists", () => {
		assert.equal(applyToolExecution([], { id: "call-1", name: "view", phase: "start", at: 0 }), null);
		assert.equal(applyToolExecution(undefined, { id: "call-1", name: "view", phase: "start", at: 0 }), null);
		assert.equal(
			applyToolExecution([intent({ name: "view" })], { id: "call-9", name: "search", phase: "start", at: 0 }),
			null,
		);
	});

	void test("an unknown non-empty id does not fall back to a same-named intent", () => {
		const current = intent({ id: "call-new", name: "view", isExecuting: true, executionStartedAt: 1000 });
		const result = applyToolExecution([current], { id: "call-old", name: "view", phase: "finish", at: 2000, durationMs: 9000 });

		assert.equal(result, null);
		assert.equal(current.durationMs, undefined);
		assert.equal(current.isExecuting, true);
	});
});
