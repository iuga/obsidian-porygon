import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SkillsService } from "../skills";
import { intentSchema } from "./shared";

export function createLoadSkillTool(skills: SkillsService) {
	return tool(
		async ({ location }: { location: string }): Promise<string> => {
			console.debug("[Porygon Skills] loading skill", { location });
			return skills.loadSkillContent(location);
		},
		{
			name: "load_skill",
			description: "Load a skill. IMPORTANT: Pass the EXACT value from the <location> field of the matching <skill> in <available_skills> (a full vault path such as 'porygon/skills/summarizer.md'). Do not shorten, rename, or guess. Returns the skill body without YAML frontmatter or an error message if not found.",
			schema: z.object({
				intent: intentSchema,
				location: z.string().describe("EXACT value from <location> in <available_skills> (full vault path, e.g. 'porygon/skills/summarizer.md')."),
			}),
		}
	);
}
