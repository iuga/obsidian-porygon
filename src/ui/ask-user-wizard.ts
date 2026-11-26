// Ask-user popover UI: a one-question-at-a-time wizard for question payloads
// and a compact approval prompt for the existing approval flow.
//
// The custom textarea is deliberately dumb: typing only updates state, Enter
// advances or submits, Shift+Enter inserts a newline, and blur never submits.
// Digit keys are never treated as option shortcuts (that bug lost focus and
// submitted early in the previous implementation).

import {
	APPROVE_LABEL,
	type AskUserApprovalPayload,
	type AskUserInterruptPayload,
	type AskUserQuestionsPayload,
	type AskUserResumeValue,
} from "../agent/tools/ask-user-types";
import {
	buildAnswers,
	createWizardState,
	dismiss,
	goBack,
	goNext,
	isAnswered,
	pickOption,
	setCustomSelected,
	setCustomText,
	skipQuestion,
	submit,
} from "./ask-user-state";
import type { PopoverConfig } from "./popover";

export interface AskUserWizardCallbacks {
	resolve: (reply: AskUserResumeValue) => void;
	onClose?: () => void;
}

const MAX_CUSTOM_INPUT_HEIGHT = 120;

function autoGrow(textarea: HTMLTextAreaElement): void {
	// The class forces `height: auto !important` so the next measurement sees
	// the full content height even after a previous inline height was set.
	textarea.addClass("is-measuring");
	const nextHeight = Math.min(textarea.scrollHeight, MAX_CUSTOM_INPUT_HEIGHT);
	textarea.removeClass("is-measuring");
	textarea.setCssProps({
		"--porygon-ask-custom-height": `${nextHeight}px`,
		"--porygon-ask-custom-overflow": textarea.scrollHeight > MAX_CUSTOM_INPUT_HEIGHT ? "auto" : "hidden",
	});
}

interface CustomRowHandlers {
	toggle: () => void;
	input: (value: string) => void;
	enter: () => void;
}

interface CustomRowElements {
	row: HTMLElement;
	indicator: HTMLButtonElement;
	textarea: HTMLTextAreaElement;
}

function createCustomRow(
	parentEl: HTMLElement,
	multiple: boolean,
	value: string,
	selected: boolean,
	handlers: CustomRowHandlers,
): CustomRowElements {
	const row = parentEl.createDiv({ cls: "porygon-ask-custom-row" });
	const indicator = row.createEl("button", {
		cls: "porygon-ask-custom-indicator",
		attr: {
			type: "button",
			role: multiple ? "checkbox" : "radio",
			"aria-checked": String(selected),
			title: "Type your own answer",
			"aria-label": "Type your own answer",
		},
	});
	indicator.toggleClass("is-selected", selected);

	const textarea = row.createEl("textarea", {
		cls: "porygon-ask-custom-input",
		attr: {
			rows: "1",
			placeholder: "Type your own answer",
			"aria-label": "Type your own answer",
		},
	});
	textarea.value = value;
	autoGrow(textarea);

	indicator.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		handlers.toggle();
	});

	textarea.addEventListener("input", () => {
		autoGrow(textarea);
		handlers.input(textarea.value);
	});

	textarea.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" || event.shiftKey) {
			return;
		}
		// Ignore Enter while an IME composition is still open.
		if (event.isComposing || event.keyCode === 229) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		handlers.enter();
	});

	return { row, indicator, textarea };
}

function createFooterButton(parentEl: HTMLElement, text: string, cls: string): HTMLButtonElement {
	return parentEl.createEl("button", {
		cls: `porygon-ask-footer-button ${cls}`,
		text,
		attr: { type: "button" },
	});
}

