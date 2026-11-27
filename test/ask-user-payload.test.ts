import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	formatAskUserModelContent,
	normalizeAskUserPayload,
	type AskUserQuestion,
} from "../src/agent/tools/ask-user-types";

void describe("ask-user payload normalization", () => {
	/**
	 * Verifies that the current questions payload keeps option objects,
	 * descriptions, empty option lists, and the multiple flag.
	 */
	void test("normalizes questions with option objects and empty options", () => {
		const payload = normalizeAskUserPayload({
			kind: "questions",
			questions: [
				{
					header: "Tone",
					question: "Which tone?",
					options: [{ label: "Formal", description: "Professional" }, { label: "Casual" }],
					multiple: true,
				},
				{ header: "Extra", question: "Anything else?", options: [] },
			],
		});

		assert.deepEqual(payload, {
			kind: "questions",
			questions: [
				{
					header: "Tone",
					question: "Which tone?",
					options: [{ label: "Formal", description: "Professional" }, { label: "Casual" }],
					multiple: true,
				},
				{
					header: "Extra",
					question: "Anything else?",
					options: [],
					multiple: false,
				},
			],
		});
	});

	/**
	 * Verifies that the explicit approval payload survives normalization.
	 */
	void test("normalizes approval payloads", () => {
		assert.deepEqual(
			normalizeAskUserPayload({ kind: "approval", question: "Delete it?", options: ["Approve", "Deny"] }),
			{ kind: "approval", question: "Delete it?", options: ["Approve", "Deny"] },
		);
	});

	/**
	 * Verifies that the legacy `{ question, options }` approval shape maps to
	 * the approval payload.
	 */
	void test("normalizes legacy approval payloads", () => {
		assert.deepEqual(
			normalizeAskUserPayload({ question: "Delete it?", options: ["Approve", "Deny"] }),
			{ kind: "approval", question: "Delete it?", options: ["Approve", "Deny"] },
		);
	});

	/**
	 * Verifies that legacy question payloads become a single question with
	 * option objects and that an empty option list stays valid.
	 */
	void test("normalizes legacy question payloads", () => {
		assert.deepEqual(
			normalizeAskUserPayload({ question: "Which tone?", options: ["Formal", "Casual"] }),
			{
				kind: "questions",
				questions: [{
					header: "Question",
					question: "Which tone?",
					options: [{ label: "Formal" }, { label: "Casual" }],
					multiple: false,
				}],
			},
		);

		assert.deepEqual(
			normalizeAskUserPayload({ question: "Free text?", options: [] }),
			{
				kind: "questions",
				questions: [{
					header: "Question",
					question: "Free text?",
					options: [],
					multiple: false,
				}],
			},
		);
	});

	/**
	 * Verifies that malformed values are rejected instead of producing an
	 * unusable prompt.
	 */
	void test("rejects malformed payloads", () => {
		assert.equal(normalizeAskUserPayload(null), null);
		assert.equal(normalizeAskUserPayload("hello"), null);
		assert.equal(normalizeAskUserPayload({}), null);
		assert.equal(normalizeAskUserPayload({ kind: "unknown" }), null);
		assert.equal(normalizeAskUserPayload({ kind: "questions", questions: [] }), null);
		assert.equal(normalizeAskUserPayload({ kind: "questions", questions: [{ question: "" }] }), null);
		assert.equal(normalizeAskUserPayload({ question: 123, options: [] }), null);
		assert.equal(normalizeAskUserPayload({ question: "No options key" }), null);
	});
});

void describe("ask-user model content", () => {
	const questions: AskUserQuestion[] = [
		{ header: "Tone", question: "Which tone?", options: [{ label: "Formal" }] },
		{ header: "Extra", question: "Anything else?", options: [] },
	];

	/**
	 * Verifies that answered, multi-answer, and skipped questions format into
	 * the exact model-facing sentence.
	 */
	void test("formats mixed answered and skipped questions", () => {
		const content = formatAskUserModelContent(questions, {
			answers: [["Formal", "Casual"], []],
		});

		assert.equal(
			content,
			'User has answered your questions: "Which tone?"="Formal, Casual", "Anything else?"="Unanswered". You can now continue with the user\'s answers in mind.',
		);
	});

	/**
	 * Verifies that a dismissed prompt returns the dedicated message.
	 */
	void test("formats dismissal", () => {
		assert.equal(
			formatAskUserModelContent(questions, { answers: [[], []], dismissed: true }),
			"User dismissed the questions without answering.",
		);
	});

	/**
	 * Verifies that string replies (approval and legacy) pass through
	 * unchanged.
	 */
	void test("passes string replies through", () => {
		assert.equal(formatAskUserModelContent(questions, "Approve"), "Approve");
	});

	/**
	 * Verifies that quotes and newlines are escaped safely by JSON.stringify.
	 */
	void test("escapes quotes and newlines", () => {
		const trickyQuestions: AskUserQuestion[] = [
			{ header: "Quote", question: 'Say "hi"', options: [] },
		];

		const content = formatAskUserModelContent(trickyQuestions, { answers: [["line 1\nline 2"]] });

		assert.equal(
			content,
			'User has answered your questions: "Say \\"hi\\""="line 1\\nline 2". You can now continue with the user\'s answers in mind.',
		);
	});
});
