import { App, normalizePath, TFile, TFolder } from "obsidian";
import defaultPersonalPrompt from "../../prompts/personal.md";
import { DEFAULT_MEMORIES } from "../agent/memories";
import { ensureFolderExists } from "../utils/vault";

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
	porygonFolder: string;
}

export const DEFAULT_PERSONAL_PROMPT = defaultPersonalPrompt.trim();

export const DEFAULT_PORYGON_FOLDER = "porygon";

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
	porygonFolder: DEFAULT_PORYGON_FOLDER,
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
	porygonFolder: DEFAULT_PORYGON_FOLDER,
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

// Structural host so the folder move stays decoupled from the plugin class
// (and trivially testable). `PorygonPlugin` satisfies it as-is.
export interface PorygonFolderHost {
	app: App;
	settings: PorygonPluginSettings;
	skills: { refresh(): Promise<void> };
	saveSettings(): Promise<void>;
}

export type PorygonFolderMoveResult = "moved" | "adopted" | "unchanged";

/**
 * Normalizes and validates a candidate Porygon folder path. Throws an Error
 * with a user-facing message when the path is unusable.
 */
export function validatePorygonFolderPath(raw: string): string {
	const normalized = normalizePath(raw.trim());
	if (!normalized || normalized === "/") {
		throw new Error("Folder path can't be empty.");
	}

	const segments = normalized.split("/");
	if (segments.some((segment) => segment.startsWith("."))) {
		throw new Error("Folder path can't contain hidden or relative segments (starting with a dot).");
	}

	return normalized;
}

/**
 * Points the plugin at a new internal folder, moving the existing folder and
 * all of its contents to the new location.
 *
 * Guarantees:
 * - If the destination is a note, or a folder that already exists and is not
 *   empty, nothing is touched and the previous folder stays active.
 * - The in-memory setting flips *before* the vault rename so the per-file
 *   rename events the move fires already see the new root: the RAG indexer
 *   keeps treating the notes as internal (never embeds them) and the skills
 *   watcher recognizes the new paths. On rename failure the setting is
 *   rolled back.
 */
export async function movePorygonFolder(host: PorygonFolderHost, rawNewPath: string): Promise<PorygonFolderMoveResult> {
	const newPath = validatePorygonFolderPath(rawNewPath);
	const oldPath = normalizePath(host.settings.porygonFolder);

	if (newPath === oldPath) {
		return "unchanged";
	}

	if (newPath.startsWith(`${oldPath}/`)) {
		throw new Error("The new folder can't be inside the current Porygon folder.");
	}

	const destination = host.app.vault.getAbstractFileByPath(newPath);
	if (destination instanceof TFile) {
		throw new Error(`A note already exists at "${newPath}".`);
	}

	if (destination instanceof TFolder && destination.children.length > 0) {
		throw new Error(`The folder "${newPath}" already exists and is not empty. Keeping "${oldPath}".`);
	}

	const source = host.app.vault.getAbstractFileByPath(oldPath);

	// Fresh vault (or folder never created yet): nothing to move, just adopt
	// the new location. Sessions and skills folders are created lazily.
	if (!(source instanceof TFolder)) {
		host.settings.porygonFolder = newPath;
		await host.saveSettings();
		await host.skills.refresh();
		return "adopted";
	}

	// renameFile refuses to overwrite, so clear the empty destination first.
	// trashFile (not vault.delete): respects the user's deletion preference,
	// and still works when the vault-empty folder holds hidden files (e.g.
	// .DS_Store) that vault.delete would refuse to remove.
	if (destination instanceof TFolder) {
		await host.app.fileManager.trashFile(destination);
	}

	const parentPath = newPath.split("/").slice(0, -1).join("/");
	if (parentPath) {
		await ensureFolderExists(host.app, parentPath);
	}

	host.settings.porygonFolder = newPath;
	try {
		await host.app.fileManager.renameFile(source, newPath);
	} catch (error) {
		host.settings.porygonFolder = oldPath;
		throw error;
	}

	// Persist + rebuild dependents (drops the cached agent so the next send
	// is built against the new folder) and re-discover skills at the new root.
	await host.saveSettings();
	await host.skills.refresh();
	return "moved";
}
