// Pure wizard state for the ask_user popover. No Obsidian or DOM imports so
// the answer-building rules can be unit-tested with the Node test runner.

import type { AskUserQuestion } from "../agent/tools/ask-user-types";

export interface AskUserDraft {
	selected: string[];
	customText: string;
	customSelected: boolean;
	skipped: boolean;
}

export interface AskUserWizardState {
	questions: AskUserQuestion[];
	index: number;
	drafts: AskUserDraft[];
	status: "answering" | "done" | "dismissed";
}

export function createWizardState(questions: AskUserQuestion[]): AskUserWizardState {
	return {
		questions,
		index: 0,
		drafts: questions.map((question) => ({
			selected: [],
			customText: "",
			// A text-only question activates the custom field immediately.
			customSelected: question.options.length === 0,
			skipped: false,
		})),
		status: "answering",
	};
}

function getDraft(state: AskUserWizardState, index: number): AskUserDraft | null {
	return state.drafts[index] ?? null;
}

function getQuestion(state: AskUserWizardState, index: number): AskUserQuestion | null {
	return state.questions[index] ?? null;
}

/**
 * Picks an option. Single-select replaces the choice and deselects the custom
 * row; multi-select toggles the label and keeps any custom text.
 */
export function pickOption(state: AskUserWizardState, index: number, label: string): void {
	const question = getQuestion(state, index);
	const draft = getDraft(state, index);
	if (!question || !draft) {
		return;
	}

	if (question.multiple) {
		draft.selected = draft.selected.includes(label)
			? draft.selected.filter((selected) => selected !== label)
			: [...draft.selected, label];
	} else {
		draft.selected = [label];
		draft.customSelected = false;
	}

	draft.skipped = false;
}

/**
 * Sets the custom answer text. Typing always activates the custom row; in
 * single-select mode it clears the picked option, while multi-select keeps it.
 */
export function setCustomText(state: AskUserWizardState, index: number, text: string): void {
	const question = getQuestion(state, index);
	const draft = getDraft(state, index);
	if (!question || !draft) {
		return;
	}

	draft.customText = text;
	draft.customSelected = true;
	draft.skipped = false;
	if (!question.multiple) {
		draft.selected = [];
	}
}

/**
 * Toggles the custom row without changing its text. Selecting it clears the
 * picked option in single-select mode and leaves multi-select choices intact.
 */
export function setCustomSelected(state: AskUserWizardState, index: number, selected: boolean): void {
	const question = getQuestion(state, index);
	const draft = getDraft(state, index);
	if (!question || !draft) {
		return;
	}

	draft.customSelected = selected;
	if (selected) {
		draft.skipped = false;
		if (!question.multiple) {
			draft.selected = [];
		}
	}
}

/**
 * Marks a question skipped. The typed text is preserved so navigating back can
 * recover it, but the answer stays empty until the user edits it again.
 */
export function skipQuestion(state: AskUserWizardState, index: number): void {
	const draft = getDraft(state, index);
	if (!draft) {
		return;
	}

	draft.skipped = true;
	draft.selected = [];
	draft.customSelected = false;
}

export function goBack(state: AskUserWizardState): void {
	if (state.index > 0) {
		state.index -= 1;
	}
}

export function goNext(state: AskUserWizardState): void {
	if (state.index < state.questions.length - 1) {
		state.index += 1;
	}
}

export function submit(state: AskUserWizardState): void {
	state.status = "done";
}

export function dismiss(state: AskUserWizardState): void {
	state.status = "dismissed";
}

export function isAnswered(question: AskUserQuestion, draft: AskUserDraft): boolean {
	if (draft.skipped) {
		return false;
	}

	return draft.selected.length > 0
		|| (draft.customSelected && draft.customText.trim().length > 0);
}

/**
 * Builds the answer for one question. Skipped questions answer `[]`; single
 * select returns the custom text or the picked option; multi-select combines
 * options and the custom text without duplicates.
 */
export function questionAnswer(question: AskUserQuestion, draft: AskUserDraft): string[] {
	if (draft.skipped) {
		return [];
	}

	const customText = draft.customText.trim();

	if (!question.multiple) {
		if (draft.customSelected) {
			return customText ? [customText] : [];
		}
		return draft.selected.slice(0, 1);
	}

	const answers = [...draft.selected];
	if (draft.customSelected && customText && !answers.includes(customText)) {
		answers.push(customText);
	}
	return answers;
}

/** Maps every question to its answer, preserving alignment with `[]` gaps. */
export function buildAnswers(state: AskUserWizardState): string[][] {
	return state.questions.map((question, index) => {
		const draft = state.drafts[index];
		return draft ? questionAnswer(question, draft) : [];
	});
}
