import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FEATURE_FLAGS, featureFlagDefaults, featureFlagForSkill, isFeatureEnabled, isFeatureFlagKey } from "../src/settings/feature-flags";

void describe("feature flags", () => {
	void test("registry keys are unique", () => {
		const keys = FEATURE_FLAGS.map((flag) => flag.key);
		assert.equal(new Set(keys).size, keys.length);
	});

	void test("every flag is off by default", () => {
		const defaults = featureFlagDefaults();
		for (const flag of FEATURE_FLAGS) {
			assert.equal(defaults[flag.key], false, `${flag.key} should default to off`);
		}
	});
});

void describe("isFeatureEnabled", () => {
	void test("only an explicit true enables a flag", () => {
		assert.equal(isFeatureEnabled({ mermaidDiagrams: true }, "mermaidDiagrams"), true);
		assert.equal(isFeatureEnabled({ mermaidDiagrams: false }, "mermaidDiagrams"), false);
	});

	void test("a missing key is treated as off", () => {
		const legacySettings = {} as { mermaidDiagrams: boolean };
		assert.equal(isFeatureEnabled(legacySettings, "mermaidDiagrams"), false);
	});
});

void describe("isFeatureFlagKey", () => {
	void test("recognizes registry keys", () => {
		assert.equal(isFeatureFlagKey("mermaidDiagrams"), true);
	});

	void test("rejects ordinary settings keys", () => {
		assert.equal(isFeatureFlagKey("showThinking"), false);
	});
});

void describe("featureFlagForSkill", () => {
	void test("returns the flag declared on the registry entry", () => {
		assert.equal(featureFlagForSkill("diagrammer"), "mermaidDiagrams");
	});

	void test("returns undefined for an ungated skill", () => {
		assert.equal(featureFlagForSkill("summarizer"), undefined);
	});
});
