import { isFeatureEnabled, type FeatureFlagKey, type FeatureFlagSettings } from "../settings/feature-flags";
import type { AgentSkill } from "./skills";

/**
 * Maps a bundled skill to the experimental flag that guards it. A skill
 * without an entry is always visible; a skill whose flag is off is filtered
 * out of `<available_skills>`, so the model never loads it.
 *
 * Pure and dependency-free on purpose (the `obsidian`-dependent modules are
 * reached only through type imports) so it is unit-testable outside the app.
 */
const SKILL_FEATURE_FLAGS: Readonly<Partial<Record<string, FeatureFlagKey>>> = {
	diagrammer: "mermaidDiagrams",
};

export function filterAvailableSkills(
	skills: readonly AgentSkill[],
	featureFlags: FeatureFlagSettings,
): readonly AgentSkill[] {
	return skills.filter((skill) => {
		const flag = SKILL_FEATURE_FLAGS[skill.name];
		return flag === undefined || isFeatureEnabled(featureFlags, flag);
	});
}
