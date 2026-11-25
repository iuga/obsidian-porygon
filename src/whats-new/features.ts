export interface WhatsNewFeature {
	id: string;
	/** The whole card: capability, payoff, and any enable instruction. */
	text: string;
}

/**
 * Tips shown on the empty chat screen. Keep the copy about what the user can
 * now do and why it matters — no version numbers and no implementation
 * vocabulary in the lead sentence. `id` is internal and never rendered.
 */
export const WHATS_NEW_FEATURES: readonly WhatsNewFeature[] = [
	{
		id: "session-files",
		text: "Pick up any conversation where you left off. Every chat is a file in your vault — double-click it and keep going, even days later.",
	},
	{
		id: "highlights",
		text: "Write ==highlights== and Porygon reads them as emphasis. It highlights its own key takeaways too, so long answers stay skimmable.",
	},
	{
		id: "parallel-tools",
		text: "Bigger requests come back faster. When a question touches several notes, Porygon works on them all at once instead of one at a time.",
	},
	{
		id: "mermaid-diagrams",
		text: "Turn a note into a diagram. Ask for a flowchart, sequence diagram, or mind map and get it rendered right in the chat, ready to reuse. (Enable it in Settings → Porygon → Experimental.)",
	},
];
