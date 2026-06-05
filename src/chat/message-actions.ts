import { setIcon, setTooltip } from "obsidian";

export interface MessageAction {
	icon: string;
	label: string;
	onClick: (buttonEl: HTMLButtonElement) => void;
}

/**
 * Builds the hover-revealed actions bar shown below an agent response.
 * Kept generic so future actions (regenerate, share, ...) drop in by
 * appending another descriptor. The bar is built once per row and the
 * row toggles its visibility via CSS hover, so no layout shift occurs
 * and the chat auto-scroll is never disturbed.
 */
export function renderMessageActions(containerEl: HTMLElement, actions: MessageAction[]): HTMLElement {
	const barEl = containerEl.createDiv({ cls: "porygon-message-actions" });
	for (const action of actions) {
		const buttonEl = barEl.createEl("button", {
			cls: "porygon-message-action",
			attr: { type: "button", "aria-label": action.label },
		});
		setTooltip(buttonEl, action.label, { placement: "top" });
		setIcon(buttonEl, action.icon);
		buttonEl.addEventListener("click", () => action.onClick(buttonEl));
	}
	return barEl;
}

/**
 * Copies text to the clipboard. Best-effort: clipboard access can be
 * denied, and a failed copy is silently ignored.
 */
export async function copyToClipboard(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		// Clipboard write can fail (permissions, no focus); nothing to recover.
	}
}
