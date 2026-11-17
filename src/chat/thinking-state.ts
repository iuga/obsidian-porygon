/**
 * Pure reasoning-display helpers shared by the message row and its tests.
 *
 * `isThinkingCollapsed` is the per-message override: once the user (or the
 * turn lifecycle) sets it, it wins. Only while the flag is unset does the
 * setting decide the initial expansion for a live turn; finished turns
 * default to collapsed.
 */
export interface ThinkingStateInput {
	thinking?: string;
	isStreaming?: boolean;
	isThinkingCollapsed?: boolean;
	thinkingDurationSeconds?: number;
}

export interface ThinkingDisplayInput extends ThinkingStateInput {
	showThinkingByDefault: boolean;
}

export function isThinkingExpanded(input: ThinkingDisplayInput): boolean {
	if (input.isThinkingCollapsed !== undefined) {
		return !input.isThinkingCollapsed;
	}
	if (input.isStreaming) {
		return input.showThinkingByDefault;
	}
	return false;
}

export function getThinkingTitle(input: ThinkingStateInput): string {
	if (input.isStreaming) return "Thinking...";
	if (input.thinkingDurationSeconds === undefined) return "Thought";
	const unit = input.thinkingDurationSeconds === 1 ? "second" : "seconds";
	return `Thought for ${input.thinkingDurationSeconds} ${unit}`;
}
