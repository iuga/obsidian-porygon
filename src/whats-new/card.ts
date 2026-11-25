import { setIcon } from "obsidian";
import type { WhatsNewFeature } from "./features";

export interface WhatsNewCardOptions {
	onDismiss: (feature: WhatsNewFeature) => void;
}

/**
 * Renders a single tip inside the empty-chat container. The caller owns
 * removal; the close button only reports the dismissal.
 */
export function renderWhatsNewCard(
	parentEl: HTMLElement,
	feature: WhatsNewFeature,
	options: WhatsNewCardOptions,
): HTMLElement {
	const cardEl = parentEl.createDiv({ cls: "porygon-whats-new-card" });
	cardEl.setAttribute("role", "note");

	// A lightbulb marks this as an optional tip, visually distinct from the
	// welcome quote above it.
	const iconEl = cardEl.createSpan({ cls: "porygon-whats-new-icon" });
	setIcon(iconEl, "lightbulb");

	// A text node, not Markdown: `==highlights==` must show literally.
	cardEl.createSpan({ cls: "porygon-whats-new-text", text: feature.text });

	const closeEl = cardEl.createEl("button", {
		cls: "porygon-whats-new-close",
		attr: {
			type: "button",
			"aria-label": "Dismiss tip",
			title: "Dismiss",
		},
	});
	setIcon(closeEl, "x");
	closeEl.addEventListener("click", () => options.onDismiss(feature));

	return cardEl;
}
