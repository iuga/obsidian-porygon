import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { ChatMessage, MentionedItem, MentionType, StreamingDeltaKind } from "./types";

interface MessageRowDeps {
	app: App;
	component: Component;
	showToolUsage: () => boolean;
	onMentionClickRemove?: (path: string) => void;
}

/**
 * Owns the DOM for a single ChatMessage. The row is the only place that
 * calls MarkdownRenderer.render for its message. ChatList reuses the same
 * row across re-renders so historical messages are never rebuilt; deltas
 * during streaming only touch this row's bubbles.
 *
 * The streaming render is rAF-coalesced with a render-then-swap strategy:
 * we render into a detached <div>, then atomically replace the visible
 * element's children. This avoids the empty() + async render race that
 * shows half-built trees.
 */
export class MessageRow {
	readonly el: HTMLElement;
	private message: ChatMessage;
	private deps: MessageRowDeps;

	// Last strings committed to the DOM, used as equality guards so a
	// no-op delta or a redundant update() doesn't repeat markdown work.
	private renderedContent: string | null = null;
	private renderedThinking: string | null = null;
	private renderedToolCount = 0;
	private renderedShowThinking = false;
	private renderedShowTools = false;
	private renderedThinkingTitle = "";
	private renderedToolsTitle = "";
	private renderedIsStreaming = false;
	private renderedThinkingCollapsed: boolean | null = null;
	private renderedToolsCollapsed: boolean | null = null;

	// Bubble element refs (created on demand, kept across updates).
	private thinkingDetailsEl: HTMLDetailsElement | null = null;
	private thinkingTitleEl: HTMLSpanElement | null = null;
	private thinkingContentEl: HTMLElement | null = null;
	private toolsDetailsEl: HTMLDetailsElement | null = null;
	private toolsTitleEl: HTMLSpanElement | null = null;
	private toolsListEl: HTMLElement | null = null;
	private contentBubbleEl: HTMLElement | null = null;
	private contentEl: HTMLElement | null = null;
	private messageStackEl: HTMLElement | null = null;

	// rAF coalescing state. Lives per-row so concurrent streams (future)
	// can't race each other, and so finalizeStreaming() can await drains.
	private contentRenderHandle: number | null = null;
	private contentRenderInFlight: Promise<void> | null = null;
	private contentRenderPending = false;
	private thinkingRenderHandle: number | null = null;
	private thinkingRenderInFlight: Promise<void> | null = null;
	private thinkingRenderPending = false;

	// Lazy historical-thinking render: collapsed thinking bubbles in past
	// turns are kept as plain text so renderMessages on a long thread does
	// not pay N markdown renders. Materialized on first <details> open.
	private historicalThinkingMaterialized = false;
	private historicalThinkingToggleHandler: (() => void) | null = null;

	constructor(message: ChatMessage, deps: MessageRowDeps) {
		this.message = message;
		this.deps = deps;
		this.el = document.createElement("div");
		this.el.addClass("porygon-message-row", `is-${message.role}`);
		this.buildSkeleton();
		this.update(message, /*forceFull*/ true);
	}

	getMessage(): ChatMessage {
		return this.message;
	}

	dispose(): void {
		this.cancelStreamingRenders();
		this.el.remove();
	}

	/**
	 * Reconcile DOM to the current message state. Cheap when nothing
	 * relevant changed (equality guards short-circuit per-section).
	 */
	update(message: ChatMessage, forceFull = false): void {
		this.message = message;
		if (message.role === "warning") {
			this.renderWarning();
			return;
		}
		if (message.role === "file") {
			return;
		}

		const showThinking = message.role === "porygon" && !!message.thinking;
		const showTools = this.deps.showToolUsage() && message.role === "porygon" && !!message.toolIntents && message.toolIntents.length > 0;
		const showContent = !(message.role === "porygon" && !message.content);

		this.reconcileMentions(message);
		this.reconcileThinking(message, showThinking, forceFull);
		this.reconcileTools(message, showTools, forceFull);
		this.reconcileContent(message, showContent, forceFull);

		this.renderedShowThinking = showThinking;
		this.renderedShowTools = showTools;
		this.renderedIsStreaming = !!message.isStreaming;
	}

