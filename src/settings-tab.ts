import { debounce, DropdownComponent, PluginSettingTab, Setting } from "obsidian";
import PorygonPlugin from "./main";
import { OllamaHttpClient, OllamaModel } from "./ollama-client";
import { RagIndexProgress } from "./rag";
import { ONBOARDING_DEFAULTS } from "./settings";

type ModelSettingKey = "ollamaChatModel" | "ollamaEmbeddingModel";

export class PorygonSettingTab extends PluginSettingTab {
	plugin: PorygonPlugin;
	private statusSetting: Setting | null = null;
	private unsubscribeProgress: (() => void) | null = null;
	private chatModelSetting: Setting | null = null;
	private embeddingModelSetting: Setting | null = null;
	private models: OllamaModel[] = [];
	private modelsError: string | null = null;
	private modelsLoading = false;
	private readonly persistSettings = debounce(() => {
		void this.plugin.saveSettings();
	}, 400, true);
	private readonly refreshModels = debounce(() => {
		void this.loadModels();
	}, 400, true);

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
				.onChange((value) => {
					this.plugin.settings.ollamaHost = value.trim();
					this.persistSettings();
					this.refreshModels();
				}));

		this.chatModelSetting = new Setting(containerEl)
			.setName("Ollama chat model")
			.setDesc("Model used for chat responses.");
		this.embeddingModelSetting = new Setting(containerEl)
			.setName("Ollama embeddings model")
			.setDesc("Model used for semantic search.");
		this.renderModelDropdown("ollamaChatModel", this.chatModelSetting);
		this.renderModelDropdown("ollamaEmbeddingModel", this.embeddingModelSetting);
		void this.loadModels();

		this.renderSectionHeading(containerEl, "Personalization", "Customize the instructions sent before each chat.");

		const personalPromptSetting = new Setting(containerEl)
			.setName("Personal prompt")
			.setDesc("Tone and response preferences sent before each chat.")
			.addTextArea((textArea) => {
				textArea
					.setValue(this.plugin.settings.personalPrompt)
					.onChange((value) => {
						this.plugin.settings.personalPrompt = value;
						this.persistSettings();
					});
				textArea.inputEl.rows = 14;
				textArea.inputEl.addClass("porygon-settings-prompt");
			});
		personalPromptSetting.settingEl.addClass("porygon-settings-prompt-setting");

		const memoriesSetting = new Setting(containerEl)
			.setName("Memories")
			.setDesc("Long-term memories the assistant has saved about you. Sorted by importance and recency. Edit or remove lines to curate what the assistant remembers; lines that don't match the format are discarded on save.")
			.addTextArea((textArea) => {
				textArea
					.setValue(this.plugin.settings.memories)
					.onChange((value) => {
						this.plugin.settings.memories = value;
						this.persistSettings();
					});
				textArea.inputEl.rows = 10;
				textArea.inputEl.addClass("porygon-settings-prompt");
				textArea.inputEl.addEventListener("blur", () => {
					this.persistSettings.run();
					textArea.setValue(this.plugin.settings.memories);
				});
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
					.onChange((value) => {
						this.plugin.settings.ragIgnoredPaths = value;
						this.persistSettings();
					});
				textArea.inputEl.rows = 5;
				textArea.inputEl.addClass("porygon-settings-ignored-paths");
			});
		ignoredPathsSetting.settingEl.addClass("porygon-settings-textarea-setting");
	}

	hide(): void {
		this.persistSettings.run();
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = null;
		this.statusSetting = null;
		this.chatModelSetting = null;
		this.embeddingModelSetting = null;
	}

	private async loadModels(): Promise<void> {
		this.modelsLoading = true;
		this.modelsError = null;
		this.refreshModelDropdowns();
		try {
			const host = this.plugin.settings.ollamaHost || ONBOARDING_DEFAULTS.ollamaHost;
			const client = new OllamaHttpClient(host);
			await client.version();
			const response = await client.list();
			this.models = response.models;
		} catch (error) {
			this.models = [];
			this.modelsError = error instanceof Error ? error.message : "Unable to reach Ollama.";
		} finally {
			this.modelsLoading = false;
			this.refreshModelDropdowns();
		}
	}

	private refreshModelDropdowns(): void {
		if (this.chatModelSetting) {
			this.renderModelDropdown("ollamaChatModel", this.chatModelSetting);
		}
		if (this.embeddingModelSetting) {
			this.renderModelDropdown("ollamaEmbeddingModel", this.embeddingModelSetting);
		}
	}

	private renderModelDropdown(settingKey: ModelSettingKey, setting: Setting): void {
		setting.controlEl.empty();
		const desc = settingKey === "ollamaChatModel" ? "Model used for chat responses." : "Model used for semantic search.";
		if (this.modelsLoading) {
			setting.setDesc(`${desc} Loading models...`);
		} else if (this.modelsError) {
			setting.setDesc(`${desc} Unable to reach Ollama at ${this.plugin.settings.ollamaHost || ONBOARDING_DEFAULTS.ollamaHost}.`);
		} else if (this.models.length === 0) {
			setting.setDesc(`${desc} No models installed. Run e.g. "ollama pull gemma3".`);
		} else {
			setting.setDesc(desc);
		}

		setting.addDropdown((dropdown: DropdownComponent) => {
			const modelNames = this.models.map((model) => model.name);
			const current = this.plugin.settings[settingKey];
			if (modelNames.length === 0) {
				dropdown.addOption("", current || "No models available");
				dropdown.setValue("");
				dropdown.selectEl.disabled = true;
				return;
			}

			const optionValues = current && !modelNames.includes(current) ? [current, ...modelNames] : modelNames;
			optionValues.forEach((name) => dropdown.addOption(name, name));
			dropdown.setValue(this.pickModelValue(settingKey, modelNames));
			dropdown.onChange((value) => {
				this.plugin.settings[settingKey] = value;
				this.persistSettings();
			});
		});
	}

	private pickModelValue(settingKey: ModelSettingKey, modelNames: string[]): string {
		const current = this.plugin.settings[settingKey];
		if (current) {
			return current;
		}
		const defaultValue = settingKey === "ollamaChatModel" ? ONBOARDING_DEFAULTS.ollamaChatModel : ONBOARDING_DEFAULTS.ollamaEmbeddingModel;
		const latestValue = `${defaultValue}:latest`;
		if (modelNames.includes(latestValue)) {
			return latestValue;
		}
		if (modelNames.includes(defaultValue)) {
			return defaultValue;
		}
		return modelNames[0] ?? "";
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
