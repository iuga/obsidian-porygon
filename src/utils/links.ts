const MARKDOWN_NOTE_LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
const EXTERNAL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Rewrites stray Markdown note links into Obsidian wikilinks so they render
 * and resolve inside the chat. The agent is instructed to cite sources as
 * `[[wikilink]]`, but it sometimes emits `[title](io/wiki/Some Note.md)`
 * instead. A CommonMark destination may not contain spaces, so such links
 * fall back to literal text and look broken. We convert any link whose
 * destination points at a vault Markdown note (ends in `.md`, not an
 * external URL) into `[[path|title]]`, preserving the visible text and any
 * `#heading` subpath. External links, images, and non-note links are left
 * untouched. Pure and DOM-free so it is safe on the streaming hot path.
 */
export function wikifyNoteLinks(content: string): string {
	if (!content || !content.includes("](")) {
		return content;
	}

	return content.replace(MARKDOWN_NOTE_LINK_RE, (match, rawText: string, rawDest: string) => {
		const text = rawText.trim();
		let dest = rawDest.trim();

		// CommonMark allows wrapping a destination in <...> to permit spaces.
		if (dest.startsWith("<") && dest.endsWith(">")) {
			dest = dest.slice(1, -1).trim();
		}

		// Leave external/scheme links (http:, https:, mailto:, obsidian:, ...).
		if (EXTERNAL_SCHEME_RE.test(dest)) {
			return match;
		}

		// Drop a leading ./ but keep the rest of the vault-relative path.
		dest = dest.replace(/^\.\//, "");

		const hashIndex = dest.indexOf("#");
		let path = hashIndex === -1 ? dest : dest.slice(0, hashIndex);
		const sub = hashIndex === -1 ? "" : dest.slice(hashIndex + 1);

		// Decode percent-encoding (e.g. %20 -> space) best-effort.
		try {
			path = decodeURIComponent(path);
		} catch {
			// Malformed escape sequences: fall back to the raw path.
		}

		// Only rewrite links that target a vault Markdown note.
		if (!/\.md$/i.test(path)) {
			return match;
		}

		const target = path.replace(/\.md$/i, "").trim();
		if (!target) {
			return match;
		}

		const linkBody = sub ? `${target}#${sub}` : target;
		return text && text !== linkBody ? `[[${linkBody}|${text}]]` : `[[${linkBody}]]`;
	});
}
