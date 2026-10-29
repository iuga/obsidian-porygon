import { debounce, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionItem } from "obsidian";
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
	// Per-model in-place refresher registered by the 1.13+ getSettingDefinitions()
	// render() path. Used to rebuild a model row when the async model list
	// arrives, since the declarative tab can't be re-rendered without the
	// 1.13-only SettingTab.update().
	private modelRowRefreshers: Partial<Record<ModelSettingKey, () => void>> = {};
	// In-place refresher for the "Thinking effort" row, registered by the 1.13+
	// render() path. The chat model's capabilities gate this control, so it is
	// rebuilt alongside the chat model row when the model or model list changes.
	private thinkingEffortRefresher: (() => void) | null = null;
	// True once the 1.13+ getSettingDefinitions() render path has run, so the
	// async model-list refresh rebuilds the rows in place instead of using the
	// legacy imperative refresh().
	private declarativeUi = false;
	// Set when the settings modal closes; suppresses an in-flight model-list
	// refresh from re-rendering a tab the user has already left.
	private hidden = false;
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

	// Declarative mirror of the settings rendered in display(). Obsidian 1.13+
	// uses this to surface individual settings in the global settings search.
	// The interactive UI still lives in display(); these definitions only feed
	// search indexing and the built-in control binding.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Model Provider",
				items: [
					{
						name: "Ollama host",
						desc: "Host used by chat and embeddings.",
						control: { key: "ollamaHost", type: "text", placeholder: ONBOARDING_DEFAULTS.ollamaHost },
					},
					{
						name: "Chat model",
						desc: "Model used for chat responses.",
						aliases: ["chat model", "model"],
						// On 1.13+ the whole tab renders from getSettingDefinitions(),
						// so the picker is a render() hook (not a static control): the
						// available models are fetched live from the Ollama host.
						render: (setting) => {
							this.declarativeUi = true;
							this.renderModelRow(setting, "ollamaChatModel", "completion");
						},
					} satisfies SettingDefinition,
					{
						name: "Thinking effort",
						desc: "How much the model reasons before answering.",
						aliases: ["reasoning"],
						// The chat model's capabilities gate this control (a non-thinking
						// model forces it off), and that pin logic is imperative, so the
						// row can't be a static control: on 1.13+ it is a render() hook
						// that rebuilds the row in place.
						render: (setting) => {
							this.declarativeUi = true;
							this.renderThinkingEffortRow(setting);
						},
					} satisfies SettingDefinition,
					{
						name: "Embeddings model",
						desc: "Model used for semantic search.",
						aliases: ["embedding", "embeddings"],
						render: (setting) => {
							this.declarativeUi = true;
							this.renderModelRow(setting, "ollamaEmbeddingModel", "embedding");
						},
					} satisfies SettingDefinition,
				],
			},
			{
				type: "group",
				heading: "Chat Experience",
				items: [
					{
						name: "Show thinking",
						desc: "Display the reasoning stream in chat. Thinking effort still applies when hidden.",
						control: { key: "showThinking", type: "toggle" },
					},
					{
						name: "Tool usage reporting",
						desc: "Show tool calls and their intent in chat history.",
						control: { key: "showToolUsage", type: "toggle" },
					},
					{
						name: "Token usage stats",
						desc: "Show context window usage (percentage and token counts) next to the send button.",
						control: { key: "showTokenStats", type: "toggle" },
					},
					{
						name: "Yolo mode",
						desc: "Auto-approve destructive actions (create folder, create/edit notes, rename/move) without asking. Leave off to be prompted before each change.",
						control: { key: "yolo", type: "toggle" },
					},
				],
			},
			{
				type: "group",
				heading: "Personalization",
				items: [
					{
						name: "Personal prompt",
						desc: "Tone and response preferences sent before each chat.",
						control: { key: "personalPrompt", type: "textarea", rows: 14 },
					},
					{
						name: "Memories",
						desc: "Long-term memories the assistant has saved about you. Sorted by importance and recency.",
						control: { key: "memories", type: "textarea", rows: 10 },
					},
				],
			},
			{
				type: "group",
				heading: "Semantic search",
				items: [
					// Display-only live status row with a "Reprocess index" button.
					// It has no control, so it is rendered imperatively via `render`.
					// Without this, the row was missing on Obsidian 1.13+ because that
					// version renders the entire tab from getSettingDefinitions() and
					// skips display().
					{
						name: "Index status",
						desc: "Live status of the local semantic index.",
						aliases: ["semantic index", "rag", "indexing"],
						render: (setting) => {
							const unsubscribe = this.bindIndexProgress(setting);
							this.addReprocessButton(setting);
							return unsubscribe;
						},
					} satisfies SettingDefinition,
					{
						name: "Ignored semantic index paths",
						desc: "Vault-relative files or folders to exclude from the semantic index. Use one path or glob-like pattern per line.",
						control: { key: "ragIgnoredPaths", type: "textarea", rows: 5 },
					},
				],
			},
			{
				type: "group",
				heading: "Advanced",
				items: [
					{
						name: "Porygon folder",
						desc: "Vault folder where the assistant stores its internal notes (sessions, skills).",
						control: { key: "porygonFolder", type: "text", placeholder: DEFAULT_PORYGON_FOLDER },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return (this.plugin.settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	private refresh(): void {
		this.containerEl.empty();
		this.renderSections();
		this.ensureModelsLoaded();
	}

	// Kicks off the async model-list fetch for the current host if it hasn't run
	// yet. A host change is detected by comparing against the host already
	// fetched, so a settings re-render never re-fetches the same list.
	private ensureModelsLoaded(): void {
		const host = this.getHost();
		if (this.modelsHost !== host) {
			void this.loadModels(host);
		}
	}

	// Rebuilds every model row after the model list arrives. On the legacy
	// display() path the whole tab is re-rendered imperatively; on the 1.13+
	// getSettingDefinitions() path the tab can't be re-rendered without the
	// 1.13-only SettingTab.update(), so we rebuild just the model rows in place
	// instead. That keeps back-compat with minAppVersion (1.8.7): legacy users
	// still get their full re-render, 1.13+ users get their rows refreshed.
	private reflow(): void {
		if (this.hidden) {
			return;
		}
		if (this.declarativeUi) {
			for (const refresh of Object.values(this.modelRowRefreshers)) {
				refresh?.();
			}
			// The chat model's capabilities gate the thinking-effort control, so
			// rebuild it too whenever the model list refreshes.
			this.thinkingEffortRefresher?.();
		} else {
			this.refresh();
		}
	}

	// Refreshes a single model row after the user changes the model (or the model
	// list arrives). A targeted refresher on 1.13+, a full re-render on the legacy
	// path.
	private reflowModelRow(key: ModelSettingKey): void {
		if (this.hidden) {
			return;
		}
		if (this.declarativeUi) {
			this.modelRowRefreshers[key]?.();
			// The chat model's capabilities gate the thinking-effort control, so
			// rebuild it too when the chat model changes.
			if (key === "ollamaChatModel") {
				this.thinkingEffortRefresher?.();
			}
		} else {
			this.refresh();
		}
	}

	hide(): void {
		this.persist.run();
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = null;
		this.statusSetting = null;
		this.porygonFolderDraft = null;
		this.hidden = true;
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
			.setName("Index status");
		this.addReprocessButton(this.statusSetting);
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

	// Imperative display() path: create the row, then delegate to the shared
	// renderModelRow so the legacy (< 1.13) tab and the 1.13+ declarative tab
	// build the model picker the same way.
	private renderModelDropdown(containerEl: HTMLElement, key: ModelSettingKey, name: string, desc: string, capability: string): void {
		const setting = new Setting(containerEl).setName(name).setDesc(desc);
		this.renderModelRow(setting, key, capability);
	}

	// Shared model picker, used by both the imperative display() path and the
	// 1.13+ getSettingDefinitions() render() path. A dropdown of the models
	// currently pulled on the configured Ollama host (filtered by `capability`,
	// with the chat model's capability labels shown beneath it).
	private renderModelRow(setting: Setting, key: ModelSettingKey, capability: string): void {
		this.hidden = false;
		this.ensureModelsLoaded();
		// On the 1.13+ path keep a handle on this row so the async model list can
		// rebuild it in place when it arrives.
		if (this.declarativeUi) {
			this.modelRowRefreshers[key] = () => this.buildModelRow(setting, key, capability);
		}
		this.buildModelRow(setting, key, capability);
	}

	// Builds the model row for a single Setting. Idempotent: it clears any
	// control and capability labels from a previous build before re-adding them,
	// so the 1.13+ in-place refresher can run it again on the same row without
	// stacking controls or extra buttons.
	private buildModelRow(setting: Setting, key: ModelSettingKey, capability: string): void {
		setting.controlEl.empty();
		const staleTags = setting.descEl.querySelector(".porygon-settings-capability-tags");
		if (staleTags) {
			staleTags.remove();
		}

		const current = this.plugin.settings[key] ?? "";
		const available = this.models.filter((model) => this.modelCapabilities[model]?.includes(capability));
		const installed = current ? available.includes(current) : false;
		// A saved value (even if not installed) or any matching model means the
		// field has a dropdown to offer; otherwise leave it disabled.
		const hasChoice = available.length > 0 || !!current;

		setting.addDropdown((dd) => {
			if (!hasChoice) {
				dd.addOption("", "No models available");
				dd.selectEl.disabled = true;
				return;
			}
			if (current && !installed) {
				dd.addOption(current, `${current} (not installed)`);
			}
			available.forEach((model) => { dd.addOption(model, model); });

			// A saved value always wins (shown as its real entry, or as a
			// "(not installed)" entry); only fall back to a sensible default
			// when nothing is saved yet.
			dd.setValue(current || this.pickDefault(key, available));

			dd.onChange((value) => {
				this.plugin.settings[key] = value;
				this.persist();
				// The chat model's capabilities gate the thinking-effort control,
				// so refresh when the chat model changes.
				if (key === "ollamaChatModel") {
					this.reflowModelRow(key);
				}
			});
		});

		if (key === "ollamaChatModel") {
			this.renderCapabilityTags(setting, current);
		}
	}

	// Legacy imperative display() path: create the row, then delegate to the
	// shared builder so this and the 1.13+ render() path run the same pin logic.
	private renderThinkingEffort(containerEl: HTMLElement): void {
		const setting = new Setting(containerEl)
			.setName("Thinking effort")
			.setDesc("How much the model reasons before answering.");
		this.buildThinkingEffortRow(setting);
	}

	// 1.13+ getSettingDefinitions() render() path entry: keeps a handle on the row
	// so the async model list and chat-model changes can rebuild it in place, since
	// the declarative tab can't be re-rendered without the 1.13-only update().
	private renderThinkingEffortRow(setting: Setting): void {
		if (this.declarativeUi) {
			this.thinkingEffortRefresher = () => this.buildThinkingEffortRow(setting);
		}
		this.buildThinkingEffortRow(setting);
	}

	// Shared "Thinking effort" builder used by both the legacy imperative path and
	// the 1.13+ render() path. Idempotent: it clears any prior control from a
	// previous build before re-adding, so the 1.13+ in-place refresher can run it
	// again on the same row without stacking controls.
	private buildThinkingEffortRow(setting: Setting): void {
		setting.controlEl.empty();
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

		setting.addDropdown((dd) => {
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
		setting.setClass("porygon-settings-child");
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
		// The model list just changed: re-render whichever UI path is active so
		// the dropdowns and capability labels update in place.
		this.reflow();
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

	// "Reprocess index" affordance shared by the legacy display() row and the
	// 1.13+ declarative render() row, so the two stay in sync.
	private addReprocessButton(setting: Setting): void {
		setting.addExtraButton((btn) => btn
			.setIcon("refresh-cw")
			.setTooltip("Reprocess index")
			.onClick(() => {
				void this.plugin.ragIndexer.reconcile();
			}));
	}

	// Binds a status row's description to live index progress and returns an
	// unsubscribe so the caller owns the row's lifecycle.
	private bindIndexProgress(setting: Setting): () => void {
		return this.plugin.ragIndexer.onProgress((progress) => {
			setting.setDesc(this.getSemanticIndexStatusText(progress));
		});
	}

	private subscribeToIndexProgress(): void {
		if (!this.statusSetting) {
			return;
		}
		this.unsubscribeProgress?.();
		this.unsubscribeProgress = this.bindIndexProgress(this.statusSetting);
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
