import type { PorygonPluginSettings } from "../settings/settings";
import { getActiveProvider } from "../providers";
import { getMessageText, toSystemMessage } from "./streaming";

const SESSION_TITLE_SYSTEM_PROMPT = "Generate a short, concise title (max 6 words) for a conversation that starts with this message. Return ONLY the title, nothing else. Use the user's initial message as context when generating your response.";

export interface SessionTitleAgentOptions {
	settings: PorygonPluginSettings;
	userMessages: string[];
}

export async function generateSessionTitle(options: SessionTitleAgentOptions): Promise<string> {
	const provider = getActiveProvider(options.settings);
	const model = provider.createChatModel(options.settings, { thinking: false });
	const response = await model.invoke([
		toSystemMessage(SESSION_TITLE_SYSTEM_PROMPT),
		{ role: "user", content: options.userMessages.join("\n\n") },
	]);
	return getMessageText(response).trim();
}
