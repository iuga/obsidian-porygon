import { AsyncLocalStorage } from "node:async_hooks";
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons";
import { Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { PorygonView, PORYGON_VIEW_TYPE } from "./porygon-view";
import { RagIndexedDbStore, RagIndexer, RagSemanticSearchService } from "./rag";
import { PorygonPluginSettings, DEFAULT_SETTINGS } from "./settings/settings";
import { PorygonSettingTab } from "./settings/settings-tab";
import { sanitizeMemories } from "./agent/memories";
import { SkillsService } from "./agent/skills";
import { resetAgent } from "./agent/agent";

export default class PorygonPlugin extends Plugin {
	settings: PorygonPluginSettings;
	ragIndexer: RagIndexer;
	ragSemanticSearch: RagSemanticSearchService;
	skills: SkillsService;
	private ragStore: RagIndexedDbStore;

	async onload(): Promise<void> {
		// LangGraph's `interrupt()` resumes the right async context only when
		// `AsyncLocalStorage` is wired into the singleton provider. We do it
		// here (once, before any agent stream runs) instead of at module load
		// to keep side effects out of import time.
		AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage());

		await this.loadSettings();
		this.skills = new SkillsService(this.app);
		this.ragStore = new RagIndexedDbStore();
		this.ragIndexer = new RagIndexer(this.app, this.settings, this.ragStore);
		this.ragSemanticSearch = new RagSemanticSearchService(this.settings, this.ragStore);

		this.registerView(
			PORYGON_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new PorygonView(leaf, this)
		);
		this.addSettingTab(new PorygonSettingTab(this));

		this.addRibbonIcon("origami", "Porygon", () => {
			void this.activateView();
		});

		this.app.workspace.onLayoutReady(() => {
			// Register vault listeners only after layout-ready so we don't react
			// to the synthetic `create` events Obsidian fires while scanning the
			// vault on startup. Without this, every existing note would be
			// re-embedded on every launch.
			this.registerRagIndexEvents();
			this.registerSkillEvents();
			void this.skills.initialize().catch((error) => {
				console.error("[Porygon Skills] failed to initialize", error);
			});
			void this.ragIndexer.reconcile();
		});
	}

	onunload(): void {
		this.ragIndexer?.dispose();
		void this.ragStore?.close();
	}

	async activateView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(PORYGON_VIEW_TYPE);
		let leaf: WorkspaceLeaf | null = existingLeaves[0] ?? null;

		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
		}

		if (!leaf) {
			return;
		}

		await leaf.setViewState({ type: PORYGON_VIEW_TYPE, active: true });
		this.app.workspace.rightSplit.expand();
	}

	async loadSettings(): Promise<void> {
		const savedSettings = await this.loadData() as Partial<PorygonPluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, savedSettings);
		this.settings.memories = sanitizeMemories(this.settings.memories);
	}

	async saveSettings(): Promise<void> {
		this.settings.memories = sanitizeMemories(this.settings.memories);
		await this.saveData(this.settings);
		this.ragIndexer.updateSettings(this.settings);
		this.ragSemanticSearch.updateSettings(this.settings);
		// Settings may have changed host/model/thinking; drop the cached agent
		// so the next send rebuilds it with the new config.
		resetAgent();
	}

	private registerSkillEvents(): void {
		const handle = (file: TAbstractFile, oldPath?: string) => {
			this.skills.refreshIfManaged(file, oldPath);
		};
		this.registerEvent(this.app.vault.on("create", (file) => handle(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => handle(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => handle(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => handle(file, oldPath)));
	}

	private registerRagIndexEvents(): void {
		this.registerEvent(this.app.vault.on("create", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				this.ragIndexer.enqueue(file);
			}
		}));
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				this.ragIndexer.debounceEnqueue(file);
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			if (file instanceof TFile && file.extension === "md") {
				void this.ragIndexer.deleteFile(file.path);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			if (oldPath.endsWith(".md")) {
				void this.ragIndexer.deleteFile(oldPath);
			}

			if (file instanceof TFile && file.extension === "md") {
				this.ragIndexer.enqueue(file);
			}
		}));
	}
}
