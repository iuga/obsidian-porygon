import { Platform } from "obsidian";
import defaultSystemPrompt from "../../prompts/system.md";
import { buildMemoryPromptBlock, MemoriesStore } from "./memories";
import { buildAvailableSkillsPrompt, SkillsService } from "./skills";

const DEFAULT_SYSTEM_PROMPT = defaultSystemPrompt.trim();

export interface SystemPromptInputs {
	skills: SkillsService;
	memoriesStore: MemoriesStore;
	personalPrompt: string;
	highlightrDetected: boolean;
}

// Highlightr's full default palette (8 colors) versus the four base colors
// Porygon renders itself when Highlightr is absent. The emit block advertises
// only what will actually render as a colored highlight.
const FULL_HIGHLIGHT_PALETTE = "blue, red, yellow, green, pink, orange, cyan, purple, grey";
const BASE_HIGHLIGHT_PALETTE = "blue, red, yellow, green";

export function buildSystemPrompt({ skills, memoriesStore, personalPrompt, highlightrDetected }: SystemPromptInputs): string {
	const skillsPrompt = buildAvailableSkillsPrompt(skills.getSkills());
	const contextPrompt = buildContextPromptBlock();
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

function buildContextPromptBlock(): string {
	const now = new Date();
	const datetimeUtc = now.toISOString();
	const datetimeLocal = formatLocalDatetime(now);
	const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
	const currentOs = detectOs();
	return `<context>\n- datetime: ${datetimeLocal}\n- datetime_utc: ${datetimeUtc}\n- tz: ${timezone}\n- os: ${currentOs}\n</context>`;
}

function formatLocalDatetime(date: Date): string {
	const pad = (value: number) => value.toString().padStart(2, "0");
	const offsetMinutes = -date.getTimezoneOffset();
	const offsetSign = offsetMinutes >= 0 ? "+" : "-";
	const absOffset = Math.abs(offsetMinutes);
	const offset = `${offsetSign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

function detectOs(): string {
	if (Platform.isMacOS) return "macos";
	if (Platform.isWin) return "windows";
	if (Platform.isLinux) return "linux";
	if (Platform.isIosApp) return "ios";
	if (Platform.isAndroidApp) return "android";
	return "unknown";
}
