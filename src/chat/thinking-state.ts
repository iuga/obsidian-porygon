/**
 * Pure reasoning-display helpers shared by the message row, the view, and
 * their tests.
 *
 * `isThinkingCollapsed` is the per-message override: once the user (or the
 * turn lifecycle) sets it, it wins. While it is unset, a live turn follows
 * the setting and a finished turn is collapsed.
 */

export function isThinkingExpanded(input: {
	isStreaming?: boolean;
	isThinkingCollapsed?: boolean;
	showThinkingByDefault: boolean;
}): boolean {
	if (input.isThinkingCollapsed !== undefined) {
		return !input.isThinkingCollapsed;
	}
	if (input.isStreaming) {
		return input.showThinkingByDefault;
	}
	return false;
}

/**
 * The reasoning phase runs from the first delta until the answer starts.
 * The view freezes `thinkingDurationSeconds` at that moment, so a defined
 * duration is the phase boundary; tool execution still belongs to it.
 */
export function isReasoningActive(input: {
	isStreaming?: boolean;
	thinkingDurationSeconds?: number;
}): boolean {
	return !!input.isStreaming && input.thinkingDurationSeconds === undefined;
}

export function getThinkingTitle(input: {
	isStreaming?: boolean;
	thinkingDurationSeconds?: number;
}): string {
	if (input.isStreaming) return "Reasoning...";
	if (input.thinkingDurationSeconds === undefined) return "Reasoned";
	const unit = input.thinkingDurationSeconds === 1 ? "second" : "seconds";
	return `Reasoned for ${input.thinkingDurationSeconds} ${unit}`;
}
