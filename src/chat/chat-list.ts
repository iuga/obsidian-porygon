import { App, Component } from "obsidian";
import { MessageRow } from "./message-row";
import { ChatMessage, StreamingDeltaKind } from "./types";

interface ChatListDeps {
	app: App;
	component: Component;
	showToolUsage: () => boolean;
}

const EMPTY_QUOTE_CLASS = "porygon-empty-chat-quote";
const ANCHORED_CLASS = "is-anchored";

/**
 * Owns chatHistoryEl and a Map<ChatMessage, MessageRow>. setMessages()
 * reconciles the list by object identity: existing rows are reused (no
 * markdown re-render), missing rows are unmounted, new rows are mounted.
 *
 * Scroll behaviour follows the ChatGPT pattern:
 *   - The container has `overflow-anchor: auto` and a monotonic bottom
 *     buffer (a virtual ::after flex item the size of one viewport).
 *     The buffer is added on first send and never removed; the
 *     scrollable height stays stable across the whole session and
 *     makes "user message at top of viewport" always reachable.
 *   - On send we perform exactly one smooth scroll that aligns the new
 *     user message to the top of the viewport.
 *   - As streamed content grows, we bottom-follow: if the user hasn't
 *     scrolled away from the bottom of the real content, we snap
 *     scrollTop to keep the latest tokens visible. The buffer keeps a
 *     full viewport of room available below.
 *   - Any user scroll cancels the auto-follow until the next send.
 */
export class ChatList {
	private containerEl: HTMLElement;
	private deps: ChatListDeps;
	private rows = new Map<ChatMessage, MessageRow>();
	private emptyEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;

	// Bottom-follow state. Engaged once the initial smooth scroll on
	// pinMessageToTop has parked us at the top of the new user message;
	// any user-initiated scroll drops it.
	private autoFollow = false;
	private autoFollowEnableTimer: number | null = null;
	private programmaticScrollPending = 0;

	private onScroll = (): void => {
		if (this.programmaticScrollPending > 0) {
			this.programmaticScrollPending -= 1;
			return;
		}
		this.autoFollow = false;
	};

	constructor(containerEl: HTMLElement, deps: ChatListDeps) {
		this.containerEl = containerEl;
		this.deps = deps;
		this.containerEl.addEventListener("scroll", this.onScroll, { passive: true });
		this.resizeObserver = new ResizeObserver(() => {
			this.followBottomIfNeeded();
		});
		this.resizeObserver.observe(this.containerEl);
	}

	private getContentBottom(): number {
		// The real content bottom = scrollHeight minus the trailing
		// virtual buffer. We model the buffer as one clientHeight set
		// by --porygon-chat-buffer.
		const styles = window.getComputedStyle(this.containerEl);
		const buffer = parseFloat(styles.getPropertyValue("--porygon-chat-buffer")) || 0;
		return this.containerEl.scrollHeight - buffer;
	}

	private followBottomIfNeeded(): void {
		if (!this.autoFollow) return;
		const contentBottom = this.getContentBottom();
		const target = contentBottom - this.containerEl.clientHeight;
		if (target <= this.containerEl.scrollTop + 0.5) return;
		this.programmaticScrollPending += 1;
		this.containerEl.scrollTop = target;
	}

	/**
	 * Smooth-scroll the given message to the top of the viewport. Adds
	 * the monotonic bottom buffer on first call so the scroll target is
	 * always reachable, then engages auto-follow once the animation
	 * window closes. Called once per user send.
	 */
	pinMessageToTop(message: ChatMessage): void {
		const row = this.rows.get(message);
		if (!row) return;
		this.containerEl.style.setProperty("--porygon-chat-buffer", `${this.containerEl.clientHeight}px`);
		this.containerEl.addClass(ANCHORED_CLASS);
		this.autoFollow = false;
		if (this.autoFollowEnableTimer !== null) {
			window.clearTimeout(this.autoFollowEnableTimer);
		}
		requestAnimationFrame(() => {
			if (!row.el.isConnected) return;
			const anchorTop = row.el.getBoundingClientRect().top - this.containerEl.getBoundingClientRect().top + this.containerEl.scrollTop;
			this.programmaticScrollPending += 1;
			this.containerEl.scrollTo({ top: anchorTop, behavior: "smooth" });
			// Engage auto-follow after the smooth scroll has completed
			// so it doesn't fight the animation. 700ms is a comfortable
			// budget for the browser's smooth scroll on any viewport.
			this.autoFollowEnableTimer = window.setTimeout(() => {
				this.autoFollowEnableTimer = null;
				this.autoFollow = true;
				this.followBottomIfNeeded();
			}, 700);
		});
	}

