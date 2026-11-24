import { apiVersion, Platform } from "obsidian";
import defaultSystemPrompt from "../../prompts/system.md";
import { buildDateTimeContext } from "./datetime-context";
import { buildMemoryPromptBlock, MemoriesStore } from "./memories";
import { buildAvailableSkillsPrompt, SkillsService } from "./skills";
import { filterAvailableSkills } from "./skill-visibility";
import type { FeatureFlagSettings } from "../settings/feature-flags";

const DEFAULT_SYSTEM_PROMPT = defaultSystemPrompt.trim();

export interface SystemPromptInputs {
	skills: SkillsService;
	memoriesStore: MemoriesStore;
	personalPrompt: string;
	highlightrDetected: boolean;
	featureFlags: FeatureFlagSettings;
	pluginVersion?: string;
}

// Highlightr's full default palette (8 colors) versus the four base colors
// Porygon renders itself when Highlightr is absent. The emit block advertises
// only what will actually render as a colored highlight.
const FULL_HIGHLIGHT_PALETTE = "blue, red, yellow, green, pink, orange, cyan, purple, grey";
const BASE_HIGHLIGHT_PALETTE = "blue, red, yellow, green";

export function buildSystemPrompt({ skills, memoriesStore, personalPrompt, highlightrDetected, featureFlags, pluginVersion }: SystemPromptInputs): string {
	const skillsPrompt = buildAvailableSkillsPrompt(
		filterAvailableSkills(skills.getSkills(), featureFlags),
	);
	const contextPrompt = buildContextPromptBlock(pluginVersion);
	const memoryPrompt = buildMemoryPromptBlock(memoriesStore.get());
	const highlightPrompt = buildHighlightPromptBlock(highlightrDetected);
	const trimmedPersonalPrompt = personalPrompt.trim();
	return [DEFAULT_SYSTEM_PROMPT, skillsPrompt, contextPrompt, memoryPrompt, highlightPrompt, trimmedPersonalPrompt]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * Dynamic "emit" half of the highlight feature (#53). Teaches the agent to wrap
 * a genuinely critical point in a Highlightr-compatible `<mark class="hltr-*">`
 * tag. The only conditional part is the palette sentence: when Highlightr is
 * enabled we advertise its full color palette, otherwise just the four base
 * colors Porygon's CSS renders on its own.
 */
export function buildHighlightPromptBlock(highlightrDetected: boolean): string {
	const palette = highlightrDetected ? FULL_HIGHLIGHT_PALETTE : BASE_HIGHLIGHT_PALETTE;
	return `<highlights-emphasis>
To emphasize a point that is genuinely critical or important in your response,
wrap it in a highlight, exactly as Highlightr does:

    <mark class="hltr-red">the single most important takeaway</mark>

Rules:
1. Use sparingly — at most one or two highlights per response, for points that
   truly matter. Never highlight ordinary prose.
2. Grammar: place the text to emphasize between <mark class="hltr-COLOR"> and
   </mark>. COLOR is one of: ${palette}.
3. Place a highlight where it belongs in the prose; don't stack several.
4. Never highlight inside a code block or inside an x-porygon-widget tag.
</highlights-emphasis>`;
}

function buildContextPromptBlock(pluginVersion?: string): string {
	return buildDateTimeContext({
		platform: describePlatform(),
		pluginVersion,
		obsidianApiVersion: apiVersion,
	});
}

function describePlatform(): string {
	return `${detectOsLabel()} (${describeMode()})`;
}

function detectOsLabel(): string {
	// iOS reports isMacOS too, so check the mobile app flags first.
	if (Platform.isIosApp) return "iOS";
	if (Platform.isAndroidApp) return "Android";
	if (Platform.isMacOS) return "macOS";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return "unknown";
}

function describeMode(): string {
	if (Platform.isPhone) return "phone";
	if (Platform.isTablet) return "tablet";
	if (Platform.isMobileApp) return "mobile";
	if (Platform.isDesktopApp || Platform.isDesktop) return "desktop";
	return "unknown";
}
