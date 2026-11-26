import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AskUserQuestion } from "../src/agent/tools/ask-user-types";
import {
	buildAnswers,
	createWizardState,
	goBack,
	goNext,
	isAnswered,
	pickOption,
	questionAnswer,
	setCustomSelected,
	setCustomText,
	skipQuestion,
} from "../src/ui/ask-user-state";

function singleQuestion(): AskUserQuestion {
	return {
		header: "Tone",
		question: "Which tone?",
		options: [{ label: "Formal" }, { label: "Casual" }],
	};
}

function multiQuestion(): AskUserQuestion {
	return {
		header: "Topics",
		question: "Which topics?",
		options: [{ label: "A" }, { label: "B" }],
		multiple: true,
	};
}

void describe("ask-user wizard state", () => {
	/**
	 * Verifies that picking an option in a single-select question clears the
	 * custom row while preserving the typed text for later switching back.
	 */
	void test("single-select option pick clears custom selection", () => {
		const state = createWizardState([singleQuestion()]);
		setCustomText(state, 0, "My own answer");

		pickOption(state, 0, "Formal");

		const draft = state.drafts[0];
		assert.ok(draft);
		assert.deepEqual(draft.selected, ["Formal"]);
		assert.equal(draft.customSelected, false);
		assert.equal(draft.customText, "My own answer");
		assert.deepEqual(questionAnswer(singleQuestion(), draft), ["Formal"]);
	});

	/**
	 * Verifies that typing custom text in a single-select question replaces the
	 * picked option instead of combining with it.
	 */
	void test("typing custom text clears the single selection", () => {
		const state = createWizardState([singleQuestion()]);
		pickOption(state, 0, "Casual");

		setCustomText(state, 0, "A different answer");

		const draft = state.drafts[0];
		assert.ok(draft);
		assert.deepEqual(draft.selected, []);
		assert.equal(draft.customSelected, true);
		assert.deepEqual(questionAnswer(singleQuestion(), draft), ["A different answer"]);
	});

	/**
	 * Verifies that multi-select toggles options and keeps the custom text
	 * active while the user picks and unpicks rows.
	 */
	void test("multi-select toggles options and keeps custom text", () => {
		const state = createWizardState([multiQuestion()]);
		setCustomText(state, 0, "Extra");

		pickOption(state, 0, "A");
		pickOption(state, 0, "B");

		const draft = state.drafts[0];
		assert.ok(draft);
		assert.deepEqual(draft.selected, ["A", "B"]);
		assert.equal(draft.customSelected, true);
		assert.equal(draft.customText, "Extra");

		pickOption(state, 0, "A");
		assert.deepEqual(draft.selected, ["B"]);
		assert.equal(draft.customSelected, true);
	});

	/**
	 * Verifies that multi-select answers combine options and custom text while
	 * deduplicating custom text that equals an already selected option.
	 */
	void test("multi-select appends custom text without duplicates", () => {
		const state = createWizardState([multiQuestion()]);
		pickOption(state, 0, "A");
		setCustomText(state, 0, "A");

		const draft = state.drafts[0];
		assert.ok(draft);
		assert.deepEqual(questionAnswer(multiQuestion(), draft), ["A"]);

		setCustomText(state, 0, "Other");
		assert.deepEqual(questionAnswer(multiQuestion(), draft), ["A", "Other"]);
	});

	/**
	 * Verifies that skipping answers `[]`, preserves the typed text, and is
	 * overridden as soon as the user edits the question again.
	 */
	void test("skip produces an empty answer until the user edits again", () => {
		const state = createWizardState([singleQuestion()]);
		setCustomText(state, 0, "Draft text");

		skipQuestion(state, 0);

		const draft = state.drafts[0];
		assert.ok(draft);
		assert.equal(draft.skipped, true);
		assert.deepEqual(draft.selected, []);
		assert.equal(draft.customSelected, false);
		assert.equal(draft.customText, "Draft text");
		assert.deepEqual(questionAnswer(singleQuestion(), draft), []);

		pickOption(state, 0, "Formal");
		assert.equal(draft.skipped, false);
		assert.deepEqual(questionAnswer(singleQuestion(), draft), ["Formal"]);
	});

	/**
	 * Verifies that navigating between questions preserves every draft and
	 * that the index stays within bounds at both ends.
	 */
	void test("back and next preserve drafts", () => {
		const state = createWizardState([singleQuestion(), multiQuestion()]);
		setCustomText(state, 0, "First answer");

		goNext(state);
		assert.equal(state.index, 1);
		pickOption(state, 1, "A");

		goBack(state);
		assert.equal(state.index, 0);
		assert.equal(state.drafts[0]?.customText, "First answer");

		goBack(state);
		assert.equal(state.index, 0);

		goNext(state);
		goNext(state);
		assert.equal(state.index, 1);
	});

	/**
	 * Verifies that answers stay aligned with questions and that skipped
	 * questions become empty arrays in the final payload.
	 */
	void test("buildAnswers aligns answers and fills skipped gaps", () => {
		const freeText: AskUserQuestion = { header: "Free", question: "Anything else?", options: [] };
		const state = createWizardState([singleQuestion(), multiQuestion(), freeText]);

		pickOption(state, 0, "Casual");
		skipQuestion(state, 1);
		setCustomText(state, 2, "  Typed answer  ");

		assert.deepEqual(buildAnswers(state), [["Casual"], [], ["Typed answer"]]);
	});

	/**
	 * Verifies that a text-only question starts with the custom row active but
	 * is not considered answered until the user types something.
	 */
	void test("text-only questions start active and require text", () => {
		const question: AskUserQuestion = { header: "Free", question: "Anything else?", options: [] };
		const state = createWizardState([question]);
		const draft = state.drafts[0];

		assert.ok(draft);
		assert.equal(draft.customSelected, true);
		assert.equal(isAnswered(question, draft), false);

		setCustomText(state, 0, "   ");
		assert.equal(isAnswered(question, draft), false);

		setCustomText(state, 0, "Some text");
		assert.equal(isAnswered(question, draft), true);
	});

	/**
	 * Verifies that toggling the custom row off leaves a single-select question
	 * unanswered and that selecting it again clears any picked option.
	 */
	void test("custom row selection clears single-select options", () => {
		const state = createWizardState([singleQuestion()]);
		pickOption(state, 0, "Formal");

		setCustomSelected(state, 0, true);

		const draft = state.drafts[0];
		assert.ok(draft);
		assert.deepEqual(draft.selected, []);
		assert.equal(draft.customSelected, true);
	});
});