	/**
	 * Streaming hot path. Called for every delta; coalesces to one render
	 * per animation frame and never touches other rows.
	 */
	notifyStreamingDelta(kind: StreamingDeltaKind): void {
		if (!this.message.isStreaming) return;
		if (kind === "content") {
			if (!this.contentEl) {
				// Target not yet in the DOM (content arrives after a thinking
				// preamble, or this is the first delta after a placeholder).
				// One reconcile materializes the bubble; subsequent deltas
				// take the rAF fast path.
				this.update(this.message);
				return;
			}
			this.scheduleContentRender();
		} else if (kind === "thinking") {
			if (!this.thinkingContentEl) {
				this.update(this.message);
				return;
			}
			this.scheduleThinkingRender();
		} else if (kind === "tool") {
			// Tools are structural (new <li>), rare, and cheap. Reconcile.
			this.update(this.message);
		}
	}

	/**
	 * Drain pending streaming work so a caller can be sure the last delta
	 * has been committed before flipping isStreaming = false. Used on
	 * end-of-turn so the row's "historical" render is final.
	 */
	async finalizeStreaming(): Promise<void> {
		this.cancelStreamingRenders();
		const pending: Array<Promise<void>> = [];
		if (this.contentRenderInFlight) pending.push(this.contentRenderInFlight);
		if (this.thinkingRenderInFlight) pending.push(this.thinkingRenderInFlight);
		if (pending.length > 0) {
			await Promise.allSettled(pending);
		}
	}

	private buildSkeleton(): void {
		if (this.message.role === "warning") {
			return;
		}
		this.messageStackEl = this.el.createDiv({ cls: "porygon-message-stack" });
	}

	private renderWarning(): void {
		this.el.empty();
		this.el.className = "porygon-message-row is-warning";
		const warningEl = this.el.createDiv({ cls: "porygon-chat-warning" });
		const iconEl = warningEl.createDiv({ cls: "porygon-chat-warning-icon" });
		setIcon(iconEl, "triangle-alert");
		warningEl.createDiv({ cls: "porygon-chat-warning-content", text: this.message.content });
	}

	private reconcileMentions(message: ChatMessage): void {
		if (!this.messageStackEl) return;
		// Mentions are immutable per message; render once on first build.
		if (message.role !== "user" || !message.mentions || message.mentions.length === 0) return;
		if (this.messageStackEl.querySelector(":scope > .porygon-mention-tags")) return;
		const tagsEl = this.messageStackEl.createDiv({ cls: "porygon-mention-tags" });
		this.messageStackEl.insertBefore(tagsEl, this.messageStackEl.firstChild);
		this.renderMentionTags(tagsEl, message.mentions);
	}

	private renderMentionTags(containerEl: HTMLElement, mentions: MentionedItem[]): void {
		mentions.forEach((mention) => {
			const tag = containerEl.createDiv({
				cls: "porygon-mention-tag",
				attr: { title: mention.path, "aria-label": mention.basename },
			});
			const icon = tag.createSpan({ cls: "porygon-mention-tag-icon" });
			setIcon(icon, getMentionIcon(mention.type));
			tag.createSpan({ cls: "porygon-mention-tag-title", text: mention.basename });
		});
	}