function createQuestionsWizard(
	panelEl: HTMLElement,
	payload: AskUserQuestionsPayload,
	callbacks: AskUserWizardCallbacks,
): PopoverConfig {
	const state = createWizardState(payload.questions);
	const total = state.questions.length;

	const headerEl = panelEl.createDiv({ cls: "porygon-ask-header" });
	const titleEl = headerEl.createDiv({ cls: "porygon-ask-title" });
	const progressEl = headerEl.createDiv({ cls: "porygon-ask-progress" });
	const bodyEl = panelEl.createDiv({ cls: "porygon-ask-body" });
	const footerEl = panelEl.createDiv({ cls: "porygon-ask-footer" });

	const dismissButton = createFooterButton(footerEl, "Dismiss", "porygon-ask-dismiss");
	const footerActions = footerEl.createDiv({ cls: "porygon-ask-footer-actions" });
	const backButton = createFooterButton(footerActions, "Back", "porygon-ask-back");
	const skipButton = createFooterButton(footerActions, "Skip", "porygon-ask-skip");
	const nextButton = createFooterButton(footerActions, "Next", "mod-cta porygon-ask-next");

	const segments: HTMLButtonElement[] = [];
	if (total > 1) {
		state.questions.forEach((question, index) => {
			const segment = progressEl.createEl("button", {
				cls: "porygon-ask-progress-segment",
				attr: {
					type: "button",
					title: question.header,
					"aria-label": `Question ${index + 1}: ${question.header}`,
				},
			});
			segment.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				state.index = index;
				renderStep();
			});
			segments.push(segment);
		});
	} else {
		progressEl.remove();
	}

	let optionButtons: HTMLButtonElement[] = [];
	let optionLabels: string[] = [];
	let customIndicator: HTMLButtonElement | null = null;
	let customTextarea: HTMLTextAreaElement | null = null;

	const currentQuestion = () => state.questions[state.index];
	const currentDraft = () => state.drafts[state.index];

	function settle(reply: AskUserResumeValue): void {
		callbacks.resolve(reply);
	}

	function dismissalReply(): AskUserResumeValue {
		return { answers: state.questions.map(() => []), dismissed: true };
	}

	function updateProgress(): void {
		segments.forEach((segment, index) => {
			const question = state.questions[index];
			const draft = state.drafts[index];
			const answered = !!question && !!draft && isAnswered(question, draft);
			segment.toggleClass("is-active", index === state.index);
			segment.toggleClass("is-answered", answered);
			segment.toggleClass("is-skipped", !!draft?.skipped);
		});
	}

	function syncSelection(): void {
		const draft = currentDraft();
		if (!draft) {
			return;
		}

		optionButtons.forEach((button, index) => {
			const label = optionLabels[index] ?? "";
			const selected = draft.selected.includes(label);
			button.toggleClass("is-selected", selected);
			button.setAttribute("aria-checked", String(selected));
		});

		if (customIndicator) {
			customIndicator.toggleClass("is-selected", draft.customSelected);
			customIndicator.setAttribute("aria-checked", String(draft.customSelected));
		}

		updateProgress();
	}

	function updateFooter(): void {
		const question = currentQuestion();
		const draft = currentDraft();
		if (!question || !draft) {
			return;
		}

		backButton.hidden = state.index === 0;
		nextButton.setText(state.index === total - 1 ? "Submit" : "Next");
		nextButton.disabled = !isAnswered(question, draft);
	}

	function focusCurrentStep(): void {
		if (state.status !== "answering") {
			return;
		}

		const question = currentQuestion();
		const draft = currentDraft();
		if (!question || !draft) {
			return;
		}

		if (question.options.length === 0) {
			customTextarea?.focus();
			return;
		}

		const selectedIndex = optionLabels.findIndex((label) => draft.selected.includes(label));
		optionButtons[selectedIndex >= 0 ? selectedIndex : 0]?.focus();
	}

	function scheduleFocus(): void {
		window.requestAnimationFrame(focusCurrentStep);
	}

	function submitAll(): void {
		submit(state);
		settle({ answers: buildAnswers(state) });
	}

	function advance(): void {
		const question = currentQuestion();
		const draft = currentDraft();
		if (!question || !draft || !isAnswered(question, draft)) {
			return;
		}

		if (state.index === total - 1) {
			submitAll();
			return;
		}

		goNext(state);
		renderStep();
	}

	function handleSkip(): void {
		const isLast = state.index === total - 1;
		skipQuestion(state, state.index);
		if (isLast) {
			submitAll();
			return;
		}

		goNext(state);
		renderStep();
	}

	function renderStep(): void {
		const question = currentQuestion();
		const draft = currentDraft();
		if (!question || !draft) {
			return;
		}

		titleEl.setText(total > 1 ? `Question ${state.index + 1} of ${total}` : question.header);

		bodyEl.empty();
		optionButtons = [];
		optionLabels = [];
		customIndicator = null;
		customTextarea = null;

		bodyEl.createDiv({ cls: "porygon-ask-question", text: question.question });
		const hintText = question.options.length === 0
			? "Type your answer"
			: question.multiple ? "Select one or more" : "Select one";
		bodyEl.createDiv({ cls: "porygon-ask-hint", text: hintText });

		const optionsEl = bodyEl.createDiv({
			cls: "porygon-ask-options",
			attr: { role: question.multiple ? "group" : "radiogroup" },
		});

		question.options.forEach((option) => {
			const selected = draft.selected.includes(option.label);
			const button = optionsEl.createEl("button", {
				cls: "porygon-ask-option",
				attr: {
					type: "button",
					role: question.multiple ? "checkbox" : "radio",
					"aria-checked": String(selected),
				},
			});
			button.toggleClass("is-selected", selected);
			button.createSpan({ cls: "porygon-ask-option-indicator" });
			const textEl = button.createSpan({ cls: "porygon-ask-option-text" });
			textEl.createSpan({ cls: "porygon-ask-option-label", text: option.label });
			if (option.description) {
				textEl.createSpan({ cls: "porygon-ask-option-description", text: option.description });
			}

			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				pickOption(state, state.index, option.label);
				syncSelection();
				updateFooter();
			});

			optionButtons.push(button);
			optionLabels.push(option.label);
		});

		const customRow = createCustomRow(bodyEl, question.multiple === true, draft.customText, draft.customSelected, {
			toggle: () => {
				const activeDraft = currentDraft();
				if (!activeDraft) {
					return;
				}
				setCustomSelected(state, state.index, !activeDraft.customSelected);
				syncSelection();
				updateFooter();
				if (activeDraft.customSelected) {
					customRow.textarea.focus();
				}
			},
			input: (value) => {
				setCustomText(state, state.index, value);
				syncSelection();
				updateFooter();
			},
			enter: () => advance(),
		});

		customIndicator = customRow.indicator;
		customTextarea = customRow.textarea;

		updateProgress();
		updateFooter();
		scheduleFocus();
	}

	dismissButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		dismiss(state);
		settle(dismissalReply());
	});

	backButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		goBack(state);
		renderStep();
	});

	skipButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		handleSkip();
	});

	nextButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		advance();
	});

	renderStep();

	return {
		closeOnOutsideClick: false,
		onKeydown: (event) => {
			if (event.key !== "Escape") {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			dismiss(state);
			settle(dismissalReply());
		},
		onClose: () => callbacks.onClose?.(),
	};
}

