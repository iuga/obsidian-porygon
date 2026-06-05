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
 * Copies text to the clipboard and gives transient "Copied" feedback by
 * swapping the button icon to a checkmark, then restoring it.
 */
export async function copyToClipboard(buttonEl: HTMLButtonElement, text: string, restoreIcon: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		setIcon(buttonEl, "check");
		setTooltip(buttonEl, "Copied", { placement: "top" });
		window.setTimeout(() => {
			setIcon(buttonEl, restoreIcon);
			setTooltip(buttonEl, "Copy response", { placement: "top" });
		}, 1500);
	} catch {
		setTooltip(buttonEl, "Copy failed", { placement: "top" });
	}
}
