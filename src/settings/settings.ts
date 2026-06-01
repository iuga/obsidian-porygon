import defaultPersonalPrompt from "../../prompts/personal.md";
import { DEFAULT_MEMORIES } from "../agent/memories";

export type ExperiencePreset = "" | "minimal" | "balanced" | "verbose" | "yolo";

export type ThinkingEffort = "off" | "low" | "medium" | "high";

export interface PorygonPluginSettings {
	ollamaHost: string;
	ollamaChatModel: string;
	ollamaEmbeddingModel: string;
	thinkingEffort: ThinkingEffort;
	showThinking: boolean;
	showToolUsage: boolean;
	yolo: boolean;
	experience: ExperiencePreset;
	ragIgnoredPaths: string;
	personalPrompt: string;
	memories: string;
}

export const DEFAULT_PERSONAL_PROMPT = defaultPersonalPrompt.trim();

export const DEFAULT_SETTINGS: PorygonPluginSettings = {
	ollamaHost: "",
	ollamaChatModel: "",
	ollamaEmbeddingModel: "",
	thinkingEffort: "medium",
	showThinking: false,
	showToolUsage: false,
	yolo: false,
	experience: "",
	ragIgnoredPaths: "",
	personalPrompt: DEFAULT_PERSONAL_PROMPT,
	memories: DEFAULT_MEMORIES,
};

export const ONBOARDING_DEFAULTS: PorygonPluginSettings = {
	ollamaHost: "http://localhost:11434",
	ollamaChatModel: "gemma4",
	ollamaEmbeddingModel: "qwen3-embedding",
	thinkingEffort: "medium",
	showThinking: true,
	showToolUsage: false,
	yolo: false,
	experience: "verbose",
	ragIgnoredPaths: "",
	personalPrompt: DEFAULT_PERSONAL_PROMPT,
	memories: DEFAULT_MEMORIES,
};

export interface ExperiencePresetConfig {
	value: Exclude<ExperiencePreset, "">;
	label: string;
	description: string;
	showThinking: boolean;
	showToolUsage: boolean;
	yolo: boolean;
}

export const EXPERIENCE_PRESETS: ExperiencePresetConfig[] = [
	{
		value: "minimal",
		label: "Minimal — just the answer",
		description: "Clean replies only. No reasoning, no tool activity.",
		showThinking: false,
		showToolUsage: false,
		yolo: false,
	},
	{
		value: "balanced",
		label: "Balanced — show tool activity",
		description: "See what Porygon does in your vault, without the inner monologue.",
		showThinking: false,
		showToolUsage: true,
		yolo: false,
	},
	{
		value: "verbose",
		label: "Verbose — show thinking and tools (recommended)",
		description: "Full transparency: reasoning stream and every tool call.",
		showThinking: true,
		showToolUsage: true,
		yolo: false,
	},
	{
		value: "yolo",
		label: "YOLO — auto-approve everything",
		description: "Skip approvals for vault changes. No reasoning, no tool reporting.",
		showThinking: false,
		showToolUsage: false,
		yolo: true,
	},
];