	/**
	 * Reconcile DOM to the given message array. Order is enforced via
	 * insertBefore so reordered messages (rare) don't trigger re-renders.
	 */
	setMessages(messages: ChatMessage[], emptyQuote?: string): void {
		const seen = new Set<ChatMessage>();

		// Remove the empty-state node BEFORE snapshotting firstChild, otherwise
		// cursor may point to a node we're about to detach, and the next
		// insertBefore() throws NotFoundError.
		if (this.emptyEl) {
			this.emptyEl.remove();
			this.emptyEl = null;
		}

		let cursor: Node | null = this.containerEl.firstChild;

		for (const message of messages) {
			if (message.role === "file") continue;
			seen.add(message);

			let row = this.rows.get(message);
			if (!row) {
				row = new MessageRow(message, {
					app: this.deps.app,
					component: this.deps.component,
					showToolUsage: this.deps.showToolUsage,
				});
				this.rows.set(message, row);
				this.resizeObserver?.observe(row.el);
			} else {
				row.update(message);
			}

			if (cursor !== row.el) {
				this.containerEl.insertBefore(row.el, cursor);
			} else {
				cursor = row.el.nextSibling;
				continue;
			}
			cursor = row.el.nextSibling;
		}

		// Unmount rows whose messages were removed.
		for (const [message, row] of this.rows) {
			if (seen.has(message)) continue;
			this.resizeObserver?.unobserve(row.el);
			row.dispose();
			this.rows.delete(message);
		}

		if (this.rows.size === 0 && emptyQuote !== undefined) {
			this.emptyEl = this.containerEl.createDiv({ cls: EMPTY_QUOTE_CLASS, text: emptyQuote });
		}
	}

	/**
	 * Re-reconcile a single message's row. Use after structural state
	 * changes (e.g. tool intent fired, isStreaming flipped). Cheap: never
	 * touches other rows.
	 */
	notifyChanged(message: ChatMessage): void {
		const row = this.rows.get(message);
		if (!row) return;
		row.update(message);
	}

	/**
	 * Streaming hot path. Routes a delta to the right per-row rAF queue
	 * without re-running list reconciliation.
	 */
	notifyStreamingDelta(message: ChatMessage, kind: StreamingDeltaKind): void {
		const row = this.rows.get(message);
		if (!row) {
			// Row hasn't been mounted yet; defer to the caller's next
			// setMessages() pass.
			return;
		}
		row.notifyStreamingDelta(kind);
	}

	/**
	 * Drain pending streaming work for one message so the caller can be
	 * certain the last delta committed before flipping isStreaming = false.
	 */
	async finalizeStreaming(message: ChatMessage): Promise<void> {
		const row = this.rows.get(message);
		if (!row) return;
		await row.finalizeStreaming();
	}

	dispose(): void {
		if (this.autoFollowEnableTimer !== null) {
			window.clearTimeout(this.autoFollowEnableTimer);
			this.autoFollowEnableTimer = null;
		}
		this.containerEl.removeEventListener("scroll", this.onScroll);
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		for (const row of this.rows.values()) {
			row.dispose();
		}
		this.rows.clear();
		if (this.emptyEl) {
			this.emptyEl.remove();
			this.emptyEl = null;
		}
		this.containerEl.removeClass(ANCHORED_CLASS);
		this.containerEl.style.removeProperty("--porygon-chat-buffer");
	}
}
