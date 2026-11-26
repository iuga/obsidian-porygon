import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import {
	formatAskUserModelContent,
	MAX_ASK_USER_DESCRIPTION_LENGTH,
	MAX_ASK_USER_HEADER_LENGTH,
	MAX_ASK_USER_LABEL_LENGTH,
	MAX_ASK_USER_OPTIONS,
	MAX_ASK_USER_QUESTIONS,
	type AskUserQuestion,
	type AskUserQuestionsPayload,
	type AskUserResumeValue,
} from "./ask-user-types";
import { intentSchema } from "./shared";

const optionSchema = z.object({
	label: z.string().min(1).max(MAX_ASK_USER_LABEL_LENGTH).describe("Short option label, 1 to 5 words."),
	description: z.string().max(MAX_ASK_USER_DESCRIPTION_LENGTH).optional().describe("Optional one-sentence explanation of the option."),
});

const questionSchema = z.object({
	header: z.string().min(1).max(MAX_ASK_USER_HEADER_LENGTH).describe("Short tab/progress label for this question, at most 30 characters."),
	question: z.string().min(1).describe("The complete question to show the user."),
	options: z.array(optionSchema).max(MAX_ASK_USER_OPTIONS).describe("Up to 8 options. Use an empty array for a free-text-only question."),
	multiple: z.boolean().optional().describe("True for a multi-select (checkbox) question; omit for single-select (radio)."),
});

export const askUserTool = tool(
	async ({ questions }: { questions: AskUserQuestion[] }): Promise<string> => {
		const payload: AskUserQuestionsPayload = { kind: "questions", questions };
		const reply = interrupt<AskUserQuestionsPayload, AskUserResumeValue>(payload);
		return formatAskUserModelContent(questions, reply);
	},
	{
		name: "ask_user",
		description: [
			"Ask the user one or more related questions and pause the agent until they reply.",
			"Put all related questions in one call instead of making several sequential calls.",
			"Never batch ask_user with any other tool call.",
			"Each question has a short header, a complete question, and 0 to 8 options with labels and optional descriptions.",
			"Use options: [] for a free-text question. Set multiple: true for multi-select; omit it for single-select.",
			"A \"Type your own answer\" option is always added automatically; do not include \"Other\" or catch-all options.",
			"If you recommend an option, put it first and append \" (Recommended)\" to its label.",
			"Use this only when the answer changes your next action; do not use it to confirm completed work or to offer a menu of next actions.",
		].join(" "),
		schema: z.object({
			intent: intentSchema,
			questions: z.array(questionSchema).min(1).max(MAX_ASK_USER_QUESTIONS).describe("Between 1 and 8 related questions. The UI presents them one at a time."),
		}),
	}
);
