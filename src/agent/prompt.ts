import { Platform } from "obsidian";
import defaultSystemPrompt from "../../prompts/system.md";
import { buildMemoryPromptBlock, MemoriesStore } from "./memories";
import { buildAvailableSkillsPrompt, SkillsService } from "./skills";

const DEFAULT_SYSTEM_PROMPT = defaultSystemPrompt.trim();

export interface SystemPromptInputs {
	skills: SkillsService;
	memoriesStore: MemoriesStore;
	personalPrompt: string;
}

export function buildSystemPrompt({ skills, memoriesStore, personalPrompt }: SystemPromptInputs): string {
	const skillsPrompt = buildAvailableSkillsPrompt(skills.getSkills());
	const contextPrompt = buildContextPromptBlock();
	const memoryPrompt = buildMemoryPromptBlock(memoriesStore.get());
	const trimmedPersonalPrompt = personalPrompt.trim();
	return [DEFAULT_SYSTEM_PROMPT, skillsPrompt, contextPrompt, memoryPrompt, trimmedPersonalPrompt]
		.filter(Boolean)
		.join("\n\n");
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
