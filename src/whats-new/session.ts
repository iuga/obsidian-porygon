import type { WhatsNewFeature } from "./features";

export const WHATS_NEW_STORAGE_KEY = "porygon.whats-new.dismissed";

/**
 * Reads the dismissed feature ids. Missing, corrupt, or non-array values and
 * unavailable storage all degrade to an empty set: a tip is never important
 * enough to break the view.
 */
export function readDismissed(storage: Storage | null): Set<string> {
	if (!storage) {
		return new Set();
	}

	try {
		const raw = storage.getItem(WHATS_NEW_STORAGE_KEY);
		if (!raw) {
			return new Set();
		}

		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return new Set();
		}

		return new Set(parsed.filter((id): id is string => typeof id === "string"));
	} catch {
		return new Set();
	}
}

/** Marks a feature as dismissed for the rest of the Obsidian session. */
export function dismiss(storage: Storage | null, id: string): void {
	if (!storage) {
		return;
	}

	const dismissed = readDismissed(storage);
	if (dismissed.has(id)) {
		return;
	}

	dismissed.add(id);
	try {
		storage.setItem(WHATS_NEW_STORAGE_KEY, JSON.stringify([...dismissed]));
	} catch {
		// Storage can be full or unavailable; the tip is non-essential.
	}
}

/**
 * Picks a random feature that hasn't been dismissed yet, or `undefined` when
 * every feature has been seen. `random` is injectable so tests are
 * deterministic.
 */
export function pickFeature(
	features: readonly WhatsNewFeature[],
	dismissed: ReadonlySet<string>,
	random: () => number = Math.random,
): WhatsNewFeature | undefined {
	const available = features.filter((feature) => !dismissed.has(feature.id));
	if (available.length === 0) {
		return undefined;
	}

	const index = Math.min(available.length - 1, Math.floor(random() * available.length));
	return available[index];
}
