export interface PopoverContext {
	rootEl: HTMLElement;
	requestClose: () => void;
}

export interface PopoverConfig {
	// Dismiss when a pointerdown lands outside the popover. Defaults to true.
	closeOnOutsideClick?: boolean;
	// Auto-close after this many milliseconds. Omit to keep open until dismissed.
	autoDismissMs?: number;
	// Custom keydown behavior (list navigation, bespoke Escape semantics, ...).
	// When provided it fully replaces the default Escape-to-close handler.
	onKeydown?: (event: KeyboardEvent) => void;
	// Invoked exactly once when the popover closes, regardless of cause.
	onClose?: () => void;
}

export interface PopoverHandle {
	readonly kind: string;
	close: () => void;
}

export type PopoverBuilder = (context: PopoverContext) => PopoverConfig | void;

/**
 * Owns the single popover that can be open at a time and centralizes the
 * shared lifecycle: element creation, capture-phase keydown/pointerdown
 * listeners, outside-click dismissal, auto-dismiss timers, and teardown.
 *
 * Opening any popover implicitly closes the previous one, so callers never
 * have to cross-call sibling close methods to enforce mutual exclusion.
 */
export class PopoverHost {
	private current: PopoverHandle | null = null;

	get openKind(): string | null {
		return this.current?.kind ?? null;
	}

	isOpen(kind?: string): boolean {
		if (!this.current) {
			return false;
		}
		return kind === undefined || this.current.kind === kind;
	}

	closeCurrent(): void {
		this.current?.close();
	}

	open(kind: string, anchorEl: HTMLElement, cls: string, build: PopoverBuilder): PopoverHandle {
		this.closeCurrent();

		const rootEl = anchorEl.createDiv({ cls });
		let closed = false;
		let config: PopoverConfig = {};
		let dismissTimer: number | null = null;
		let keydownHandler: ((event: KeyboardEvent) => void) | null = null;
		let pointerHandler: ((event: PointerEvent) => void) | null = null;

		const close = () => {
			if (closed) {
				return;
			}
			closed = true;
			if (dismissTimer !== null) {
				window.clearTimeout(dismissTimer);
				dismissTimer = null;
			}
			if (keydownHandler) {
				window.removeEventListener("keydown", keydownHandler, true);
				keydownHandler = null;
			}
			if (pointerHandler) {
				window.removeEventListener("pointerdown", pointerHandler, true);
				pointerHandler = null;
			}
			rootEl.remove();
			if (this.current === handle) {
				this.current = null;
			}
			config.onClose?.();
		};

		const handle: PopoverHandle = { kind, close };
		this.current = handle;

		try {
			config = build({ rootEl, requestClose: close }) ?? {};
		} catch (error) {
			console.error(`Unable to open Porygon "${kind}" popover`, error);
			rootEl.remove();
			if (this.current === handle) {
				this.current = null;
			}
			return handle;
		}

		keydownHandler = (event: KeyboardEvent) => {
			if (config.onKeydown) {
				config.onKeydown(event);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				close();
			}
		};
		window.addEventListener("keydown", keydownHandler, true);

		if (config.closeOnOutsideClick !== false) {
			pointerHandler = (event: PointerEvent) => {
				const target = event.target;
				if (target instanceof Node && rootEl.contains(target)) {
					return;
				}
				close();
			};
			window.addEventListener("pointerdown", pointerHandler, true);
		}

		if (config.autoDismissMs !== undefined) {
			dismissTimer = window.setTimeout(close, config.autoDismissMs);
		}

		return handle;
	}
}
