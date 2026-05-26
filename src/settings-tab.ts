import { PluginSettingTab, Setting } from "obsidian";
import PorygonPlugin from "./main";
import { RagIndexProgress } from "./rag";
import { ONBOARDING_DEFAULTS } from "./settings";

export class PorygonSettingTab extends PluginSettingTab {
	plugin: PorygonPlugin;
	private statusSetting: Setting | null = null;
	private unsubscribeProgress: (() => void) | null = null;

	constructor(plugin: PorygonPlugin) {
		super(plugin.app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderSectionHeading(containerEl, "Ollama", "Configure the local model provider used by chat and embeddings.");

		new Setting(containerEl)
			.setName("Ollama host")
			.setDesc("Host for ollama.")
			.addText((text) => text
				.setPlaceholder(ONBOARDING_DEFAULTS.ollamaHost)
				.setValue(this.plugin.settings.ollamaHost)
				.onChange(async (value) => {
					this.plugin.settings.ollamaHost = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Ollama chat model")
			.setDesc("Model used for chat responses.")
			.addText((text) => text
				.setPlaceholder(ONBOARDING_DEFAULTS.ollamaChatModel)
				.setValue(this.plugin.settings.ollamaChatModel)
				.onChange(async (value) => {
					this.plugin.settings.ollamaChatModel = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Ollama embeddings model")
			.setDesc("Model used for semantic search.")
			.addText((text) => text
				.setPlaceholder(ONBOARDING_DEFAULTS.ollamaEmbeddingModel)
				.setValue(this.plugin.settings.ollamaEmbeddingModel)
				.onChange(async (value) => {
					this.plugin.settings.ollamaEmbeddingModel = value.trim();
					await this.plugin.saveSettings();
				}));

		this.renderSectionHeading(containerEl, "Personalization", "Customize the instructions sent before each chat.");

		const personalPromptSetting = new Setting(containerEl)
			.setName("Personal prompt")
			.setDesc("Tone and response preferences sent before each chat.")
			.addTextArea((textArea) => {
				textArea
					.setValue(this.plugin.settings.personalPrompt)
					.onChange(async (value) => {
						this.plugin.settings.personalPrompt = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 14;
				textArea.inputEl.addClass("porygon-settings-prompt");
			});
		personalPromptSetting.settingEl.addClass("porygon-settings-prompt-setting");

		const memoriesSetting = new Setting(containerEl)
			.setName("Memories")
			.setDesc("Long-term memories the assistant has saved about you. Sorted by importance and recency. Edit or remove lines to curate what the assistant remembers.")
			.addTextArea((textArea) => {
				textArea
					.setValue(this.plugin.settings.memories)
					.onChange(async (value) => {
						this.plugin.settings.memories = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 10;
				textArea.inputEl.addClass("porygon-settings-prompt");
			});
		memoriesSetting.settingEl.addClass("porygon-settings-prompt-setting");

		this.renderSectionHeading(containerEl, "Chat", "Control chat behavior and how agent activity appears.");

		new Setting(containerEl)
			.setName("Model thinking")
			.setDesc("Reasoning stream for supported ollama models.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.ollamaThinking)
				.onChange(async (value) => {
					this.plugin.settings.ollamaThinking = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Tool usage reporting")
			.setDesc("Show tool calls and their intent in chat history.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showToolUsage)
				.onChange(async (value) => {
					this.plugin.settings.showToolUsage = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Yolo mode")
			.setDesc("Auto-approve destructive actions (create folder, create/edit notes, rename/move) without asking. Leave off to be prompted before each change.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.yolo)
				.onChange(async (value) => {
					this.plugin.settings.yolo = value;
					await this.plugin.saveSettings();
				}));

		this.renderSectionHeading(containerEl, "Semantic search", "Configure local semantic indexing.");
		this.statusSetting = new Setting(containerEl).setName("Index status");
		this.subscribeToIndexProgress();

		const ignoredPathsSetting = new Setting(containerEl)
			.setName("Ignored semantic index paths")
			.setDesc("Vault-relative files or folders to exclude from the semantic index. Use one path or glob-like pattern per line.")
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder("Archive/\nPrivate/*.md")
					.setValue(this.plugin.settings.ragIgnoredPaths)
					.onChange(async (value) => {
						this.plugin.settings.ragIgnoredPaths = value;
						await this.plugin.saveSettings();
					});
				textArea.inputEl.rows = 5;
				textArea.inputEl.addClass("porygon-settings-ignored-paths");
			});
		ignoredPathsSetting.settingEl.addClass("porygon-settings-textarea-setting");
	}

	hide(): void {
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = null;
		this.statusSetting = null;
	}

	private subscribeToIndexProgress(): void {
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = this.plugin.ragIndexer.onProgress((progress) => {
			this.statusSetting?.setDesc(this.getSemanticIndexStatusText(progress));
		});
	}

	private getSemanticIndexStatusText(progress: RagIndexProgress): string {
		if (!this.plugin.settings.ollamaEmbeddingModel) {
			return "Status: Disabled • Indexed notes: 0 • Queued notes: 0";
		}

		if (progress.status === "error") {
			return `Status: Error • Indexed notes: ${progress.indexedFiles} • Queued notes: ${progress.queuedFiles} • Last error: ${progress.lastError ?? "unknown error"}`;
		}

		const status = progress.status === "indexing" ? "Indexing" : "Ready";
		const lastIndexed = progress.lastIndexedAt ? ` • Last indexed: ${new Date(progress.lastIndexedAt).toLocaleString()}` : "";
		return `Status: ${status} • Indexed notes: ${progress.indexedFiles} • Queued notes: ${progress.queuedFiles}${lastIndexed}`;
	}

	private renderSectionHeading(containerEl: HTMLElement, name: string, description: string): void {
		const heading = new Setting(containerEl)
			.setName(name)
			.setDesc(description)
			.setHeading();
		heading.settingEl.addClass("porygon-settings-section");
	}
}
