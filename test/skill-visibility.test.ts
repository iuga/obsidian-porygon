import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { filterAvailableSkills } from "../src/agent/skill-visibility";
import { featureFlagDefaults } from "../src/settings/feature-flags";
import type { AgentSkill } from "../src/agent/skills";

function skill(name: string): AgentSkill {
	return { name, description: `${name} description`, location: `porygon/skills/${name}.md` };
}

const SKILLS: AgentSkill[] = [skill("diagrammer"), skill("explainer"), skill("summarizer")];
const DIAGRAMS_ON = { ...featureFlagDefaults(), mermaidDiagrams: true };
const DIAGRAMS_OFF = featureFlagDefaults();

void describe("filterAvailableSkills", () => {
	void test("hides the diagrammer by default", () => {
		const names = filterAvailableSkills(SKILLS, DIAGRAMS_OFF).map((entry) => entry.name);
		assert.deepEqual(names, ["explainer", "summarizer"]);
	});

	void test("reveals the diagrammer when its flag is on", () => {
		assert.deepEqual(filterAvailableSkills(SKILLS, DIAGRAMS_ON), SKILLS);
	});

	void test("matches the skill name exactly", () => {
		const withLookalike = [...SKILLS, skill("diagrammer-notes")];
		const names = filterAvailableSkills(withLookalike, DIAGRAMS_OFF).map((entry) => entry.name);
		assert.deepEqual(names, ["explainer", "summarizer", "diagrammer-notes"]);
	});

	void test("returns an empty list unchanged", () => {
		assert.deepEqual(filterAvailableSkills([], DIAGRAMS_OFF), []);
	});
});
