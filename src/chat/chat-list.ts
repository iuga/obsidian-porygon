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

	constructor(containerEl: HTMLElement, deps: ChatListDeps) {
		this.containerEl = containerEl;
		this.deps = deps;
	}

	/**
	 * Reconcile DOM to the given message array. Order is enforced via
	 * insertBefore so reordered messages (rare) don't trigger re-renders.
	 */
	setMessages(messages: ChatMessage[], emptyQuote?: string): void {
		const seen = new Set<ChatMessage>();
		let cursor: Node | null = this.containerEl.firstChild;

		// First, make sure any empty-state node is gone before reconciling.
		if (this.emptyEl) {
			this.emptyEl.remove();
			this.emptyEl = null;
		}

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
