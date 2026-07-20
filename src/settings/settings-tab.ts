import { debounce, Notice, PluginSettingTab, Setting } from "obsidian";
import PorygonPlugin from "../main";
import { getActiveProvider } from "../providers";
import { RagIndexProgress } from "../rag";
import { movePorygonFolder, DEFAULT_PORYGON_FOLDER, ONBOARDING_DEFAULTS } from "./settings";
import type { ThinkingEffort } from "./settings";

type ModelSettingKey = "ollamaChatModel" | "ollamaEmbeddingModel";

export class PorygonSettingTab extends PluginSettingTab {
	plugin: PorygonPlugin;
	private statusSetting: Setting | null = null;
	private unsubscribeProgress: (() => void) | null = null;
	private models: string[] = [];
	private modelCapabilities: Record<string, string[]> = {};
	private modelsHost: string | null = null;
	private modelsStatus: "loading" | "ok" | "error" = "loading";
	// Draft for the Porygon folder input. Only the Apply button commits it;
	// kept on the instance so re-renders (e.g. model list loading) don't
	// clobber what the user typed.
	private porygonFolderDraft: string | null = null;
	private isMovingPorygonFolder = false;
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
		this.porygonFolderDraft = null;
	}

	private renderSections(): void {
		const { containerEl } = this;

		this.renderSectionHeading(containerEl, "Model Provider", "Configure the model provider used by chat and embeddings.");

		const providerGroup = containerEl.createDiv({ cls: "setting-group" });
		const providerItems = providerGroup.createDiv({ cls: "setting-items" });

		new Setting(providerItems)
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

		this.renderModelDropdown(providerItems, "ollamaChatModel", "Chat model", "Model used for chat responses.", "completion");
		this.renderThinkingEffort(providerItems);
		this.renderModelDropdown(providerItems, "ollamaEmbeddingModel", "Embeddings model", "Model used for semantic search.", "embedding");

		this.renderSectionHeading(containerEl, "Chat Experience", "Control chat behavior and how agent activity appears.");

		const chatGroup = containerEl.createDiv({ cls: "setting-group" });
		const chatItems = chatGroup.createDiv({ cls: "setting-items" });

		new Setting(chatItems)
			.setName("Show thinking")
			.setDesc("Display the reasoning stream in chat. Thinking effort still applies when hidden.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showThinking)
				.onChange(async (value) => {
					this.plugin.settings.showThinking = value;
					await this.plugin.saveSettings();
				}));

		new Setting(chatItems)
			.setName("Tool usage reporting")
			.setDesc("Show tool calls and their intent in chat history.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showToolUsage)
				.onChange(async (value) => {
					this.plugin.settings.showToolUsage = value;
					await this.plugin.saveSettings();
				}));

		new Setting(chatItems)
			.setName("Token usage stats")
			.setDesc("Show context window usage (percentage and token counts) next to the send button.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.showTokenStats)
				.onChange(async (value) => {
					this.plugin.settings.showTokenStats = value;
					await this.plugin.saveSettings();
				}));

		new Setting(chatItems)
			.setName("Yolo mode")
			.setDesc("Auto-approve destructive actions (create folder, create/edit notes, rename/move) without asking. Leave off to be prompted before each change.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.yolo)
				.onChange(async (value) => {
					this.plugin.settings.yolo = value;
					await this.plugin.saveSettings();
				}));

		this.renderSectionHeading(containerEl, "Personalization", "Customize the instructions sent before each chat.");

		const personalizationGroup = containerEl.createDiv({ cls: "setting-group" });
		const personalizationItems = personalizationGroup.createDiv({ cls: "setting-items" });

		const personalPromptSetting = new Setting(personalizationItems)
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

		const memoriesSetting = new Setting(personalizationItems)
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

		this.renderSectionHeading(containerEl, "Semantic search", "Configure local semantic indexing.");

		const semanticGroup = containerEl.createDiv({ cls: "setting-group" });
		const semanticItems = semanticGroup.createDiv({ cls: "setting-items" });

		this.statusSetting = new Setting(semanticItems)
			.setName("Index status")
			.addExtraButton((btn) => btn
				.setIcon("refresh-cw")
				.setTooltip("Reprocess index")
				.onClick(() => {
					void this.plugin.ragIndexer.reconcile();
				}));
		this.subscribeToIndexProgress();

		const ignoredPathsSetting = new Setting(semanticItems)
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

		this.renderSectionHeading(containerEl, "Advanced", "Advanced behavior. Most users won't need to change these.");

		const advancedGroup = containerEl.createDiv({ cls: "setting-group" });
		const advancedItems = advancedGroup.createDiv({ cls: "setting-items" });
		this.renderPorygonFolderSetting(advancedItems);
	}

	private renderPorygonFolderSetting(containerEl: HTMLElement): void {
		let inputEl: HTMLInputElement | null = null;
		let buttonEl: HTMLButtonElement | null = null;

		const syncDisabled = () => {
			const busy = this.isMovingPorygonFolder;
			if (inputEl) inputEl.disabled = busy;
			if (buttonEl) {
				buttonEl.disabled = busy;
				buttonEl.setText(busy ? "Moving..." : "Apply");
			}
		};

		new Setting(containerEl)
			.setName("Porygon folder")
			.setDesc("Vault folder where the assistant stores its internal notes (sessions, skills). Applying moves the current folder and its contents to the new location.")
			.addText((text) => {
				text
					.setPlaceholder(DEFAULT_PORYGON_FOLDER)
					.setValue(this.porygonFolderDraft ?? this.plugin.settings.porygonFolder)
					.onChange((value) => {
						this.porygonFolderDraft = value;
					});
				inputEl = text.inputEl;
			})
			.addButton((button) => {
				button
					.setButtonText("Apply")
					.setCta()
					.onClick(() => { void applyMove(); });
				buttonEl = button.buttonEl;
			});

		syncDisabled();

		const applyMove = async () => {
			if (this.isMovingPorygonFolder) {
				return;
			}

			const requested = this.porygonFolderDraft ?? this.plugin.settings.porygonFolder;
			this.isMovingPorygonFolder = true;
			syncDisabled();
			try {
				const result = await movePorygonFolder(this.plugin, requested);
				this.porygonFolderDraft = null;
				if (result === "unchanged") {
					new Notice("Porygon folder is already set to that path.");
				} else if (result === "adopted") {
					new Notice(`Porygon folder set to "${this.plugin.settings.porygonFolder}".`);
				} else {
					new Notice(`Porygon folder moved to "${this.plugin.settings.porygonFolder}".`);
				}
			} catch (error) {
				new Notice(`Couldn't move the Porygon folder: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				this.isMovingPorygonFolder = false;
				syncDisabled();
				this.refresh();
			}
		};
	}

	private renderModelDropdown(containerEl: HTMLElement, key: ModelSettingKey, name: string, desc: string, capability: string): void {
		const current = this.plugin.settings[key];
		const available = this.models.filter((m) => this.modelCapabilities[m]?.includes(capability));
		const installed = current ? available.includes(current) : false;
		const hasAny = available.length > 0 || !!current;

		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		setting.addDropdown((dd) => {
			if (!hasAny) {
				dd.addOption("", "No models available");
				dd.selectEl.disabled = true;
				return;
			}
			if (current && !installed) {
				dd.addOption(current, `${current} (not installed)`);
			}
			available.forEach((m) => { dd.addOption(m, m); });
			dd.setValue(current || this.pickDefault(key, available));
			dd.onChange((value) => {
				this.plugin.settings[key] = value;
				this.persist();
				if (key === "ollamaChatModel") {
					this.refresh();
				}
			});
		});

		if (key === "ollamaChatModel") {
			this.renderCapabilityTags(setting, current);
		}
	}

	private renderThinkingEffort(containerEl: HTMLElement): void {
		const model = this.plugin.settings.ollamaChatModel;
		const canThink = model ? (this.modelCapabilities[model]?.includes("thinking") ?? false) : false;

		// Capabilities load asynchronously. While they're unknown, leave the
		// stored effort untouched and skip the control so we never clobber the
		// user's choice based on a transient empty capability map.
		if (this.modelsStatus !== "ok") {
			return;
		}

		// A non-thinking model can't reason; pin the effort off so the chat
		// call never forwards a graded value the model would ignore.
		if (!canThink) {
			if (this.plugin.settings.thinkingEffort !== "off") {
				this.plugin.settings.thinkingEffort = "off";
				this.persist();
			}
			return;
		}

		const effort = new Setting(containerEl)
			.setName("Thinking effort")
			.setDesc("How much the model reasons before answering.")
			.addDropdown((dd) => {
				dd.addOption("off", "Off");
				dd.addOption("low", "Low");
				dd.addOption("medium", "Medium");
				dd.addOption("high", "High");
				dd.setValue(this.plugin.settings.thinkingEffort);
				dd.onChange((value) => {
					this.plugin.settings.thinkingEffort = value as ThinkingEffort;
					this.persist();
				});
			});
		effort.setClass("porygon-settings-child");
	}

	private renderCapabilityTags(setting: Setting, model: string): void {
		const capabilities = model ? this.modelCapabilities[model] ?? [] : [];
		if (capabilities.length === 0) {
			return;
		}

		const tagsEl = setting.descEl.createDiv({ cls: "porygon-settings-capability-tags" });
		capabilities.forEach((capability) => {
			tagsEl.createSpan({ cls: "porygon-settings-capability-tag", text: capability });
		});
	}

	private async loadModels(host: string): Promise<void> {
		this.modelsHost = host;
		this.modelsStatus = "loading";
		let models: string[] = [];
		let capabilities: Record<string, string[]> = {};
		let ok = false;
		try {
			const settings = { ...this.plugin.settings, ollamaHost: host };
			const provider = getActiveProvider(settings);
			if (await provider.checkHealth(settings)) {
				models = (await provider.listModels(settings)) ?? [];
				const infos = await Promise.all(models.map((model) => provider.showModel(settings, model)));
				capabilities = Object.fromEntries(
					infos.flatMap((info) => (info ? [[info.model, info.capabilities]] : [])),
				);
				ok = true;
			}
		} catch {
			ok = false;
		}
		// Skip stale responses if the host changed while we were fetching.
		if (this.modelsHost !== host) {
			return;
		}
		this.models = models;
		this.modelCapabilities = capabilities;
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

	private pickDefault(key: ModelSettingKey, available: string[]): string {
		const fallback = key === "ollamaChatModel" ? ONBOARDING_DEFAULTS.ollamaChatModel : ONBOARDING_DEFAULTS.ollamaEmbeddingModel;
		const latest = `${fallback}:latest`;
		if (available.includes(latest)) return latest;
		if (available.includes(fallback)) return fallback;
		return available[0] ?? "";
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
