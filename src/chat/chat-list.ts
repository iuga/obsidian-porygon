import { App, Component } from "obsidian";
import { MessageRow } from "./message-row";
import { ChatMessage, StreamingDeltaKind } from "./types";

interface ChatListDeps {
	app: App;
	component: Component;
	showToolUsage: () => boolean;
}

const EMPTY_QUOTE_CLASS = "porygon-empty-chat-quote";

/**
 * Owns chatHistoryEl and a Map<ChatMessage, MessageRow>. setMessages()
 * reconciles the list by object identity: existing rows are reused (no
 * markdown re-render), missing rows are unmounted, new rows are mounted.
 *
 * This is the core fix for "every event re-renders the whole conversation":
 * historical rows are never torn down. Only the row whose message changed
 * sees any DOM work, and a streaming row routes all its delta work through
 * its own per-row rAF state machine.
 */
export class ChatList {
	private containerEl: HTMLElement;
	private deps: ChatListDeps;
	private rows = new Map<ChatMessage, MessageRow>();
	private emptyEl: HTMLElement | null = null;
	private spacerEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;

	// Scroll model:
	// - When a message is pinned, scrollTop = max(anchor.offsetTop, bottom).
	//   Initially the anchor sits at the viewport top with empty space below;
	//   as the streamed reply grows, the bottom eventually exceeds the
	//   anchor's top and we naturally start following the bottom.
	// - stickToBottom is the no-anchor fallback so that when content grows
	//   while the user is already at the bottom (e.g. after the pin has been
	//   superseded by bottom-follow) we keep them pinned.
	// - Any user-initiated scroll disengages both.
	private anchorEl: HTMLElement | null = null;
	private stickToBottom = true;
	private pendingProgrammaticScrolls = 0;
	private onScroll = (): void => {
		if (this.pendingProgrammaticScrolls > 0) {
			this.pendingProgrammaticScrolls -= 1;
			return;
		}
		this.anchorEl = null;
		this.stickToBottom = this.isAtBottom();
	};

	constructor(containerEl: HTMLElement, deps: ChatListDeps) {
		this.containerEl = containerEl;
		this.deps = deps;
		this.containerEl.addEventListener("scroll", this.onScroll, { passive: true });
		// Observe each row so growth from markdown render / streaming
		// deltas triggers applyScroll. A single observer on the container
		// does NOT fire when descendants change size, only when the
		// container's own box changes.
		this.resizeObserver = new ResizeObserver(() => {
			this.applyScroll();
		});
		this.resizeObserver.observe(this.containerEl);
	}

	private isAtBottom(): boolean {
		// 4px slack absorbs sub-pixel rounding from zoom/devicePixelRatio.
		const distance = this.containerEl.scrollHeight - this.containerEl.clientHeight - this.containerEl.scrollTop;
		return distance <= 4;
	}

	private setScrollTop(value: number): void {
		const clamped = Math.max(0, Math.min(value, this.containerEl.scrollHeight - this.containerEl.clientHeight));
		if (Math.abs(this.containerEl.scrollTop - clamped) < 0.5) return;
		this.pendingProgrammaticScrolls += 1;
		this.containerEl.scrollTop = clamped;
	}

	private getAnchorOffsetTop(): number {
		if (!this.anchorEl) return 0;
		// getBoundingClientRect + current scrollTop gives the row's offset
		// inside the scroll content regardless of offsetParent chain
		// (offsetTop can be wrong when an ancestor is the offsetParent).
		return this.anchorEl.getBoundingClientRect().top - this.containerEl.getBoundingClientRect().top + this.containerEl.scrollTop;
	}

	private applyScroll(): void {
		if (this.anchorEl) {
			if (!this.anchorEl.isConnected) {
				this.anchorEl = null;
				this.updateSpacer();
				return;
			}
			this.updateSpacer();
			const anchorTop = this.getAnchorOffsetTop();
			const bottom = this.containerEl.scrollHeight - this.containerEl.clientHeight;
			this.setScrollTop(Math.max(0, Math.min(anchorTop, bottom)));
			return;
		}
		this.updateSpacer();
		if (this.stickToBottom) {
			this.setScrollTop(this.containerEl.scrollHeight);
		}
	}

	// While anchored, add bottom padding so the anchor row can actually
	// reach the top of the viewport even when there is very little content
	// after it (e.g. just the "Connecting..." placeholder). The padding
	// shrinks as real content fills in and disappears once the anchor is
	// dropped.
	private ensureSpacer(): HTMLElement {
		if (!this.spacerEl) {
			this.spacerEl = this.containerEl.createDiv({ cls: "porygon-chat-bottom-spacer" });
		}
		if (this.spacerEl.parentElement !== this.containerEl || this.spacerEl !== this.containerEl.lastChild) {
			this.containerEl.appendChild(this.spacerEl);
		}
		return this.spacerEl;
	}

	private updateSpacer(): void {
		if (!this.anchorEl) {
			if (this.spacerEl) {
				this.spacerEl.remove();
				this.spacerEl = null;
			}
			return;
		}
		const spacer = this.ensureSpacer();
		// One full viewport of bottom padding while pinned. This guarantees
		// there is always enough scrollable room for scrollTop = anchorTop
		// to actually land the anchor at the top of the viewport, even when
		// the streamed reply is still just "Connecting...". The spacer is
		// removed entirely when the anchor is dropped.
		const target = this.containerEl.clientHeight;
		if (Math.abs(target - spacer.offsetHeight) >= 1) {
			spacer.style.height = `${target}px`;
		}
	}

	/**
	 * Pin the given message to the top of the viewport. As subsequent
	 * content grows, the row stays anchored until the bottom of the
	 * content overtakes the anchor's top, after which we follow the
	 * bottom. Any user scroll cancels the anchor.
	 */
	pinMessageToTop(message: ChatMessage): void {
		const row = this.rows.get(message);
		if (!row) return;
		this.anchorEl = row.el;
		this.stickToBottom = false;
		// Apply now (layout is usually ready after the synchronous
		// setMessages above) and again next frame in case the row's
		// content height changes after a follow-up async render.
		this.applyScroll();
		requestAnimationFrame(() => this.applyScroll());
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

			// Move the row into position if it isn't already there. This
			// is a no-op when DOM order matches state order (the common case),
			// so we never thrash the layout on every render.
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

		// Re-apply scroll: new rows may have shifted the anchor's offsetTop,
		// and the spacer needs to be re-evaluated against the new content.
		this.applyScroll();
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
	}
}
