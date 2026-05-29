import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { AskUserInterruptPayload, intentSchema } from "./shared";

export const askUserTool = tool(
	async ({ question, options }: { question: string; options: string[] }): Promise<string> => {
		// Defensive clamp: if the model produced more than 4 options, keep the
		// first 4 and ignore the rest instead of failing the call.
		const clampedOptions = options.slice(0, 4);
		const payload: AskUserInterruptPayload = { question, options: clampedOptions };
		const reply = interrupt<AskUserInterruptPayload, unknown>(payload);
		if (typeof reply === "string") {
			return reply;
		}
		if (reply === null || reply === undefined) {
			return "";
		}
		try {
			return JSON.stringify(reply);
		} catch {
			return "";
		}
	},
	{
		name: "ask_user",
		description: "Ask the user a single question with 2 to 4 short option labels. Pauses the agent until the user replies. The user can either pick one of the options (returned verbatim as a string) or type a free-form answer (returned as whatever they typed). Phrase the question so a typed free-form reply still makes sense, not only the listed options. Use this only when you genuinely need a choice from the user to proceed; do not use it to confirm work already done or to offer a menu of next actions.",
		schema: z.object({
			intent: intentSchema,
			question: z.string().min(1).describe("The question to show the user."),
			options: z.array(z.string().min(1)).min(2).max(4).describe("Between 2 and 4 short option labels for the user to choose from. The user may also reply free-form."),
		}),
	}
);
