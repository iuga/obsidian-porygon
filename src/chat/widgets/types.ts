import { App, Component } from "obsidian";

/**
 * A parsed widget tag. `type` selects the renderer from the registry;
 * `attrs` carries the raw attribute values verbatim (e.g. href). `body`
 * is the inner content of a paired tag (<...>body</...>), present only
 * for widgets that wrap content such as `quote`. Unknown attributes are
 * kept so renderers can opt into them later.
 */
export interface WidgetDescriptor {
	type: string;
	attrs: Record<string, string>;
	body?: string;
}

/**
 * Message content split into ordered, renderable segments. Text runs go
 * through MarkdownRenderer; widget runs are built by the widget registry.
 * Order matches the source string so widgets render where they appear.
 */
export type ContentSegment =
	| { kind: "text"; text: string }
	| { kind: "widget"; descriptor: WidgetDescriptor };

/**
 * Everything a widget renderer needs from the host, injected so this
 * module never imports view.ts / message-row.ts. Keeps widgets reusable
 * outside the chat surface.
 */
export interface WidgetContext {
	app: App;
	component: Component;
	// Opens a vault link. `newLeaf` mirrors ctrl/meta-click semantics.
	openLink: (href: string, newLeaf: boolean) => void;
}

/**
 * Builds the DOM for one widget type into `containerEl`. Registered in
 * render.ts. May be async (e.g. the file widget reads vault content for
 * its description); renderSegments awaits it so segment order holds.
 */
export type WidgetRenderer = (containerEl: HTMLElement, descriptor: WidgetDescriptor, ctx: WidgetContext) => void | Promise<void>;
