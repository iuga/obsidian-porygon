import { AgentToolCallIntent } from "../agent";

export type ChatRole = "user" | "porygon" | "warning" | "file";
export type MentionType = "note" | "folder" | "active-note";

export interface MentionedFile {
	path: string;
	basename: string;
}

export interface MentionedItem {
	type: MentionType;
	path: string;
	basename: string;
	files: MentionedFile[];
}

export interface ChatMessage {
	role: ChatRole;
	content: string;
	createdAt?: string;
	mentions?: MentionedItem[];
	thinking?: string;
	isThinkingCollapsed?: boolean;
	thinkingDurationSeconds?: number;
	toolIntents?: AgentToolCallIntent[];
	areToolsCollapsed?: boolean;
	// True only while the agent is actively streaming into this message.
	// Flipped off in finalizeStreaming() so the row renders through the
	// historical path on subsequent updates.
	isStreaming?: boolean;
}

export type StreamingDeltaKind = "content" | "thinking" | "tool";
