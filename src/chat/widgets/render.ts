import { getFrontMatterInfo, MarkdownRenderer, normalizePath, setIcon, TFile } from "obsidian";
import { wikifyNoteLinks } from "../../utils/links";
import { renderMeetingWidget, renderMeetingsWidget } from "./meeting";
import { ContentSegment, WidgetContext, WidgetDescriptor, WidgetRenderer } from "./types";

// type -> renderer. New widget types register here without touching the
// render pipeline or the parser. `file` and `callout` ship at launch.
const WIDGET_RENDERERS: Record<string, WidgetRenderer> = {
	file: renderFileWidget,
	callout: renderCalloutWidget,
	meeting: renderMeetingWidget,
	meetings: renderMeetingsWidget,
};

// Predefined callout variants. The agent only picks a semantic `variant`;
// the icon and accent color are fixed here so callouts stay consistent
// and theme correctly via Obsidian's color vars. Unknown/missing variants
// fall back to DEFAULT_CALLOUT_VARIANT.
interface CalloutVariant {
	icon: string;
	color: string;
}
const DEFAULT_CALLOUT_VARIANT = "note";
const DEFAULT_CALLOUT: CalloutVariant = { icon: "info", color: "var(--color-blue)" };
const CALLOUT_VARIANTS: Record<string, CalloutVariant> = {
	idea: { icon: "lightbulb", color: "var(--color-yellow)" },
	insight: { icon: "sparkles", color: "var(--color-purple)" },
	[DEFAULT_CALLOUT_VARIANT]: DEFAULT_CALLOUT,
	success: { icon: "circle-check", color: "var(--color-green)" },
	hot: { icon: "flame", color: "var(--color-pink)" },
	warning: { icon: "triangle-alert", color: "var(--color-orange)" },
	danger: { icon: "octagon-alert", color: "var(--color-red)" },
	quote: { icon: "quote", color: "var(--text-muted)" },
};

const FILE_DESCRIPTION_MAX_LENGTH = 140;

/**
 * Renders parsed segments into `target` in order. Text segments go
 * through Obsidian's MarkdownRenderer; widget segments are built by the
 * registry. Both are awaited so segment order holds even when a renderer
 * is async (the file widget reads vault content for its description).
 * Unknown widget types degrade to a plain-text fallback so a future tag
 * never renders as a blank gap on older clients.
 */
export async function renderSegments(segments: ContentSegment[], target: HTMLElement, ctx: WidgetContext): Promise<void> {
	for (const segment of segments) {
		if (segment.kind === "text") {
			await MarkdownRenderer.render(ctx.app, wikifyNoteLinks(segment.text), target, "/", ctx.component);
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
		attr: { "data-href": href, "aria-label": file.basename, role: "link", tabindex: "0" },
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

	bindOpenLink(linkEl, href, ctx);
}

/**
 * Callout widget. Highlights a passage (`body`) with a predefined icon
 * and accent color chosen by `variant`. `href` is optional: when present
 * the whole callout becomes a clickable card that opens the source file
 * (e.g. variant="quote" with an href is a quote pulled from a note); when
 * absent it is a static highlight (e.g. variant="quote" alone is a quote
 * with no source) whose body is rendered as markdown so wikilinks and
 * other inline markup stay clickable. A blank body degrades to nothing.
 */
async function renderCalloutWidget(containerEl: HTMLElement, descriptor: WidgetDescriptor, ctx: WidgetContext): Promise<void> {
	const text = (descriptor.body ?? "").trim();
	if (!text) {
		return;
	}

	const { key: variantKey, icon, color } = resolveCalloutVariant(descriptor.attrs.variant);
	const href = (descriptor.attrs.href ?? "").trim();

	const widgetEl = containerEl.createDiv({ cls: "porygon-widget porygon-widget-callout" });
	widgetEl.addClass(`is-${variantKey}`);
	widgetEl.style.setProperty("--porygon-callout-color", color);

	const cardEl: HTMLElement = href
		? widgetEl.createEl("a", {
			cls: "porygon-widget-callout-card is-link",
			attr: { "data-href": href, "aria-label": text, role: "link", tabindex: "0" },
		})
		: widgetEl.createDiv({ cls: "porygon-widget-callout-card" });

	const iconEl = cardEl.createSpan({ cls: "porygon-widget-callout-icon" });
	setIcon(iconEl, icon);

	const textEl = cardEl.createSpan({ cls: "porygon-widget-callout-text" });
	if (href) {
		// The card itself opens the source, so the body stays plain text:
		// rendering markdown here would nest anchors inside the card's <a>.
		textEl.setText(text);
		bindOpenLink(cardEl, href, ctx);
		return;
	}

	textEl.addClass("is-markdown");
	await MarkdownRenderer.render(ctx.app, wikifyNoteLinks(text), textEl, "/", ctx.component);
}

/**
 * Wires a clickable element to open `href` through the host. Click and
 * keyboard (Enter/Space) both route to ctx.openLink, with ctrl/meta
 * opening in a new leaf. Shared by every widget that renders a link.
 */
function bindOpenLink(el: HTMLElement, href: string, ctx: WidgetContext): void {
	const open = (event: MouseEvent | KeyboardEvent) => {
		event.preventDefault();
		ctx.openLink(href, event.ctrlKey || event.metaKey);
	};
	el.addEventListener("click", open);
	el.addEventListener("keydown", (event) => {
		if (event.key !== "Enter" && event.key !== " ") {
			return;
		}
		open(event);
	});
}

function resolveCalloutVariant(rawVariant: string | undefined): { key: string; icon: string; color: string } {
	const key = (rawVariant ?? "").trim().toLowerCase();
	const variant = CALLOUT_VARIANTS[key];
	if (variant) {
		return { key, ...variant };
	}
	return { key: DEFAULT_CALLOUT_VARIANT, ...DEFAULT_CALLOUT };
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