function createApprovalPrompt(
	panelEl: HTMLElement,
	payload: AskUserApprovalPayload,
	callbacks: AskUserWizardCallbacks,
): PopoverConfig {
	let selected: string | null = payload.options[0] ?? APPROVE_LABEL;
	let customText = "";
	let customSelected = false;

	panelEl.createDiv({ cls: "porygon-ask-question", text: payload.question });

	const optionsEl = panelEl.createDiv({ cls: "porygon-ask-options", attr: { role: "radiogroup" } });
	const optionButtons = payload.options.map((label) => {
		const button = optionsEl.createEl("button", {
			cls: "porygon-ask-option",
			attr: {
				type: "button",
				role: "radio",
				"aria-checked": String(label === selected),
			},
		});
		button.toggleClass("is-selected", label === selected);
		button.createSpan({ cls: "porygon-ask-option-indicator" });
		button.createSpan({ cls: "porygon-ask-option-label", text: label });
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			selected = label;
			customSelected = false;
			syncApproval();
		});
		return button;
	});

	const customRow = createCustomRow(panelEl, false, "", false, {
		toggle: () => {
			customSelected = !customSelected;
			if (customSelected) {
				selected = null;
			}
			syncApproval();
			if (customSelected) {
				customRow.textarea.focus();
			}
		},
		input: (value) => {
			customText = value;
			customSelected = value.trim().length > 0;
			if (customSelected) {
				selected = null;
			}
			syncApproval();
		},
		enter: () => settleApproval(),
	});

	const footerEl = panelEl.createDiv({ cls: "porygon-ask-footer" });
	const dismissButton = createFooterButton(footerEl, "Dismiss", "porygon-ask-dismiss");
	const footerActions = footerEl.createDiv({ cls: "porygon-ask-footer-actions" });
	const sendButton = createFooterButton(footerActions, "Send", "mod-cta porygon-ask-send");

	function settleApproval(): void {
		const reply = customSelected ? customText.trim() : (selected ?? "");
		callbacks.resolve(reply);
	}

	function syncApproval(): void {
		optionButtons.forEach((button, index) => {
			const isSelected = !customSelected && payload.options[index] === selected;
			button.toggleClass("is-selected", isSelected);
			button.setAttribute("aria-checked", String(isSelected));
		});
		customRow.indicator.toggleClass("is-selected", customSelected);
		customRow.indicator.setAttribute("aria-checked", String(customSelected));
		sendButton.disabled = !selected && !(customSelected && customText.trim().length > 0);
	}

	dismissButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		callbacks.resolve("");
	});

	sendButton.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		settleApproval();
	});

	syncApproval();
	window.requestAnimationFrame(() => optionButtons[0]?.focus());

	return {
		closeOnOutsideClick: false,
		onKeydown: (event) => {
			if (event.key !== "Escape") {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			callbacks.resolve("");
		},
		onClose: () => callbacks.onClose?.(),
	};
}

/**
 * Builds the ask popover contents and returns the PopoverHost configuration.
 */
export function buildAskUserWizard(
	rootEl: HTMLElement,
	payload: AskUserInterruptPayload,
	callbacks: AskUserWizardCallbacks,
): PopoverConfig {
	const panel = rootEl.createDiv({ cls: "porygon-ask-panel" });

	if (payload.kind === "approval") {
		panel.addClass("porygon-ask-approval");
		return createApprovalPrompt(panel, payload, callbacks);
	}

	panel.addClass("porygon-ask-wizard");
	return createQuestionsWizard(panel, payload, callbacks);
}
