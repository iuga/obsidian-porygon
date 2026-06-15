import { getFrontMatterInfo, MarkdownRenderer, normalizePath, setIcon, TFile } from "obsidian";
import { ContentSegment, WidgetContext, WidgetDescriptor, WidgetRenderer } from "./types";

// type -> renderer. New widget types register here without touching the
// render pipeline or the parser. `file` and `quote` ship at launch.
const WIDGET_RENDERERS: Record<string, WidgetRenderer> = {
	file: renderFileWidget,
	quote: renderQuoteWidget,
};

const FILE_DESCRIPTION_MAX_LENGTH = 140;

/**
 * Renders parsed segments into `target` in order. Text segments go
 * through Obsidian's MarkdownRenderer; widget segments are built by the
 * registry. Both are awaited so segment order holds even when a renderer
 * is async (the file widget reads vault content for its description).
 * Unknown widget types fall back to their raw attributes as plain text so
 * a future tag never renders as a blank gap on older clients.
 */
export async function renderSegments(segments: ContentSegment[], target: HTMLElement, ctx: WidgetContext): Promise<void> {
	for (const segment of segments) {
		if (segment.kind === "text") {
			await MarkdownRenderer.render(ctx.app, segment.text, target, "/", ctx.component);
			continue;
		}
		await renderWidget(target, segment.descriptor, ctx);
	}
}

async function renderWidget(target: HTMLElement, descriptor: WidgetDescriptor, ctx: WidgetContext): Promise<void> {
	const renderer = WIDGET_RENDERERS[descriptor.type];
	if (!renderer) {
		renderUnknownWidget(target, descriptor);
		return;
	}
	await renderer(target, descriptor, ctx);
}

/**
 * File widget. Takes only `href`; the renderer resolves the vault file,
 * uses its basename as the label, and pulls the first lines of the body
 * as a short description for context. A missing file degrades to a plain,
 * non-interactive "not found" card so a stale link never looks clickable.
 */
async function renderFileWidget(containerEl: HTMLElement, descriptor: WidgetDescriptor, ctx: WidgetContext): Promise<void> {
	const href = (descriptor.attrs.href ?? "").trim();
	if (!href) {
		renderUnknownWidget(containerEl, descriptor);
		return;
	}

	const file = resolveVaultFile(ctx, href);
	if (!file) {
		renderMissingFileWidget(containerEl, href);
		return;
	}

	const widgetEl = containerEl.createDiv({ cls: "porygon-widget porygon-widget-file" });
	const linkEl = widgetEl.createEl("a", {
		cls: "porygon-widget-file-link",
		attr: { href, "aria-label": file.basename, role: "link", tabindex: "0" },
	});
	const iconEl = linkEl.createSpan({ cls: "porygon-widget-file-icon" });
	setIcon(iconEl, "file-text");
	const bodyEl = linkEl.createDiv({ cls: "porygon-widget-file-body" });
	bodyEl.createSpan({ cls: "porygon-widget-file-label", text: file.basename });
	const descriptionEl = bodyEl.createSpan({ cls: "porygon-widget-file-description" });

	const description = await readFileDescription(ctx, file);
	if (description) {
		descriptionEl.setText(description);
	} else {
		descriptionEl.remove();
	}

	linkEl.addEventListener("click", (event) => {
		event.preventDefault();
		ctx.openLink(href, event.ctrlKey || event.metaKey);
	});
	linkEl.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		event.preventDefault();
		ctx.openLink(href, event.ctrlKey || event.metaKey);
	});
}

/**
 * Quote widget. Wraps a passage taken from a file (`body`) and links back
 * to it (`href`). The quoted content is the widget's only text: no title.
 * Clicking anywhere on the quote opens the source file. A blank body or a
 * missing href degrades to nothing, since a quote with no passage or no
 * source has nothing meaningful to show.
 */
