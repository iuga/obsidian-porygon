const WIKILINK_IN_LINK_RE = /(?<!!)\[([^\]]+)\]\(\s*\[\[([^\]]+)\]\]\s*\)/g;
const BROKEN_NOTE_LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]*\s[^)]*\.md)\)/gi;
const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Rewrites broken Markdown note links into Obsidian wikilinks. The agent is
 * told to cite sources as `[[wikilink]]`, but it sometimes wraps them in
 * Markdown link syntax that renders as plain text instead of a clickable
 * link. We fix the two shapes it emits:
 *
 *   1. `[title]([[Some Note]])` — a wikilink used as a Markdown destination.
 *      Markdown cannot parse the `[[...]]` destination, so the whole thing
 *      renders literally. We unwrap it to `[[Some Note|title]]`.
 *   2. `[title](io/wiki/Some Note.md)` — a vault-relative path with a space.
 *      A CommonMark destination may not contain spaces, so it falls back to
 *      literal text. We convert it to `[[io/wiki/Some Note|title]]`.
 *
 * Links without spaces already render fine (including `%20`-encoded paths),
 * and external links (http:, mailto:, ...) are left untouched. Pure and
 * DOM-free so it is safe on the streaming hot path.
 */
export function wikifyNoteLinks(content: string): string {
	if (!content.includes("](")) {
		return content;
	}

	const unwrapped = content.replace(WIKILINK_IN_LINK_RE, (_match, text: string, inner: string) => {
		const target = inner.trim();
		// An inner alias (`Note|Alias`) already carries its own display text.
		if (target.includes("|")) {
			return `[[${target}]]`;
		}
		const label = text.trim();
		return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`;
	});

	return unwrapped.replace(BROKEN_NOTE_LINK_RE, (match, text: string, dest: string) => {
		const path = dest.trim();
		if (EXTERNAL_SCHEME_RE.test(path)) {
			return match;
		}
		return `[[${path.replace(/\.md$/i, "")}|${text.trim()}]]`;
	});
}
