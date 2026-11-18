/**
 * Feature flags for capabilities that are still experimental.
 *
 * This registry is the single source of truth: the Experimental settings
 * section renders from it, the settings type is derived from it, and runtime
 * checks go through `isFeatureEnabled`. Adding a flag means adding an entry
 * here plus the call-site guard where the feature actually runs.
 *
 * Pure and dependency-free so it stays unit-testable outside the app.
 */

export interface FeatureFlagDefinition {
	key: string;
	name: string;
	description: string;
	defaultEnabled: boolean;
}

export const FEATURE_FLAGS = [
	{
		key: "mermaidDiagrams",
		name: "Mermaid diagrams",
		description: "Let the assistant draw flowcharts, sequence, state, and other diagrams as Mermaid code blocks. Displays when a Mermaid renderer is enabled; otherwise the block stays copyable.",
		defaultEnabled: false,
	},
] as const satisfies readonly FeatureFlagDefinition[];

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]["key"];

export type FeatureFlagSettings = Record<FeatureFlagKey, boolean>;

export function isFeatureEnabled(settings: FeatureFlagSettings, key: FeatureFlagKey): boolean {
	return settings[key] === true;
}

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
	return FEATURE_FLAGS.some((flag) => flag.key === value);
}

/** Defaults derived from the registry, so a new flag can never miss one. */
export function featureFlagDefaults(): FeatureFlagSettings {
	const defaults = {} as FeatureFlagSettings;
	for (const flag of FEATURE_FLAGS) {
		defaults[flag.key] = flag.defaultEnabled;
	}
	return defaults;
}