function renderQuoteWidget(containerEl: HTMLElement, descriptor: WidgetDescriptor, ctx: WidgetContext): void {
	const href = (descriptor.attrs.href ?? "").trim();
	const quote = (descriptor.body ?? "").trim();
	if (!href || !quote) {
		return;
	}

	const widgetEl = containerEl.createDiv({ cls: "porygon-widget porygon-widget-file porygon-widget-quote" });
	const linkEl = widgetEl.createEl("a", {
		cls: "porygon-widget-file-link",
		attr: { href, "aria-label": quote, role: "link", tabindex: "0" },
	});
	const iconEl = linkEl.createSpan({ cls: "porygon-widget-file-icon" });
	setIcon(iconEl, "quote");
	const bodyEl = linkEl.createDiv({ cls: "porygon-widget-file-body" });
	bodyEl.createSpan({ cls: "porygon-widget-quote-text", text: quote });

	const open = (event: MouseEvent | KeyboardEvent) => {
		event.preventDefault();
		ctx.openLink(href, event.ctrlKey || event.metaKey);
	};
	linkEl.addEventListener("click", open);
	linkEl.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		open(event);
	});
}

function resolveVaultFile(ctx: WidgetContext, href: string): TFile | null {
	const cleaned = stripLink(href);
	const candidates = cleaned.endsWith(".md") ? [cleaned] : [cleaned, `${cleaned}.md`];
	for (const candidate of candidates) {
		const file = ctx.app.vault.getAbstractFileByPath(normalizePath(candidate));
		if (file instanceof TFile) {
			return file;
		}
	}
	const destination = ctx.app.metadataCache.getFirstLinkpathDest(cleaned, "/");
	return destination instanceof TFile ? destination : null;
}

function stripLink(href: string): string {
	const trimmed = href.trim().replace(/\\/g, "/");
	const withoutWiki = trimmed.startsWith("[[") && trimmed.endsWith("]]") ? trimmed.slice(2, -2) : trimmed;
	const withoutSubpath = withoutWiki.split("#")[0] ?? withoutWiki;
	const withoutAlias = withoutSubpath.split("|")[0] ?? withoutSubpath;
	return withoutAlias.trim();
}

async function readFileDescription(ctx: WidgetContext, file: TFile): Promise<string> {
	if (file.extension !== "md") {
		return "";
	}
	try {
		const raw = await ctx.app.vault.cachedRead(file);
		return extractDescription(raw);
	} catch {
		// Read can fail on a file deleted between resolve and read; the
		// label alone is still useful, so degrade to no description.
		return "";
	}
}

function extractDescription(raw: string): string {
	const info = getFrontMatterInfo(raw);
	const body = info.exists ? raw.slice(info.contentStart) : raw;
	const firstParagraph = body
		.split(/\n\s*\n/)
		.map((block) => block.trim())
		.find((block) => block.length > 0);
	if (!firstParagraph) {
		return "";
	}

	const flattened = firstParagraph
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (flattened.length <= FILE_DESCRIPTION_MAX_LENGTH) {
		return flattened;
	}
	return `${flattened.slice(0, FILE_DESCRIPTION_MAX_LENGTH).trimEnd()}…`;
}

function renderMissingFileWidget(containerEl: HTMLElement, href: string): void {
	const widgetEl = containerEl.createDiv({ cls: "porygon-widget porygon-widget-file is-missing" });
	const iconEl = widgetEl.createSpan({ cls: "porygon-widget-file-icon" });
	setIcon(iconEl, "file-x");
	const bodyEl = widgetEl.createDiv({ cls: "porygon-widget-file-body" });
	bodyEl.createSpan({ cls: "porygon-widget-file-label", text: stripLink(href) });
	bodyEl.createSpan({ cls: "porygon-widget-file-description", text: "File not found" });
}

function renderUnknownWidget(containerEl: HTMLElement, descriptor: WidgetDescriptor): void {
	const fallback = descriptor.attrs.href ?? descriptor.attrs.label ?? "";
	if (!fallback) {
		return;
	}
	containerEl.createSpan({ cls: "porygon-widget-fallback", text: fallback });
}