	private reconcileThinking(message: ChatMessage, showThinking: boolean, forceFull: boolean): void {
		if (!this.messageStackEl) return;
		if (!showThinking) {
			if (this.thinkingDetailsEl) {
				this.thinkingDetailsEl.remove();
				this.thinkingDetailsEl = null;
				this.thinkingTitleEl = null;
				this.thinkingContentEl = null;
				this.renderedThinking = null;
				this.renderedThinkingCollapsed = null;
				this.historicalThinkingMaterialized = false;
			}
			return;
		}

		const thinking = message.thinking ?? "";
		const title = getThinkingTitle(message);
		const isStreaming = !!message.isStreaming;
		const streamingTransition = this.renderedIsStreaming !== isStreaming;

		if (!this.thinkingDetailsEl) {
			this.buildThinkingBubble(message);
		}

		// Sync collapsed state from message flags (set by view.ts at
		// end-of-turn) so completed responses auto-collapse the bubble.
		const collapsed = !!message.isThinkingCollapsed;
		if (this.thinkingDetailsEl && this.renderedThinkingCollapsed !== collapsed) {
			this.thinkingDetailsEl.open = !collapsed;
			this.renderedThinkingCollapsed = collapsed;
		}

		if (this.thinkingTitleEl && (forceFull || title !== this.renderedThinkingTitle)) {
			this.thinkingTitleEl.setText(title);
			this.renderedThinkingTitle = title;
		}

		if (!this.thinkingContentEl) return;

		// Streaming branch: rAF-coalesced markdown render.
		if (isStreaming) {
			if (streamingTransition || this.renderedThinking === null) {
				// Bubble was just created (or moved into streaming mode);
				// schedule a render so the equality guard updates.
				this.scheduleThinkingRender();
			} else if (thinking !== this.renderedThinking) {
				this.scheduleThinkingRender();
			}
			return;
		}

		// Historical branch.
		if (streamingTransition) {
			// Just finished streaming: keep what's on screen (already
			// markdown-rendered) and switch to lazy mode for future opens.
			this.historicalThinkingMaterialized = true;
		}
		this.bindHistoricalThinking(message, thinking);
	}

	private buildThinkingBubble(message: ChatMessage): void {
		if (!this.messageStackEl) return;
		const details = this.messageStackEl.createEl("details", { cls: "porygon-thinking-bubble" });
		details.open = !message.isThinkingCollapsed;
		const summary = details.createEl("summary", { cls: "porygon-thinking-summary" });
		const iconEl = summary.createSpan({ cls: "porygon-thinking-icon" });
		setIcon(iconEl, "lightbulb");
		const titleEl = summary.createSpan({ text: "" });
		summary.addEventListener("click", () => {
			window.setTimeout(() => {
				message.isThinkingCollapsed = !details.open;
				this.renderedThinkingCollapsed = !details.open;
			}, 0);
		});
		const contentEl = details.createDiv({ cls: "porygon-thinking-content markdown-rendered" });
		// Insert thinking before tools/content so order is preserved.
		this.messageStackEl.insertBefore(details, this.toolsDetailsEl ?? this.contentBubbleEl);
		this.thinkingDetailsEl = details;
		this.thinkingTitleEl = titleEl;
		this.thinkingContentEl = contentEl;
		this.renderedThinking = null;
	}

	private bindHistoricalThinking(message: ChatMessage, thinking: string): void {
		const details = this.thinkingDetailsEl;
		const contentEl = this.thinkingContentEl;
		if (!details || !contentEl) return;
		const materialize = () => {
			if (this.historicalThinkingMaterialized && this.renderedThinking === thinking) return;
			this.historicalThinkingMaterialized = true;
			this.renderedThinking = thinking;
			contentEl.empty();
			void MarkdownRenderer.render(this.deps.app, thinking, contentEl, "/", this.deps.component).then(() => {
				if (details.open) {
					contentEl.scrollTop = contentEl.scrollHeight;
				}
			});
		};
		if (!this.historicalThinkingMaterialized) {
			if (details.open) {
				materialize();
			} else {
				contentEl.empty();
				contentEl.setText(thinking);
			}
		}
		if (!this.historicalThinkingToggleHandler) {
			this.historicalThinkingToggleHandler = () => {
				if (details.open) materialize();
			};
			details.addEventListener("toggle", this.historicalThinkingToggleHandler);
		}
	}

