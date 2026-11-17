/**
 * Pure composer helpers shared by the chat view and their tests.
 *
 * The slash-command popover is opened by typing "/" into the message input, but
 * that keystroke still inserts the character before focus moves to the popover
 * filter. `stripSlashTrigger` removes exactly that character once a command is
 * selected, so the composer is not left holding a stray "/".
 */

export interface SlashTriggerRemoval {
	value: string;
	caret: number;
}

/**
 * Removes the "/" recorded at `index` when it opened the popover.
 *
 * Returns null when there is no trigger to remove (the popover was opened from
 * the toolbar, or the input changed since), letting callers leave the composer
 * and any draft text untouched.
 */
export function stripSlashTrigger(value: string, index: number | null): SlashTriggerRemoval | null {
	if (index === null || index < 0 || index >= value.length || value[index] !== "/") {
		return null;
	}

	return {
		value: `${value.slice(0, index)}${value.slice(index + 1)}`,
		caret: index,
	};
}
