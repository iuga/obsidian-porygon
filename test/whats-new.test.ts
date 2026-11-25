import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WHATS_NEW_FEATURES, type WhatsNewFeature } from "../src/whats-new/features";
import {
	WHATS_NEW_STORAGE_KEY,
	dismiss,
	pickFeature,
	readDismissed,
} from "../src/whats-new/session";

function createStorage(initial: Record<string, string> = {}): Storage {
	const items = new Map(Object.entries(initial));
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (key: string) => items.get(key) ?? null,
		key: (index: number) => [...items.keys()][index] ?? null,
		removeItem: (key: string) => {
			items.delete(key);
		},
		setItem: (key: string, value: string) => {
			items.set(key, value);
		},
	};
}

const FEATURES: readonly WhatsNewFeature[] = [
	{ id: "a", text: "Feature A" },
	{ id: "b", text: "Feature B" },
	{ id: "c", text: "Feature C" },
];

void describe("pickFeature", () => {
	void test("returns the only feature that hasn't been dismissed", () => {
		const dismissed = new Set(["a", "c"]);
		for (const random of [() => 0, () => 0.5, () => 0.999]) {
			assert.equal(pickFeature(FEATURES, dismissed, random)?.id, "b");
		}
	});

	void test("returns undefined when every feature was dismissed", () => {
		assert.equal(pickFeature(FEATURES, new Set(["a", "b", "c"])), undefined);
	});

	void test("returns undefined for an empty feature list", () => {
		assert.equal(pickFeature([], new Set()), undefined);
	});

	void test("uses the injected random value to choose the index", () => {
		assert.equal(pickFeature(FEATURES, new Set(), () => 0)?.id, "a");
		assert.equal(pickFeature(FEATURES, new Set(), () => 0.5)?.id, "b");
		// A value at (or above) the upper bound still clamps to the last item.
		assert.equal(pickFeature(FEATURES, new Set(), () => 1)?.id, "c");
	});

	void test("never returns a dismissed id", () => {
		const dismissed = new Set(["b"]);
		for (let step = 0; step < 50; step += 1) {
			const picked = pickFeature(FEATURES, dismissed);
			assert.ok(picked);
			assert.notEqual(picked.id, "b");
		}
	});
});

void describe("dismissed storage", () => {
	void test("starts empty when nothing was stored", () => {
		assert.equal(readDismissed(createStorage()).size, 0);
	});

	void test("persists dismissed ids and ignores duplicates", () => {
		const storage = createStorage();
		dismiss(storage, "a");
		dismiss(storage, "b");
		dismiss(storage, "a");

		const dismissed = readDismissed(storage);
		assert.deepEqual([...dismissed].sort(), ["a", "b"]);
	});

	void test("tolerates corrupt JSON", () => {
		const storage = createStorage({ [WHATS_NEW_STORAGE_KEY]: "{not json" });
		assert.equal(readDismissed(storage).size, 0);
	});

	void test("tolerates a non-array value", () => {
		const storage = createStorage({ [WHATS_NEW_STORAGE_KEY]: JSON.stringify({ a: true }) });
		assert.equal(readDismissed(storage).size, 0);
	});

	void test("ignores non-string entries", () => {
		const storage = createStorage({ [WHATS_NEW_STORAGE_KEY]: JSON.stringify(["a", 2, null]) });
		assert.deepEqual([...readDismissed(storage)], ["a"]);
	});

	void test("degrades to an empty set when storage throws", () => {
		const throwing = {
			getItem: () => {
				throw new Error("unavailable");
			},
			setItem: () => {
				throw new Error("unavailable");
			},
		} as unknown as Storage;

		assert.equal(readDismissed(throwing).size, 0);
		assert.doesNotThrow(() => dismiss(throwing, "a"));
	});

	void test("treats missing storage as a no-op", () => {
		assert.equal(readDismissed(null).size, 0);
		assert.doesNotThrow(() => dismiss(null, "a"));
	});
});

void describe("bundled features", () => {
	void test("have unique ids and non-empty text", () => {
		const ids = new Set<string>();
		for (const feature of WHATS_NEW_FEATURES) {
			assert.ok(feature.text.trim().length > 0);
			assert.ok(!ids.has(feature.id));
			ids.add(feature.id);
		}
	});
});