	private reconcileTools(message: ChatMessage, showTools: boolean, forceFull: boolean): void {
		if (!this.messageStackEl) return;
		if (!showTools) {
			if (this.toolsDetailsEl) {
				this.toolsDetailsEl.remove();
				this.toolsDetailsEl = null;
				this.toolsTitleEl = null;
				this.toolsListEl = null;
				this.renderedToolCount = 0;
				this.renderedToolsCollapsed = null;
			}
			return;
		}

		const intents = message.toolIntents ?? [];
		const title = getToolsTitle(message);

		if (!this.toolsDetailsEl) {
			this.buildToolsBubble(message);
		}

		const collapsed = !!message.areToolsCollapsed;
		if (this.toolsDetailsEl && this.renderedToolsCollapsed !== collapsed) {
			this.toolsDetailsEl.open = !collapsed;
			this.renderedToolsCollapsed = collapsed;
		}
		if (this.toolsTitleEl && (forceFull || title !== this.renderedToolsTitle)) {
			this.toolsTitleEl.setText(title);
			this.renderedToolsTitle = title;
		}
		if (!this.toolsListEl) return;
		if (forceFull || intents.length !== this.renderedToolCount) {
			// Append only the new items; keep existing nodes so collapsed
			// detail UI / DOM identity is preserved.
			if (intents.length < this.renderedToolCount) {
				this.toolsListEl.empty();
				this.renderedToolCount = 0;
			}
			for (let i = this.renderedToolCount; i < intents.length; i += 1) {
				const intent = intents[i];
				if (!intent) continue;
				const itemEl = this.toolsListEl.createEl("li", { cls: "porygon-tools-item" });
				itemEl.createSpan({ cls: "porygon-tools-intent", text: intent.intent });
			}
			this.renderedToolCount = intents.length;
		}
	}

	private buildToolsBubble(message: ChatMessage): void {
		if (!this.messageStackEl) return;
		const details = this.messageStackEl.createEl("details", { cls: "porygon-tools-bubble" });
		details.open = !message.areToolsCollapsed;
		const summary = details.createEl("summary", { cls: "porygon-tools-summary" });
		const iconEl = summary.createSpan({ cls: "porygon-tools-icon" });
		setIcon(iconEl, "wrench");
		const titleEl = summary.createSpan({ text: "" });
		summary.addEventListener("click", () => {
			window.setTimeout(() => {
				message.areToolsCollapsed = !details.open;
				this.renderedToolsCollapsed = !details.open;
			}, 0);
		});
		const listEl = details.createEl("ul", { cls: "porygon-tools-list" });
		this.messageStackEl.insertBefore(details, this.contentBubbleEl);
		this.toolsDetailsEl = details;
		this.toolsTitleEl = titleEl;
		this.toolsListEl = listEl;
		this.renderedToolCount = 0;
	}

	private reconcileContent(message: ChatMessage, showContent: boolean, forceFull: boolean): void {
		if (!this.messageStackEl) return;
		if (!showContent) {
			if (this.contentBubbleEl) {
				this.contentBubbleEl.remove();
				this.contentBubbleEl = null;
				this.contentEl = null;
				this.renderedContent = null;
			}
			return;
		}

		if (!this.contentBubbleEl) {
			this.buildContentBubble(message);
		}
		if (!this.contentEl) return;

		if (message.role === "porygon") {
			const isStreaming = !!message.isStreaming;
			const streamingTransition = this.renderedIsStreaming !== isStreaming;
			if (isStreaming) {
				if (streamingTransition || this.renderedContent === null || message.content !== this.renderedContent) {
					this.scheduleContentRender();
				}
				return;
			}
			if (forceFull || streamingTransition || message.content !== this.renderedContent) {
				this.contentEl.empty();
				this.renderedContent = message.content;
				void MarkdownRenderer.render(this.deps.app, message.content, this.contentEl, "/", this.deps.component);
			}
			return;
		}

		// User message: plain text.
		if (forceFull || message.content !== this.renderedContent) {
			this.contentEl.empty();
			this.contentEl.setText(message.content);
			this.renderedContent = message.content;
		}
	}

	private buildContentBubble(message: ChatMessage): void {
		if (!this.messageStackEl) return;
		const bubble = this.messageStackEl.createDiv({ cls: "porygon-message-bubble" });
		const iconEl = bubble.createDiv({ cls: "porygon-message-icon" });
		setIcon(iconEl, message.role === "user" ? "user" : "origami");
		const contentEl = bubble.createDiv({ cls: "porygon-message-content" });
		if (message.role === "porygon") {
			contentEl.addClass("markdown-rendered");
		}
		this.contentBubbleEl = bubble;
		this.contentEl = contentEl;
		this.renderedContent = null;
	}

