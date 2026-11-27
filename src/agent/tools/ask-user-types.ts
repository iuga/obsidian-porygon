// Dependency-free types and helpers shared by the agent tools and the UI.
// Keeping this module free of Obsidian and LangChain imports lets the Node test
// runner exercise payload normalization and formatting directly.

export interface AskUserOption {
	label: string;
	description?: string;
}

export interface AskUserQuestion {
	header: string;
	question: string;
	options: AskUserOption[];
	multiple?: boolean;
}

export interface AskUserQuestionsPayload {
	kind: "questions";
	questions: AskUserQuestion[];
}

export interface AskUserApprovalPayload {
	kind: "approval";
	question: string;
	options: [string, string]; // Approve, Deny
}

export type AskUserInterruptPayload =
	| AskUserQuestionsPayload
	| AskUserApprovalPayload;

export interface AskUserReply {
	answers: string[][]; // aligned with questions; [] = skipped/unanswered
	dismissed?: boolean;
}

// Approval still returns a plain string; questions return AskUserReply.
export type AskUserResumeValue = AskUserReply | string;

export const APPROVE_LABEL = "Approve";
export const DENY_LABEL = "Deny";
export const DEFAULT_QUESTION_HEADER = "Question";

export const MAX_ASK_USER_QUESTIONS = 8;
export const MAX_ASK_USER_OPTIONS = 8;
export const MAX_ASK_USER_HEADER_LENGTH = 30;
export const MAX_ASK_USER_LABEL_LENGTH = 60;
export const MAX_ASK_USER_DESCRIPTION_LENGTH = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function normalizeOption(value: unknown): AskUserOption | null {
	if (typeof value === "string") {
		const label = value.trim();
		return label ? { label } : null;
	}

	const record = asRecord(value);
	if (!record || typeof record.label !== "string" || !record.label.trim()) {
		return null;
	}

	const label = record.label.trim().slice(0, MAX_ASK_USER_LABEL_LENGTH);
	const description = typeof record.description === "string" && record.description.trim()
		? record.description.trim().slice(0, MAX_ASK_USER_DESCRIPTION_LENGTH)
		: undefined;

	return description ? { label, description } : { label };
}

function normalizeOptions(values: unknown[]): AskUserOption[] {
	return values
		.map(normalizeOption)
		.filter((option): option is AskUserOption => option !== null)
		.slice(0, MAX_ASK_USER_OPTIONS);
}

function normalizeQuestion(value: unknown): AskUserQuestion | null {
	const record = asRecord(value);
	if (!record || typeof record.question !== "string" || !record.question.trim()) {
		return null;
	}

	const header = typeof record.header === "string" && record.header.trim()
		? record.header.trim().slice(0, MAX_ASK_USER_HEADER_LENGTH)
		: DEFAULT_QUESTION_HEADER;
	const options = Array.isArray(record.options) ? normalizeOptions(record.options) : [];

	return {
		header,
		question: record.question.trim(),
		options,
		multiple: record.multiple === true,
	};
}

function normalizeQuestionsPayload(record: Record<string, unknown>): AskUserQuestionsPayload | null {
	if (!Array.isArray(record.questions)) {
		return null;
	}

	const questions = record.questions
		.map(normalizeQuestion)
		.filter((question): question is AskUserQuestion => question !== null)
		.slice(0, MAX_ASK_USER_QUESTIONS);

	return questions.length > 0 ? { kind: "questions", questions } : null;
}

function normalizeApprovalPayload(record: Record<string, unknown>): AskUserApprovalPayload | null {
	if (typeof record.question !== "string" || !record.question.trim()) {
		return null;
	}

	const options: unknown[] = Array.isArray(record.options) ? record.options as unknown[] : [];
	const first = options[0];
	const second = options[1];
	const pair: [string, string] = typeof first === "string" && typeof second === "string"
		? [first, second]
		: [APPROVE_LABEL, DENY_LABEL];

	return { kind: "approval", question: record.question.trim(), options: pair };
}

function normalizeLegacyPayload(record: Record<string, unknown>): AskUserInterruptPayload | null {
	if (typeof record.question !== "string" || !record.question.trim()) {
		return null;
	}

	if (!Array.isArray(record.options)) {
		return null;
	}

	const labels = record.options
		.filter((option): option is string => typeof option === "string")
		.map((label) => label.trim())
		.filter((label) => label.length > 0);

	if (labels.length === 2 && labels[0] === APPROVE_LABEL && labels[1] === DENY_LABEL) {
		return {
			kind: "approval",
			question: record.question.trim(),
			options: [APPROVE_LABEL, DENY_LABEL],
		};
	}

	return {
		kind: "questions",
		questions: [{
			header: DEFAULT_QUESTION_HEADER,
			question: record.question.trim(),
			options: labels.slice(0, MAX_ASK_USER_OPTIONS).map((label) => ({ label })),
			multiple: false,
		}],
	};
}

/**
 * Accepts the current questions/approval payloads plus the legacy
 * `{ question, options }` shape. Returns null for anything malformed so the
 * stream reader can ignore unrelated interrupts.
 */
export function normalizeAskUserPayload(value: unknown): AskUserInterruptPayload | null {
	const record = asRecord(value);
	if (!record) {
		return null;
	}

	if (record.kind === "questions") {
		return normalizeQuestionsPayload(record);
	}

	if (record.kind === "approval") {
		return normalizeApprovalPayload(record);
	}

	if (record.kind !== undefined) {
		return null;
	}

	return normalizeLegacyPayload(record);
}

function normalizeAnswerValues(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter((answer): answer is string => typeof answer === "string")
		.map((answer) => answer.trim())
		.filter((answer) => answer.length > 0);
}

/**
 * Formats the model-facing tool result. Strings (approval and legacy replies)
 * pass through unchanged so existing behavior is preserved.
 */
export function formatAskUserModelContent(questions: AskUserQuestion[], reply: unknown): string {
	if (typeof reply === "string") {
		return reply;
	}

	const record = asRecord(reply);
	if (!record) {
		return "";
	}

	if (record.dismissed === true) {
		return "User dismissed the questions without answering.";
	}

	const answers = Array.isArray(record.answers) ? record.answers : [];
	const parts = questions.map((question, index) => {
		const values = normalizeAnswerValues(answers[index]);
		const answerText = values.length > 0 ? values.join(", ") : "Unanswered";
		return `${JSON.stringify(question.question)}=${JSON.stringify(answerText)}`;
	});

	return `User has answered your questions: ${parts.join(", ")}. You can now continue with the user's answers in mind.`;
}
