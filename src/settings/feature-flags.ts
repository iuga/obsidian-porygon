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
	/**
	 * Skill name (the frontmatter `name` of a bundled skill) that only the
	 * agent sees while this flag is on. This is the only declaration of the
	 * association: seeding and prompt visibility both derive from it.
	 */
	gatesSkill?: string;
}

export const FEATURE_FLAGS = [
	{
		key: "mermaidDiagrams",
		name: "Mermaid diagrams",
		description: "Let the assistant draw flowcharts, sequence, state, and other diagrams as Mermaid code blocks that Obsidian renders in chat.",
		defaultEnabled: false,
		gatesSkill: "diagrammer",
	},
] as const satisfies readonly FeatureFlagDefinition[];

// Widened view of the registry so optional fields like `gatesSkill` stay
// addressable on every entry, not just the ones that declare them.
const FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = FEATURE_FLAGS;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[number]["key"];

export type FeatureFlagSettings = Record<FeatureFlagKey, boolean>;

export function isFeatureEnabled(settings: FeatureFlagSettings, key: FeatureFlagKey): boolean {
	return settings[key] === true;
}

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
	return FEATURE_FLAGS.some((flag) => flag.key === value);
}

/** The flag that gates a skill, or undefined when the skill is always available. */
export function featureFlagForSkill(skillName: string): FeatureFlagKey | undefined {
	for (const flag of FLAG_DEFINITIONS) {
		if (flag.gatesSkill === skillName && isFeatureFlagKey(flag.key)) {
			return flag.key;
		}
	}
	return undefined;
}

/** Defaults derived from the registry, so a new flag can never miss one. */
export function featureFlagDefaults(): FeatureFlagSettings {
	const defaults = {} as FeatureFlagSettings;
	for (const flag of FEATURE_FLAGS) {
		defaults[flag.key] = flag.defaultEnabled;
	}
	return defaults;
}
