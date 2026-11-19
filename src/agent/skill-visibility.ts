import { featureFlagForSkill, isFeatureEnabled, type FeatureFlagSettings } from "../settings/feature-flags";
import type { AgentSkill } from "./skills";

/**
 * Filters out skills gated by an experimental flag that is off, so the model
 * never sees them in `<available_skills>`.
 *
 * The skill-to-flag association is declared once, on the flag registry
 * (`FeatureFlagDefinition.gatesSkill`); this module only infers it.
 *
 * Pure and dependency-free on purpose (the `obsidian`-dependent modules are
 * reached only through type imports) so it is unit-testable outside the app.
 */
export function filterAvailableSkills(
	skills: readonly AgentSkill[],
	featureFlags: FeatureFlagSettings,
): readonly AgentSkill[] {
	return skills.filter((skill) => {
		const flag = featureFlagForSkill(skill.name);
		return flag === undefined || isFeatureEnabled(featureFlags, flag);
	});
}