	// --- Streaming render scheduling --------------------------------------

	private scheduleContentRender(): void {
		if (!this.contentEl) return;
		const message = this.message;
		if (message.content === this.renderedContent) return;
		if (this.contentRenderHandle !== null) return;
		this.contentRenderHandle = window.requestAnimationFrame(() => {
			this.contentRenderHandle = null;
			void this.runContentRender();
		});
	}

	private runContentRender(): Promise<void> {
		if (this.contentRenderInFlight) {
			this.contentRenderPending = true;
			return this.contentRenderInFlight;
		}
		const target = this.contentEl;
		const message = this.message;
		if (!target) return Promise.resolve();
		if (message.content === this.renderedContent) return Promise.resolve();
		const snapshot = message.content;
		const run = (async () => {
			try {
				const staging = document.createElement("div");
				await MarkdownRenderer.render(this.deps.app, snapshot, staging, "/", this.deps.component);
				if (this.contentEl !== target) return;
				target.empty();
				while (staging.firstChild) {
					target.appendChild(staging.firstChild);
				}
				this.renderedContent = snapshot;
			} finally {
				this.contentRenderInFlight = null;
				if (this.contentRenderPending) {
					this.contentRenderPending = false;
					this.scheduleContentRender();
				}
			}
		})();
		this.contentRenderInFlight = run;
		return run;
	}

	private scheduleThinkingRender(): void {
		if (!this.thinkingContentEl) return;
		const thinking = this.message.thinking ?? "";
		if (thinking === this.renderedThinking) return;
		if (this.thinkingRenderHandle !== null) return;
		this.thinkingRenderHandle = window.requestAnimationFrame(() => {
			this.thinkingRenderHandle = null;
			void this.runThinkingRender();
		});
	}

	private runThinkingRender(): Promise<void> {
		if (this.thinkingRenderInFlight) {
			this.thinkingRenderPending = true;
			return this.thinkingRenderInFlight;
		}
		const target = this.thinkingContentEl;
		if (!target) return Promise.resolve();
		const snapshot = this.message.thinking ?? "";
		if (snapshot === this.renderedThinking) return Promise.resolve();
		const run = (async () => {
			try {
				const staging = document.createElement("div");
				await MarkdownRenderer.render(this.deps.app, snapshot, staging, "/", this.deps.component);
				if (this.thinkingContentEl !== target) return;
				target.empty();
				while (staging.firstChild) {
					target.appendChild(staging.firstChild);
				}
				this.renderedThinking = snapshot;
				if (this.thinkingDetailsEl?.open) {
					target.scrollTop = target.scrollHeight;
				}
			} finally {
				this.thinkingRenderInFlight = null;
				if (this.thinkingRenderPending) {
					this.thinkingRenderPending = false;
					this.scheduleThinkingRender();
				}
			}
		})();
		this.thinkingRenderInFlight = run;
		return run;
	}

	private cancelStreamingRenders(): void {
		if (this.contentRenderHandle !== null) {
			window.cancelAnimationFrame(this.contentRenderHandle);
			this.contentRenderHandle = null;
		}
		if (this.thinkingRenderHandle !== null) {
			window.cancelAnimationFrame(this.thinkingRenderHandle);
			this.thinkingRenderHandle = null;
		}
		this.contentRenderPending = false;
		this.thinkingRenderPending = false;
	}
}

function getThinkingTitle(message: ChatMessage): string {
	if (message.isStreaming) return "Thinking...";
	if (message.thinkingDurationSeconds === undefined) return "Thought";
	const unit = message.thinkingDurationSeconds === 1 ? "second" : "seconds";
	return `Thought for ${message.thinkingDurationSeconds} ${unit}`;
}

function getToolsTitle(message: ChatMessage): string {
	const toolCount = message.toolIntents?.length ?? 0;
	const unit = toolCount === 1 ? "tool" : "tools";
	return `${toolCount} ${unit} used`;
}

function getMentionIcon(type: MentionType): string {
	if (type === "folder") return "folder";
	if (type === "active-note") return "star";
	return "sticky-note";
}
