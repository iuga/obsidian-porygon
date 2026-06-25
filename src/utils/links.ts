const BROKEN_NOTE_LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]*\s[^)]*\.md)\)/gi;

/**
 * Rewrites broken Markdown note links into Obsidian wikilinks. The agent is
 * told to cite sources as `[[wikilink]]`, but it sometimes emits
 * `[title](io/wiki/Some Note.md)` instead. A CommonMark destination may not
 * contain spaces, so a path with a space renders as plain text and looks
 * broken. We only touch that broken case: a destination that contains
 * whitespace and ends in `.md`. Links without spaces already render fine
 * (including `%20`-encoded paths and external URLs), so we leave them alone.
 * Pure and DOM-free so it is safe on the streaming hot path.
 */
export function wikifyNoteLinks(content: string): string {
	if (!content.includes("](")) {
		return content;
	}

	return content.replace(BROKEN_NOTE_LINK_RE, (_match, text: string, dest: string) => {
		return `[[${dest.trim().replace(/\.md$/i, "")}|${text.trim()}]]`;
	});
}
