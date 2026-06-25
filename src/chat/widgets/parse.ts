import { ContentSegment, WidgetDescriptor } from "./types";

const WIDGET_TAG = "x-porygon-widget";
// Matches either a self-closing tag (<x-porygon-widget ... />) or a paired
// tag with inner content (<x-porygon-widget ...>body</x-porygon-widget>).
// Group 1 is the attribute chunk; group 2 is the body (paired form only).
const WIDGET_TAG_RE = new RegExp(`<${WIDGET_TAG}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${WIDGET_TAG}>)`, "g");
// A complete tag anchored at the start of a slice, used to decide whether
// a trailing opener has finished streaming.
const COMPLETE_TAG_AT_START_RE = new RegExp(`^<${WIDGET_TAG}\\b[^>]*?(?:/>|>[\\s\\S]*?</${WIDGET_TAG}>)`);
const WIDGET_OPENER = `<${WIDGET_TAG}`;
const ATTR_RE = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;

/**
 * Splits raw message content into ordered text/widget segments.
 *
 * Supports both self-closing widgets (`file`) and paired widgets that
 * wrap content (`quote`). Streaming-safe: a trailing tag that has not
 * finished streaming, whether the opener is incomplete (`<x-porygon-widget
 * type="quo`) or the body/closing tag has not arrived yet
 * (`<x-porygon-widget ...>partial`), is dropped so a half-written widget
 * never flashes as raw text. It parses normally once the rest streams in.
 */
export function parseMessageContent(raw: string): ContentSegment[] {
	const source = stripUnterminatedTrailingTag(raw);
	const segments: ContentSegment[] = [];
	let lastIndex = 0;

	WIDGET_TAG_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = WIDGET_TAG_RE.exec(source)) !== null) {
		const [fullMatch, attrChunk, body] = match;
		if (match.index > lastIndex) {
			pushText(segments, source.slice(lastIndex, match.index));
		}
		segments.push({ kind: "widget", descriptor: parseWidgetTag(attrChunk ?? "", body) });
		lastIndex = match.index + fullMatch.length;
	}

	if (lastIndex < source.length) {
		pushText(segments, source.slice(lastIndex));
	}
	return segments;
}

function stripUnterminatedTrailingTag(raw: string): string {
	const openerIndex = raw.lastIndexOf(WIDGET_OPENER);
	if (openerIndex === -1) {
		return raw;
	}
	// The last opener already forms a complete tag: nothing to strip.
	if (COMPLETE_TAG_AT_START_RE.test(raw.slice(openerIndex))) {
		return raw;
	}
	return raw.slice(0, openerIndex);
}

function pushText(segments: ContentSegment[], text: string): void {
	if (text.length === 0) {
		return;
	}
	segments.push({ kind: "text", text });
}

function parseWidgetTag(attrChunk: string, body: string | undefined): WidgetDescriptor {
	const attrs: Record<string, string> = {};
	ATTR_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ATTR_RE.exec(attrChunk)) !== null) {
		const [, name, value] = match;
		if (name) {
			attrs[name] = value ?? "";
		}
	}
	const type = attrs.type ?? "";
	delete attrs.type;
	const descriptor: WidgetDescriptor = { type, attrs };
	if (body !== undefined) {
		descriptor.body = body;
	}
	return descriptor;
}
