import { debounce, PluginSettingTab, Setting } from "obsidian";
import PorygonPlugin from "../main";
import { OllamaHttpClient } from "../agent/ollama-client";
import { RagIndexProgress } from "../rag";
import { ONBOARDING_DEFAULTS } from "./settings";

type ModelSettingKey = "ollamaChatModel" | "ollamaEmbeddingModel";

export class PorygonSettingTab extends PluginSettingTab {
	plugin: PorygonPlugin;
	private statusSetting: Setting | null = null;
	private unsubscribeProgress: (() => void) | null = null;
	private models: string[] = [];
	private modelsHost: string | null = null;
	private modelsStatus: "loading" | "ok" | "error" = "loading";
	private readonly persist = debounce(() => {
		void this.plugin.saveSettings();
	}, 400, true);

	constructor(plugin: PorygonPlugin) {
		super(plugin.app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		this.refresh();
	}

	private refresh(): void {
		this.containerEl.empty();
		this.renderSections();
		const host = this.getHost();
		if (this.modelsHost !== host) {
			void this.loadModels(host);
		}
	}

	hide(): void {
		this.persist.run();
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = null;
		this.statusSetting = null;
	}

	private renderSections(): void {
		const { containerEl } = this;

		this.renderSectionHeading(containerEl, "Ollama", "Configure the local model provider used by chat and embeddings.");

		new Setting(containerEl)
			.setName("Ollama host")
			.setDesc(this.getHostStatusDesc())
			.addText((text) => text
				.setPlaceholder(ONBOARDING_DEFAULTS.ollamaHost)
				.setValue(this.plugin.settings.ollamaHost)
				.onChange((value) => {
					this.plugin.settings.ollamaHost = value.trim();
					this.persist();
				}))
			.addExtraButton((btn) => btn
				.setIcon("refresh-cw")
				.setTooltip("Reload model list")
				.onClick(() => {
					this.modelsHost = null;
					this.refresh();
				}));

		this.renderModelDropdown("ollamaChatModel", "Ollama chat model", "Model used for chat responses.");
		this.renderModelDropdown("ollamaEmbeddingModel", "Ollama embeddings model", "Model used for semantic search.");

		this.renderSectionHeading(containerEl, "Personalization", "Customize the instructions sent before each chat.");

		const personalPromptSetting = new Setting(containerEl)
			.setName("Personal prompt")
			.setDesc("Tone and response preferences sent before each chat.")
			.addTextArea((textArea) => {
				textArea
					.setValue(this.plugin.settings.personalPrompt)
					.onChange((value) => {
						this.plugin.settings.personalPrompt = value;
						this.persist();
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
						this.persist();
					});
				textArea.inputEl.rows = 10;
				textArea.inputEl.addClass("porygon-settings-prompt");
				textArea.inputEl.addEventListener("blur", () => {
					this.persist.run();
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
						this.persist();
					});
				textArea.inputEl.rows = 5;
				textArea.inputEl.addClass("porygon-settings-ignored-paths");
			});
		ignoredPathsSetting.settingEl.addClass("porygon-settings-textarea-setting");
	}

	private renderModelDropdown(key: ModelSettingKey, name: string, desc: string): void {
		const current = this.plugin.settings[key];
		const installed = current ? this.models.includes(current) : false;
		const hasAny = this.models.length > 0 || !!current;

		const setting = new Setting(this.containerEl).setName(name).setDesc(desc);
		setting.addDropdown((dd) => {
			if (!hasAny) {
				dd.addOption("", "No models available");
				dd.selectEl.disabled = true;
				return;
			}
			if (current && !installed) {
				dd.addOption(current, `${current} (not installed)`);
			}
			this.models.forEach((m) => { dd.addOption(m, m); });
			dd.setValue(current || this.pickDefault(key));
			dd.onChange((value) => {
				this.plugin.settings[key] = value;
				this.persist();
			});
		});
	}

	private async loadModels(host: string): Promise<void> {
		this.modelsHost = host;
		this.modelsStatus = "loading";
		let models: string[] = [];
		let ok = false;
		try {
			const client = new OllamaHttpClient(host);
			await client.version();
			models = (await client.list()).models.map((m) => m.name);
			ok = true;
		} catch {
			ok = false;
		}
		// Skip stale responses if the host changed while we were fetching.
		if (this.modelsHost !== host) {
			return;
		}
		this.models = models;
		this.modelsStatus = ok ? "ok" : "error";
		this.refresh();
	}

	private getHost(): string {
		return this.plugin.settings.ollamaHost || ONBOARDING_DEFAULTS.ollamaHost;
	}

	private getHostStatusDesc(): string {
		switch (this.modelsStatus) {
			case "loading":
				return "Connecting to Ollama...";
			case "ok":
				return `Connected • ${this.models.length} model${this.models.length === 1 ? "" : "s"} available.`;
			case "error":
				return `Unreachable at ${this.getHost()}. Check that Ollama is running, then reload.`;
		}
	}

	private pickDefault(key: ModelSettingKey): string {
		const fallback = key === "ollamaChatModel" ? ONBOARDING_DEFAULTS.ollamaChatModel : ONBOARDING_DEFAULTS.ollamaEmbeddingModel;
		const latest = `${fallback}:latest`;
		if (this.models.includes(latest)) return latest;
		if (this.models.includes(fallback)) return fallback;
		return this.models[0] ?? "";
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
