import { getFrontMatterInfo, ItemView, Modal, parseYaml, setIcon, stringifyYaml, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { AgentChatMessage, AskUserInterruptPayload, clearAgentMemory, generateSessionTitle, streamLocalAgent } from "./agent/agent";
import PorygonPlugin from "./main";
import { OllamaHttpClient, OllamaModel } from "./agent/ollama-client";
import { EXPERIENCE_PRESETS, ExperiencePreset, ONBOARDING_DEFAULTS } from "./settings/settings";
import { ChatList } from "./chat/chat-list";
import { ChatMessage, ChatRole, MentionedFile, MentionedItem, MentionType } from "./chat/types";

export const PORYGON_VIEW_TYPE = "porygon-view";

type OnboardingScreen = "welcome" | "ollamaHost" | "ollamaChatModel" | "ollamaEmbeddingModel" | "experience";
type OnboardingSettingKey = "ollamaHost" | "ollamaChatModel" | "ollamaEmbeddingModel" | "experience";

interface SettingStepHint {
	text: string;
	code?: string;
}

interface SettingStep {
	key: OnboardingSettingKey;
	label: string;
	message: string;
	hint: SettingStepHint;
}

// Chat types (ChatMessage, ChatRole, MentionedItem, MentionedFile, MentionType)
// live in ./chat/types so MessageRow / ChatList can reuse them.

interface MentionSearchResult {
	type: MentionType;
	path: string;
	label: string;
	title: string;
	files: TFile[];
}

type SlashCommandId = "new" | "save" | "sessions";

interface SlashCommand {
	id: SlashCommandId;
	label: string;
	syntax: string;
	description: string;
	icon: string;
}

interface SessionSummary {
	file: TFile;
	id: string;
	title: string;
	preview: string;
}

interface SessionMetadata {
	id?: string;
	title?: string;
	mentions?: string[];
}

interface ParsedSession {
	metadata: SessionMetadata;
	messages: ChatMessage[];
}

const SETTING_STEPS: SettingStep[] = [
	{
		key: "ollamaHost",
		label: "Ollama Host",
		message: "Where is Ollama running?",
		hint: { text: "After installing, the default URL is", code: "http://localhost:11434" },
	},
	{
		key: "ollamaChatModel",
		label: "Ollama Chat Model",
		message: "Choose a chat model.",
		hint: { text: "We recommend gemma4", code: "ollama run gemma4:latest" },
	},
	{
		key: "ollamaEmbeddingModel",
		label: "Ollama Embeddings Model",
		message: "Choose an embeddings model.",
		hint: { text: "We recommend Qwen3", code: "ollama run qwen3-embedding:8b" },
	},
	{
		key: "experience",
		label: "Experience",
		message: "How much should Porygon show its work?",
		hint: { text: "You can change this anytime in", code: "Settings \u2192 Porygon \u2192 Chat" },
	},
];

const SLASH_COMMANDS: SlashCommand[] = [
	{ id: "new", label: "New session", syntax: "/new", description: "Start a new session.", icon: "circle-plus" },
	{ id: "save", label: "Save session", syntax: "/save", description: "Save this session to a note.", icon: "save" },
	{ id: "sessions", label: "Sessions", syntax: "/sessions", description: "Load a saved session.", icon: "messages-square" },
];

const PORYGON_SESSIONS_FOLDER = "porygon/sessions";
const PORYGON_FRONTMATTER_DELIMITER = "---";
const MESSAGE_INPUT_PLACEHOLDER = "How can I help you today? - / for commands - @ for mentions";
const EMPTY_CHAT_QUOTES: [string, ...string[]] = [
	"What shall we make clearer today?",
	"Bring me a thought, I’ll bring a plan",
	"What deserves your attention next?",
	"Ready when your next idea is",
	"What can I help untangle?",
	"Start anywhere, we’ll shape it together",
];

export class PorygonView extends ItemView {
	private plugin: PorygonPlugin;
	private screen: OnboardingScreen = "welcome";
	private models: OllamaModel[] = [];
	private messages: ChatMessage[] = [];
	private chatHistoryEl: HTMLElement | null = null;
	private composerEl: HTMLElement | null = null;
	private composerInputEl: HTMLTextAreaElement | null = null;
	private sendButtonEl: HTMLButtonElement | null = null;
	private mentionTagsEl: HTMLElement | null = null;
	private mentionPopoverEl: HTMLElement | null = null;
	private mentionKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
	private mentionResults: MentionSearchResult[] = [];
	private selectedMentionResultIndex = 0;
	private selectedMentions: MentionedItem[] = [];
	private slashCommandPopoverEl: HTMLElement | null = null;
	private slashCommandKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
	private slashCommandPointerDownHandler: ((event: PointerEvent) => void) | null = null;
	private filteredSlashCommands: SlashCommand[] = [];
	private selectedSlashCommandIndex = 0;
	private sessionPopoverEl: HTMLElement | null = null;
	private sessionKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
	private sessionPointerDownHandler: ((event: PointerEvent) => void) | null = null;
	private sessionResults: SessionSummary[] = [];
	private allSessionSummaries: SessionSummary[] = [];
	private selectedSessionIndex = 0;
	private askPopoverEl: HTMLElement | null = null;
	private askKeydownHandler: ((event: KeyboardEvent) => void) | null = null;
	private askResolve: ((reply: string) => void) | null = null;
	private currentSessionId: string | null = null;
	private currentSessionTitle = "";
	private isSessionMemoryPrimed = false;
	private isStreaming = false;
	private isCheckingHealth = false;
	private isHealthy = true;
	// Streaming bookkeeping. The actual rAF/render-then-swap state machine
	// lives on the message's row inside ChatList; we just track which
	// message is the current target so deltas can be routed there and
	// finalizeStreaming() can drain it.
	private streamingMessage: ChatMessage | null = null;
	private chatList: ChatList | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: PorygonPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PORYGON_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Porygon";
	}

	getIcon(): string {
		return "origami";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("porygon-view");
		this.registerInternalLinkHandlers(this.contentEl);
		this.screen = this.getInitialScreen();
		await this.loadModelsForModelStep();
		this.render();
	}

	onClose(): Promise<void> {
		this.closeAskUserPopover(true);
		if (this.chatList) {
			this.chatList.dispose();
			this.chatList = null;
		}
		this.contentEl.empty();
		return Promise.resolve();
	}

	private registerInternalLinkHandlers(containerEl: HTMLElement): void {
		this.registerDomEvent(containerEl, "click", (event: MouseEvent) => {
			const target = event.target as HTMLElement | null;
			const anchor = target?.closest("a.internal-link") as HTMLAnchorElement | null;
			if (!anchor) {
				return;
			}

			event.preventDefault();
			const linktext = anchor.getAttribute("data-href") ?? anchor.getAttribute("href") ?? "";
			if (!linktext) {
				return;
			}

			const inNewLeaf = event.ctrlKey || event.metaKey || event.button === 1;
			void this.plugin.app.workspace.openLinkText(linktext, "/", inNewLeaf);
		});

		let lastHoveredAnchor: HTMLAnchorElement | null = null;
		this.registerDomEvent(containerEl, "pointerover", (event: PointerEvent) => {
			const target = event.target as HTMLElement | null;
			const anchor = target?.closest("a.internal-link") as HTMLAnchorElement | null;
			if (!anchor) {
				lastHoveredAnchor = null;
				return;
			}

			if (anchor === lastHoveredAnchor) {
				return;
			}
			lastHoveredAnchor = anchor;

			const linktext = anchor.getAttribute("data-href") ?? "";
			if (!linktext) {
				return;
			}

			this.plugin.app.workspace.trigger("hover-link", {
				event,
				source: "porygon",
				hoverParent: this,
				targetEl: anchor,
				linktext,
				sourcePath: "/",
			});
		});
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("porygon-view");

		if (this.isOnboardingComplete()) {
			this.renderPorygon();
			return;
		}

		if (this.screen === "welcome") {
			this.renderWelcome();
			return;
		}

		this.renderSettingScreen();
	}

	private renderPorygon(): void {
		this.contentEl.empty();
		this.contentEl.addClass("porygon-view");
		const main = this.contentEl.createDiv({ cls: "porygon-main" });
		this.chatHistoryEl = main.createDiv({ cls: "porygon-chat-history" });
		this.renderMessages();
		this.renderComposer(main);
		this.updateStreamingIndicator();
		void this.updateHealthStatus();
	}

	private renderMessages(): void {
		if (!this.chatHistoryEl) {
			return;
		}
		if (!this.chatList) {
			this.chatList = new ChatList(this.chatHistoryEl, {
				app: this.plugin.app,
				component: this,
				showToolUsage: () => this.plugin.settings.showToolUsage,
			});
		}
		const emptyQuote = this.messages.length === 0 ? this.getDailyEmptyChatQuote() : undefined;
		this.chatList.setMessages(this.messages, emptyQuote);
		if (this.messages.length > 0) {
			this.scrollChatToBottom();
		}
	}

	private getDailyEmptyChatQuote(): string {
		const today = new Date().toISOString().slice(0, 10);
		const quoteIndex = this.hashString(today) % EMPTY_CHAT_QUOTES.length;
		return EMPTY_CHAT_QUOTES[quoteIndex] ?? EMPTY_CHAT_QUOTES[0];
	}

	private hashString(value: string): number {
		return [...value].reduce((hash, character) => ((hash << 5) - hash + character.charCodeAt(0)) >>> 0, 0);
	}

	private renderComposer(containerEl: HTMLElement): void {
		const composer = containerEl.createDiv({ cls: "porygon-composer" });
		this.composerEl = composer;
		this.mentionTagsEl = composer.createDiv({ cls: "porygon-mention-tags" });
		this.renderMentionTags();
		composer.createDiv({ cls: "porygon-attachments" });
		this.composerInputEl = composer.createEl("textarea", {
			cls: "porygon-message-input",
			attr: { placeholder: MESSAGE_INPUT_PLACEHOLDER },
		});
		const actionsRow = composer.createDiv({ cls: "porygon-composer-actions" });
		const leftActions = actionsRow.createDiv({ cls: "porygon-composer-left-actions" });
		const slashCommandButton = leftActions.createEl("button", {
			cls: "porygon-composer-button",
			attr: { title: "Slash commands", "aria-label": "Slash commands" },
		});
		setIcon(slashCommandButton, "circle-slash");
		slashCommandButton.addEventListener("click", () => this.toggleSlashCommandPopover(composer));
		const mentionButton = leftActions.createEl("button", {
			cls: "porygon-composer-button",
			attr: { title: "Mention files or folders", "aria-label": "Mention files or folders" },
		});
		setIcon(mentionButton, "at-sign");
		mentionButton.addEventListener("click", () => this.toggleMentionPopover(composer));
		this.sendButtonEl = actionsRow.createEl("button", {
			cls: "porygon-send-button",
			attr: { title: "Type a message...", "aria-label": "Type a message..." },
		});
		setIcon(this.sendButtonEl, "send-horizontal");
		this.updateSendButtonState();

		this.composerInputEl.addEventListener("input", () => this.handleComposerInput());
		this.composerInputEl.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.mentionPopoverEl) {
				event.preventDefault();
				this.closeMentionPopover();
				return;
			}

			if (event.key === "Escape" && this.slashCommandPopoverEl) {
				event.preventDefault();
				this.closeSlashCommandPopover();
				return;
			}

			if (event.key === "@" && !this.mentionPopoverEl) {
				this.closeSlashCommandPopover();
				window.setTimeout(() => this.renderMentionPopover(composer), 0);
				return;
			}

			if (event.key === "/" && !this.slashCommandPopoverEl) {
				this.closeMentionPopover();
				window.setTimeout(() => this.renderSlashCommandPopover(composer), 0);
				return;
			}

			if (event.key !== "Enter" || event.shiftKey) {
				return;
			}

			event.preventDefault();
			void this.sendCurrentMessage();
		});
		this.sendButtonEl.addEventListener("click", () => {
			void this.sendCurrentMessage();
		});
	}

	private renderWelcome(): void {
		const wrapper = this.contentEl.createDiv({ cls: "porygon-welcome" });
		const iconEl = wrapper.createDiv({ cls: "porygon-welcome-icon" });
		setIcon(iconEl, "origami");
		wrapper.createEl("h2", { text: "Welcome" });
		wrapper.createEl("p", { text: "Turn your notes into a conversation..." });

		const button = wrapper.createEl("button", {
			cls: "mod-cta porygon-primary-button",
			text: "Let's start",
		});

		button.addEventListener("click", () => {
			this.screen = "ollamaHost";
			this.render();
		});
	}

	private renderSettingScreen(): void {
		const wrapper = this.contentEl.createDiv({ cls: "porygon-settings" });
		const iconEl = wrapper.createDiv({ cls: "porygon-settings-icon" });
		setIcon(iconEl, "origami");
		this.renderVerticalSteps(wrapper);
	}

	private renderVerticalSteps(containerEl: HTMLElement): void {
		const stepsEl = containerEl.createDiv({ cls: "porygon-vertical-steps" });
		const currentStepIndex = this.getCurrentStepIndex();

		SETTING_STEPS.forEach((step, index) => {
			const isActive = index === currentStepIndex;
			const isComplete = this.isStepComplete(step.key);
			const row = stepsEl.createDiv({ cls: "porygon-vertical-step" });
			row.toggleClass("is-active", isActive);
			row.toggleClass("is-complete", isComplete);
			row.toggleClass("is-clickable", isComplete);

			const rail = row.createDiv({ cls: "porygon-step-rail" });
			rail.createDiv({ cls: "porygon-step-node", text: isComplete ? "✓" : String(index + 1) });
			const card = row.createDiv({ cls: "porygon-step-card" });
			this.renderStepSummary(card, step, isComplete, isActive);

			if (isComplete) {
				row.addEventListener("click", () => {
					this.screen = step.key;
					void this.loadModelsForModelStep().then(() => this.render());
				});
			}

			if (isActive) {
				this.renderStepEditor(card, step.key);
			}
		});
	}

	private renderStepSummary(containerEl: HTMLElement, step: SettingStep, isComplete: boolean, isActive: boolean): void {
		const header = containerEl.createDiv({ cls: "porygon-step-card-header" });
		header.createEl("strong", { text: step.label });

		if (isComplete && !isActive) {
			const rawValue = this.plugin.settings[step.key];
			const value = step.key === "experience"
				? (EXPERIENCE_PRESETS.find((entry) => entry.value === rawValue)?.label ?? rawValue)
				: rawValue;
			header.createSpan({ cls: "porygon-step-value", text: value });
			return;
		}

		header.createSpan({ cls: "porygon-step-message", text: step.message });
	}

	private renderStepEditor(containerEl: HTMLElement, stepKey: OnboardingSettingKey): void {
		if (stepKey === "ollamaHost") {
			this.renderHostEditor(containerEl);
			return;
		}

		if (stepKey === "ollamaChatModel" || stepKey === "ollamaEmbeddingModel") {
			this.renderModelEditor(containerEl, stepKey);
			return;
		}

		if (stepKey === "experience") {
			this.renderExperienceEditor(containerEl);
		}
	}

	private renderStepHint(containerEl: HTMLElement, stepKey: OnboardingSettingKey): void {
		const step = SETTING_STEPS.find((entry) => entry.key === stepKey);
		if (!step) {
			return;
		}
		const hintEl = containerEl.createDiv({ cls: "porygon-step-hint", attr: { role: "note" } });
		const iconEl = hintEl.createSpan({ cls: "porygon-step-hint-icon" });
		setIcon(iconEl, "info");
		const textEl = hintEl.createSpan({ cls: "porygon-step-hint-text" });
		textEl.appendText(step.hint.text);
		if (step.hint.code) {
			textEl.appendText(" ");
			textEl.createEl("code", { text: step.hint.code });
		}
	}

	private renderHostEditor(containerEl: HTMLElement): void {
		const editor = containerEl.createDiv({ cls: "porygon-step-editor" });
		this.renderStepHint(editor, "ollamaHost");
		const input = editor.createEl("input", {
			attr: {
				type: "text",
				value: this.plugin.settings.ollamaHost || ONBOARDING_DEFAULTS.ollamaHost,
			},
		});
		const errorEl = editor.createDiv({ cls: "porygon-onboarding-error" });
		const button = this.createNextButton(editor);

		button.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.handleHostNext(input.value.trim(), errorEl, button);
		});
	}

	private renderModelEditor(containerEl: HTMLElement, settingKey: "ollamaChatModel" | "ollamaEmbeddingModel"): void {
		const editor = containerEl.createDiv({ cls: "porygon-step-editor" });
		this.renderStepHint(editor, settingKey);
		const defaultValue = settingKey === "ollamaChatModel" ? ONBOARDING_DEFAULTS.ollamaChatModel : ONBOARDING_DEFAULTS.ollamaEmbeddingModel;
		const select = editor.createEl("select");
		const modelNames = this.models.map((model) => model.name);
		const selectedValue = this.getPreferredModelValue(settingKey, defaultValue, modelNames);

		if (modelNames.length === 0) {
			select.createEl("option", { text: "No models available", value: "" });
			select.disabled = true;
		} else {
			modelNames.forEach((modelName) => {
				const option = select.createEl("option", { text: modelName, value: modelName });
				option.selected = modelName === selectedValue;
			});
		}

		const errorEl = editor.createDiv({ cls: "porygon-onboarding-error" });
		if (modelNames.length === 0) {
			this.renderNoModelsGuidance(errorEl);
		}
		const button = this.createNextButton(editor);

		button.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.handleModelNext(settingKey, select.value, errorEl, button);
		});
	}

	private createNextButton(containerEl: HTMLElement): HTMLButtonElement {
		return containerEl.createEl("button", {
			cls: "mod-cta porygon-primary-button",
			text: "Next",
		});
	}

	private async handleHostNext(value: string, errorEl: HTMLElement, button: HTMLButtonElement): Promise<void> {
		errorEl.empty();

		if (!value) {
			errorEl.setText("Ollama host is required.");
			return;
		}

		try {
			new URL(value);
		} catch {
			errorEl.setText("Enter a valid host.");
			return;
		}

		this.setLoading(button, true, "Checking...");

		try {
			this.plugin.settings.ollamaHost = value;
			await this.fetchModels();
			await this.plugin.saveSettings();
			this.screen = "ollamaChatModel";
			this.render();
		} catch {
			this.renderOllamaConnectionGuidance(errorEl);
		} finally {
			this.setLoading(button, false);
		}
	}

	private async handleModelNext(settingKey: "ollamaChatModel" | "ollamaEmbeddingModel", value: string, errorEl: HTMLElement, button: HTMLButtonElement): Promise<void> {
		errorEl.empty();

		if (!value) {
			this.renderNoModelsGuidance(errorEl);
			return;
		}

		this.setLoading(button, true);

		try {
			this.plugin.settings[settingKey] = value;
			await this.plugin.saveSettings();

			if (settingKey === "ollamaChatModel") {
				this.screen = "ollamaEmbeddingModel";
				this.render();
				return;
			}

			this.screen = "experience";
			this.render();
		} finally {
			this.setLoading(button, false);
		}
	}

	private renderExperienceEditor(containerEl: HTMLElement): void {
		const editor = containerEl.createDiv({ cls: "porygon-step-editor" });
		this.renderStepHint(editor, "experience");

		const select = editor.createEl("select");
		const currentValue = this.plugin.settings.experience || ONBOARDING_DEFAULTS.experience;
		EXPERIENCE_PRESETS.forEach((preset) => {
			const option = select.createEl("option", { text: preset.label, value: preset.value });
			option.selected = preset.value === currentValue;
		});

		const description = editor.createDiv({ cls: "porygon-experience-description" });
		const updateDescription = () => {
			const preset = EXPERIENCE_PRESETS.find((entry) => entry.value === select.value);
			description.setText(preset?.description ?? "");
		};
		updateDescription();
		select.addEventListener("change", updateDescription);

		const errorEl = editor.createDiv({ cls: "porygon-onboarding-error" });
		const button = this.createNextButton(editor);

		button.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.handleExperienceNext(select.value as ExperiencePreset, errorEl, button);
		});
	}

	private async handleExperienceNext(value: ExperiencePreset, errorEl: HTMLElement, button: HTMLButtonElement): Promise<void> {
		errorEl.empty();
		const preset = EXPERIENCE_PRESETS.find((entry) => entry.value === value);

		if (!preset) {
			errorEl.setText("Pick an experience.");
			return;
		}

		this.setLoading(button, true);

		try {
			this.plugin.settings.experience = preset.value;
			this.plugin.settings.ollamaThinking = preset.ollamaThinking;
			this.plugin.settings.showToolUsage = preset.showToolUsage;
			this.plugin.settings.yolo = preset.yolo;
			await this.plugin.saveSettings();
			this.renderPorygon();
		} finally {
			this.setLoading(button, false);
		}
	}

	private async fetchModels(): Promise<void> {
		const ollama = this.createOllamaClient();

		await ollama.version();
		const response = await ollama.list();
		this.models = response.models;
	}

	private async loadModelsForModelStep(): Promise<void> {
		if (this.screen !== "ollamaChatModel" && this.screen !== "ollamaEmbeddingModel") {
			return;
		}

		try {
			await this.fetchModels();
		} catch {
			this.models = [];
		}
	}

	private createOllamaClient(): OllamaHttpClient {
		return new OllamaHttpClient(this.getOllamaBaseUrl());
	}

	private getOllamaBaseUrl(): string {
		return this.plugin.settings.ollamaHost || ONBOARDING_DEFAULTS.ollamaHost;
	}

	private getPreferredModelValue(settingKey: "ollamaChatModel" | "ollamaEmbeddingModel", defaultValue: string, modelNames: string[]): string {
		if (this.plugin.settings[settingKey]) {
			return this.plugin.settings[settingKey];
		}

		const latestValue = `${defaultValue}:latest`;
		if (modelNames.includes(latestValue)) {
			return latestValue;
		}

		if (modelNames.includes(defaultValue)) {
			return defaultValue;
		}

		return modelNames[0] ?? "";
	}

	private renderOllamaConnectionGuidance(containerEl: HTMLElement): void {
		const contentEl = this.createHint(containerEl);
		contentEl.createEl("p", { text: "Unable to connect. Try these steps:" });
		const list = contentEl.createEl("ol");
		const installItem = list.createEl("li");
		installItem.appendText("Install ollama: ");
		installItem.createEl("a", {
			text: "https://ollama.com/download",
			attr: { href: "https://ollama.com/download" },
		});
		list.createEl("li", { text: "Make sure ollama is running, then try again." });
	}

	private renderNoModelsGuidance(containerEl: HTMLElement): void {
		const contentEl = this.createHint(containerEl);
		contentEl.createEl("p", { text: "No models are installed. Download a model from your terminal, for example:" });
		const command = contentEl.createEl("code");
		command.appendText("ollama run gemma4");
	}

	private createHint(containerEl: HTMLElement): HTMLElement {
		containerEl.empty();
		const hintEl = containerEl.createDiv({ cls: "porygon-hint" });
		const iconEl = hintEl.createDiv({ cls: "porygon-hint-icon" });
		setIcon(iconEl, "lightbulb");
		return hintEl.createDiv({ cls: "porygon-hint-content" });
	}

	private async handleNewConversationCommand(): Promise<void> {
		if (!this.hasConversationContent()) {
			this.startNewChat();
			return;
		}

		const decision = await this.confirmSaveBeforeNewConversation();
		if (decision === "cancel") {
			this.composerInputEl?.focus();
			return;
		}

		if (decision === "yes") {
			await this.saveSession();
		}

		this.startNewChat();
	}

	private hasConversationContent(): boolean {
		return this.messages.some((message) => (message.role === "user" || message.role === "porygon") && message.content.trim().length > 0);
	}

	private confirmSaveBeforeNewConversation(): Promise<"yes" | "no" | "cancel"> {
		return new Promise((resolve) => {
			new SaveBeforeNewConversationModal(this.plugin, resolve).open();
		});
	}

	private startNewChat(): void {
		if (this.currentSessionId) {
			void clearAgentMemory(this.currentSessionId);
		}
		this.currentSessionId = null;
		this.currentSessionTitle = "";
		this.isSessionMemoryPrimed = false;
		this.messages = [];
		this.selectedMentions = [];
		this.renderMentionTags();
		this.closeMentionPopover();
		this.closeSlashCommandPopover();
		this.closeSessionPopover();
		this.closeAskUserPopover(true);
		this.updateSendButtonState();
		this.renderMessages();
		this.composerInputEl?.focus();
	}

	private renderMentionTags(): void {
		if (!this.mentionTagsEl) {
			return;
		}

		this.mentionTagsEl.empty();
		this.renderMentionTagList(this.mentionTagsEl, this.selectedMentions, true);
	}

	private renderMentionTagList(containerEl: HTMLElement, mentions: MentionedItem[], isRemovable: boolean): void {
		mentions.forEach((mention) => {
			const tag = containerEl.createEl(isRemovable ? "button" : "div", {
				cls: "porygon-mention-tag",
				attr: { title: mention.path, "aria-label": isRemovable ? `Remove ${mention.basename}` : mention.basename },
			});
			const noteIcon = tag.createSpan({ cls: "porygon-mention-tag-icon" });
			setIcon(noteIcon, this.getMentionIcon(mention.type));
			tag.createSpan({ cls: "porygon-mention-tag-title", text: mention.basename });

			if (!isRemovable) {
				return;
			}

			const removeIcon = tag.createSpan({ cls: "porygon-mention-tag-remove" });
			setIcon(removeIcon, "x");
			tag.addEventListener("click", () => this.removeMentionedItemByPath(mention.path));
		});
	}

	private toggleMentionPopover(composerEl: HTMLElement): void {
		if (this.mentionPopoverEl) {
			this.closeMentionPopover();
			return;
		}

		this.closeSlashCommandPopover();
		this.renderMentionPopover(composerEl);
	}

	private toggleSlashCommandPopover(composerEl: HTMLElement): void {
		if (this.slashCommandPopoverEl) {
			this.closeSlashCommandPopover();
			return;
		}

		this.closeMentionPopover();
		this.renderSlashCommandPopover(composerEl);
	}

	private renderMentionPopover(composerEl: HTMLElement): void {
		this.closeMentionPopover();
		const popover = composerEl.createDiv({ cls: "porygon-mention-popover" });
		this.mentionPopoverEl = popover;
		const panel = popover.createDiv({ cls: "porygon-mention-panel" });
		const filterInput = panel.createEl("input", {
			cls: "porygon-mention-filter",
			attr: { type: "text", placeholder: "Filter notes and folders..." },
		});
		const notesEl = panel.createDiv({ cls: "porygon-mention-results" });
		const renderNotes = () => this.renderMentionResults(notesEl, filterInput.value);

		filterInput.addEventListener("input", () => {
			this.selectedMentionResultIndex = 0;
			renderNotes();
		});
		this.mentionKeydownHandler = (event: KeyboardEvent) => this.handleMentionPopoverKeydown(event, notesEl, filterInput.value);
		window.addEventListener("keydown", this.mentionKeydownHandler, true);
		renderNotes();
		filterInput.focus();
	}

	private handleMentionPopoverKeydown(event: KeyboardEvent, notesEl: HTMLElement, query: string): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.closeMentionPopover();
			this.composerInputEl?.focus();
			return;
		}

		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopPropagation();
			this.moveMentionSelection(1, notesEl, query);
			return;
		}

		if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			this.moveMentionSelection(-1, notesEl, query);
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			const selectedResult = this.mentionResults[this.selectedMentionResultIndex];
			if (selectedResult) {
				this.addMentionedItem(selectedResult);
				return;
			}

			this.closeMentionPopover();
			this.composerInputEl?.focus();
		}
	}

	private renderMentionResults(containerEl: HTMLElement, query: string): void {
		containerEl.empty();
		const results = this.getMentionResults(query);
		this.mentionResults = results;
		this.selectedMentionResultIndex = Math.min(this.selectedMentionResultIndex, Math.max(results.length - 1, 0));

		if (results.length === 0) {
			containerEl.createDiv({ cls: "porygon-mention-empty", text: "No notes or folders found" });
			return;
		}

		results.forEach((result, index) => {
			const mentionButton = containerEl.createEl("button", {
				cls: "porygon-mention-result",
				attr: { title: result.title, "aria-label": `Mention ${result.title}`, type: "button" },
			});
			mentionButton.toggleClass("is-selected", index === this.selectedMentionResultIndex);
			const iconEl = mentionButton.createSpan({ cls: "porygon-mention-result-icon" });
			setIcon(iconEl, this.getMentionIcon(result.type));
			mentionButton.createSpan({ cls: "porygon-mention-result-path", text: result.label });
			mentionButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.addMentionedItem(result);
			});
		});
	}

	private moveMentionSelection(direction: number, containerEl: HTMLElement, query: string): void {
		if (this.mentionResults.length === 0) {
			return;
		}

		this.selectedMentionResultIndex = (this.selectedMentionResultIndex + direction + this.mentionResults.length) % this.mentionResults.length;
		this.renderMentionResults(containerEl, query);
		const selectedEl = containerEl.querySelector<HTMLElement>(".porygon-mention-result.is-selected");
		selectedEl?.scrollIntoView({ block: "nearest" });
	}

	private getMentionResults(query: string): MentionSearchResult[] {
		const normalizedQuery = query.trim().toLowerCase();
		const unavailablePaths = this.getUnavailableMentionPaths();
		const results: MentionSearchResult[] = [];
		const activeFile = this.plugin.app.workspace.getActiveFile();

		if (activeFile instanceof TFile && activeFile.extension === "md" && !unavailablePaths.has(activeFile.path)) {
			results.push({
				type: "active-note",
				path: activeFile.path,
				label: "Active Note",
				title: activeFile.path,
				files: [activeFile],
			});
		}

		this.plugin.app.vault.getMarkdownFiles()
			.filter((file) => !unavailablePaths.has(file.path))
			.map((file): MentionSearchResult => ({
				type: "note",
				path: file.path,
				label: file.path,
				title: file.path,
				files: [file],
			}))
			.forEach((result) => results.push(result));

		this.plugin.app.vault.getAllFolders()
			.filter((folder) => !unavailablePaths.has(folder.path))
			.map((folder): MentionSearchResult => ({
				type: "folder",
				path: folder.path,
				label: folder.path,
				title: folder.path,
				files: this.getDirectMarkdownFiles(folder),
			}))
			.forEach((result) => results.push(result));

		return results
			.filter((result) => this.doesMentionResultMatch(result, normalizedQuery))
			.sort((first, second) => this.getMentionSortValue(first).localeCompare(this.getMentionSortValue(second)));
	}

	private doesMentionResultMatch(result: MentionSearchResult, normalizedQuery: string): boolean {
		if (!normalizedQuery) {
			return true;
		}

		return result.label.toLowerCase().includes(normalizedQuery) || result.path.toLowerCase().includes(normalizedQuery);
	}

	private getMentionSortValue(result: MentionSearchResult): string {
		if (result.type === "active-note") {
			return `0-${result.path}`;
		}

		return `${result.type === "folder" ? "1" : "2"}-${result.path}`;
	}

	private getDirectMarkdownFiles(folder: TFolder): TFile[] {
		return folder.children
			.filter((child): child is TFile => child instanceof TFile && child.extension === "md")
			.sort((first, second) => first.path.localeCompare(second.path));
	}

	private addMentionedItem(result: MentionSearchResult): void {
		if (this.getUnavailableMentionPaths().has(result.path)) {
			this.closeMentionPopover();
			this.composerInputEl?.focus();
			return;
		}

		const mention = this.toMentionedItem(result);
		this.selectedMentions = [...this.selectedMentions, mention];
		this.insertMentionLink(mention);
		this.renderMentionTags();
		this.updateSendButtonState();
		this.closeMentionPopover();
		this.composerInputEl?.focus();
	}

	private insertMentionLink(mention: MentionedItem): void {
		if (!this.composerInputEl) {
			return;
		}

		const link = this.getMentionLink(mention);
		const selectionStart = this.composerInputEl.selectionStart;
		const selectionEnd = this.composerInputEl.selectionEnd;
		const value = this.composerInputEl.value;
		const atIndex = value.lastIndexOf("@", selectionStart - 1);
		const replaceStart = atIndex === -1 ? selectionStart : atIndex;
		this.composerInputEl.value = `${value.slice(0, replaceStart)}${link}${value.slice(selectionEnd)}`;
		const cursor = replaceStart + link.length;
		this.composerInputEl.setSelectionRange(cursor, cursor);
	}

	private handleComposerInput(): void {
		this.syncMentionsWithComposerText();
		this.updateSendButtonState();
	}

	private syncMentionsWithComposerText(): void {
		if (!this.composerInputEl || this.selectedMentions.length === 0) {
			return;
		}

		const content = this.composerInputEl.value;
		const syncedMentions = this.selectedMentions.filter((mention) => content.includes(this.getMentionLink(mention)));
		if (syncedMentions.length === this.selectedMentions.length) {
			return;
		}

		this.selectedMentions = syncedMentions;
		this.renderMentionTags();
	}

	private getMentionLink(mention: MentionedItem): string {
		return `[[${mention.basename}]]`;
	}

	private removeMentionedItemByPath(path: string): void {
		this.selectedMentions = this.selectedMentions.filter((selectedMention) => selectedMention.path !== path);
		this.renderMentionTags();
		this.updateSendButtonState();
		this.composerInputEl?.focus();
	}

	private closeMentionPopover(): void {
		if (this.mentionKeydownHandler) {
			window.removeEventListener("keydown", this.mentionKeydownHandler, true);
			this.mentionKeydownHandler = null;
		}

		this.mentionPopoverEl?.remove();
		this.mentionPopoverEl = null;
		this.mentionResults = [];
		this.selectedMentionResultIndex = 0;
	}

	private renderSlashCommandPopover(composerEl: HTMLElement): void {
		this.closeSlashCommandPopover();
		const popover = composerEl.createDiv({ cls: "porygon-slash-popover" });
		this.slashCommandPopoverEl = popover;
		const panel = popover.createDiv({ cls: "porygon-slash-panel" });
		const filterInput = panel.createEl("input", {
			cls: "porygon-slash-filter",
			attr: { type: "text", placeholder: "Filter commands..." },
		});
		const commandsEl = panel.createDiv({ cls: "porygon-slash-results" });
		const descriptionEl = panel.createDiv({ cls: "porygon-slash-description" });
		const renderCommands = () => this.renderSlashCommandResults(commandsEl, descriptionEl, filterInput.value);

		filterInput.addEventListener("input", () => {
			this.selectedSlashCommandIndex = 0;
			renderCommands();
		});
		this.slashCommandKeydownHandler = (event: KeyboardEvent) => this.handleSlashCommandPopoverKeydown(event, commandsEl, descriptionEl, filterInput.value);
		this.slashCommandPointerDownHandler = (event: PointerEvent) => this.handleSlashCommandPointerDown(event);
		window.addEventListener("keydown", this.slashCommandKeydownHandler, true);
		window.addEventListener("pointerdown", this.slashCommandPointerDownHandler, true);
		renderCommands();
		filterInput.focus();
	}

	private handleSlashCommandPopoverKeydown(event: KeyboardEvent, commandsEl: HTMLElement, descriptionEl: HTMLElement, query: string): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.closeSlashCommandPopover();
			this.composerInputEl?.focus();
			return;
		}

		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopPropagation();
			this.moveSlashCommandSelection(1, commandsEl, descriptionEl, query);
			return;
		}

		if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			this.moveSlashCommandSelection(-1, commandsEl, descriptionEl, query);
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			const selectedCommand = this.filteredSlashCommands[this.selectedSlashCommandIndex];
			if (selectedCommand) {
				this.selectSlashCommand(selectedCommand);
				return;
			}

			this.closeSlashCommandPopover();
			this.composerInputEl?.focus();
		}
	}

	private handleSlashCommandPointerDown(event: PointerEvent): void {
		if (!this.slashCommandPopoverEl) {
			return;
		}

		const target = event.target;
		if (target instanceof Node && this.slashCommandPopoverEl.contains(target)) {
			return;
		}

		this.closeSlashCommandPopover();
	}

	private renderSlashCommandResults(containerEl: HTMLElement, descriptionEl: HTMLElement, query: string): void {
		containerEl.empty();
		const commands = this.getSlashCommands(query);
		this.filteredSlashCommands = commands;
		this.selectedSlashCommandIndex = Math.min(this.selectedSlashCommandIndex, Math.max(commands.length - 1, 0));

		if (commands.length === 0) {
			descriptionEl.empty();
			containerEl.createDiv({ cls: "porygon-slash-empty", text: "No commands found" });
			return;
		}

		commands.forEach((command, index) => {
			const commandButton = containerEl.createEl("button", {
				cls: "porygon-slash-result",
				attr: { title: command.description, "aria-label": command.label, type: "button" },
			});
			commandButton.toggleClass("is-selected", index === this.selectedSlashCommandIndex);
			const iconEl = commandButton.createSpan({ cls: "porygon-slash-result-icon" });
			setIcon(iconEl, command.icon);
			const textEl = commandButton.createSpan({ cls: "porygon-slash-result-text" });
			textEl.createSpan({ cls: "porygon-slash-result-syntax", text: command.syntax });
			textEl.createSpan({ cls: "porygon-slash-result-label", text: command.label });
			commandButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.selectSlashCommand(command);
			});
		});

		this.renderSlashCommandDescription(descriptionEl);
	}

	private renderSlashCommandDescription(descriptionEl: HTMLElement): void {
		descriptionEl.empty();
		const selectedCommand = this.filteredSlashCommands[this.selectedSlashCommandIndex];
		if (!selectedCommand) {
			return;
		}

		descriptionEl.setText(selectedCommand.description);
	}

	private moveSlashCommandSelection(direction: number, containerEl: HTMLElement, descriptionEl: HTMLElement, query: string): void {
		if (this.filteredSlashCommands.length === 0) {
			return;
		}

		this.selectedSlashCommandIndex = (this.selectedSlashCommandIndex + direction + this.filteredSlashCommands.length) % this.filteredSlashCommands.length;
		this.renderSlashCommandResults(containerEl, descriptionEl, query);
		const selectedEl = containerEl.querySelector<HTMLElement>(".porygon-slash-result.is-selected");
		selectedEl?.scrollIntoView({ block: "nearest" });
	}

	private getSlashCommands(query: string): SlashCommand[] {
		const normalizedQuery = query.trim().toLowerCase();
		if (!normalizedQuery) {
			return SLASH_COMMANDS;
		}

		return SLASH_COMMANDS.filter((command) =>
			command.label.toLowerCase().includes(normalizedQuery) ||
			command.syntax.toLowerCase().includes(normalizedQuery)
		);
	}

	private selectSlashCommand(command: SlashCommand): void {
		this.closeSlashCommandPopover();
		this.composerInputEl?.focus();

		if (command.id === "new") {
			void this.handleNewConversationCommand();
			return;
		}

		if (command.id === "save") {
			void this.saveSession();
			return;
		}

		if (command.id === "sessions") {
			void this.handleSessionsCommand();
		}
	}

	private async handleSessionsCommand(): Promise<void> {
		if (!this.composerEl) {
			return;
		}

		await this.renderSessionPopover(this.composerEl);
	}

	private async renderSessionPopover(composerEl: HTMLElement): Promise<void> {
		this.closeSessionPopover();
		this.closeMentionPopover();
		this.closeSlashCommandPopover();
		const popover = composerEl.createDiv({ cls: "porygon-session-popover" });
		this.sessionPopoverEl = popover;
		const panel = popover.createDiv({ cls: "porygon-session-panel" });
		const filterInput = panel.createEl("input", {
			cls: "porygon-session-filter",
			attr: { type: "text", placeholder: "Filter sessions..." },
		});
		const sessionsEl = panel.createDiv({ cls: "porygon-session-results" });
		this.allSessionSummaries = await this.getSessionSummaries();
		const renderSessions = () => this.renderSessionResults(sessionsEl, filterInput.value);

		filterInput.addEventListener("input", () => {
			this.selectedSessionIndex = 0;
			renderSessions();
		});
		this.sessionKeydownHandler = (event: KeyboardEvent) => this.handleSessionPopoverKeydown(event, sessionsEl, filterInput.value);
		this.sessionPointerDownHandler = (event: PointerEvent) => this.handleSessionPointerDown(event);
		window.addEventListener("keydown", this.sessionKeydownHandler, true);
		window.addEventListener("pointerdown", this.sessionPointerDownHandler, true);
		renderSessions();
		filterInput.focus();
	}

	private async getSessionSummaries(): Promise<SessionSummary[]> {
		const folder = this.plugin.app.vault.getAbstractFileByPath(PORYGON_SESSIONS_FOLDER);
		if (!(folder instanceof TFolder)) {
			return [];
		}

		const files = folder.children
			.filter((child): child is TFile => child instanceof TFile && child.extension === "md")
			.sort((first, second) => second.stat.mtime - first.stat.mtime);
		return Promise.all(files.map((file) => this.getSessionSummary(file)));
	}

	private async getSessionSummary(file: TFile): Promise<SessionSummary> {
		try {
			const content = await this.plugin.app.vault.cachedRead(file);
			const parsed = this.parseSession(content);
			const preview = this.getSessionPreview(parsed.messages);
			const title = parsed.metadata.title || this.getFallbackSessionTitle(parsed.messages);
			return {
				file,
				id: parsed.metadata.id ?? file.basename,
				title,
				preview,
			};
		} catch (error) {
			console.error("Unable to read Porygon session", file.path, error);
			return { file, id: file.basename, title: "", preview: "" };
		}
	}

	private getSessionPreview(messages: ChatMessage[]): string {
		return messages.find((message) => message.role === "user" && message.content.trim().length > 0)?.content.trim().replace(/\s+/g, " ") ?? "";
	}

	private renderSessionResults(containerEl: HTMLElement, query: string): void {
		containerEl.empty();
		const normalizedQuery = query.trim().toLowerCase();
		const results = this.allSessionSummaries.filter((session) => this.doesSessionMatch(session, normalizedQuery));
		this.sessionResults = results;
		this.selectedSessionIndex = Math.min(this.selectedSessionIndex, Math.max(results.length - 1, 0));

		if (results.length === 0) {
			containerEl.createDiv({ cls: "porygon-session-empty", text: "No sessions found" });
			return;
		}

		results.forEach((session, index) => {
			const sessionButton = containerEl.createEl("button", {
				cls: "porygon-session-result",
				attr: { title: session.file.path, "aria-label": `Load ${session.file.basename}`, type: "button" },
			});
			sessionButton.toggleClass("is-selected", index === this.selectedSessionIndex);
			const iconEl = sessionButton.createSpan({ cls: "porygon-session-result-icon" });
			setIcon(iconEl, "messages-square");
			const textEl = sessionButton.createSpan({ cls: "porygon-session-result-text" });
			textEl.createSpan({ cls: "porygon-session-result-title", text: session.id });
			textEl.createSpan({ cls: "porygon-session-result-preview", text: session.title || session.preview || session.file.basename });
			sessionButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.selectSession(session);
			});
		});
	}

	private doesSessionMatch(session: SessionSummary, normalizedQuery: string): boolean {
		if (!normalizedQuery) {
			return true;
		}

		return session.id.toLowerCase().includes(normalizedQuery) ||
			session.title.toLowerCase().includes(normalizedQuery) ||
			session.preview.toLowerCase().includes(normalizedQuery) ||
			session.file.basename.toLowerCase().includes(normalizedQuery);
	}

	private handleSessionPopoverKeydown(event: KeyboardEvent, containerEl: HTMLElement, query: string): void {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			this.closeSessionPopover();
			this.composerInputEl?.focus();
			return;
		}

		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopPropagation();
			this.moveSessionSelection(1, containerEl, query);
			return;
		}

		if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopPropagation();
			this.moveSessionSelection(-1, containerEl, query);
			return;
		}

		if (event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			const selectedSession = this.sessionResults[this.selectedSessionIndex];
			if (selectedSession) {
				void this.selectSession(selectedSession);
				return;
			}

			this.closeSessionPopover();
			this.composerInputEl?.focus();
		}
	}

	private moveSessionSelection(direction: number, containerEl: HTMLElement, query: string): void {
		if (this.sessionResults.length === 0) {
			return;
		}

		this.selectedSessionIndex = (this.selectedSessionIndex + direction + this.sessionResults.length) % this.sessionResults.length;
		this.renderSessionResults(containerEl, query);
		const selectedEl = containerEl.querySelector<HTMLElement>(".porygon-session-result.is-selected");
		selectedEl?.scrollIntoView({ block: "nearest" });
	}

	private handleSessionPointerDown(event: PointerEvent): void {
		if (!this.sessionPopoverEl) {
			return;
		}

		const target = event.target;
		if (target instanceof Node && this.sessionPopoverEl.contains(target)) {
			return;
		}

		this.closeSessionPopover();
	}

	private closeSlashCommandPopover(): void {
		if (this.slashCommandKeydownHandler) {
			window.removeEventListener("keydown", this.slashCommandKeydownHandler, true);
			this.slashCommandKeydownHandler = null;
		}

		if (this.slashCommandPointerDownHandler) {
			window.removeEventListener("pointerdown", this.slashCommandPointerDownHandler, true);
			this.slashCommandPointerDownHandler = null;
		}

		this.slashCommandPopoverEl?.remove();
		this.slashCommandPopoverEl = null;
		this.filteredSlashCommands = [];
		this.selectedSlashCommandIndex = 0;
	}

	private closeSessionPopover(): void {
		if (this.sessionKeydownHandler) {
			window.removeEventListener("keydown", this.sessionKeydownHandler, true);
			this.sessionKeydownHandler = null;
		}

		if (this.sessionPointerDownHandler) {
			window.removeEventListener("pointerdown", this.sessionPointerDownHandler, true);
			this.sessionPointerDownHandler = null;
		}

		this.sessionPopoverEl?.remove();
		this.sessionPopoverEl = null;
		this.sessionResults = [];
		this.allSessionSummaries = [];
		this.selectedSessionIndex = 0;
	}

	private handleAskUser(payload: AskUserInterruptPayload): Promise<string> {
		return new Promise((resolve) => {
			this.askResolve = resolve;
			if (!this.composerEl) {
				resolve("");
				return;
			}

			this.renderAskUserPopover(this.composerEl, payload);
		});
	}

	private renderAskUserPopover(composerEl: HTMLElement, payload: AskUserInterruptPayload): void {
		this.closeAskUserPopover(false);
		this.closeMentionPopover();
		this.closeSlashCommandPopover();
		this.closeSessionPopover();

		const popover = composerEl.createDiv({ cls: "porygon-ask-popover" });
		this.askPopoverEl = popover;
		const panel = popover.createDiv({ cls: "porygon-ask-panel" });
		panel.createDiv({ cls: "porygon-ask-question", text: payload.question });

		const optionsEl = panel.createDiv({ cls: "porygon-ask-options" });
		const optionButtons: HTMLButtonElement[] = [];
		let selectedIndex = 0;
		const setSelected = (next: number) => {
			selectedIndex = (next + optionButtons.length) % optionButtons.length;
			optionButtons.forEach((btn, i) => btn.toggleClass("is-selected", i === selectedIndex));
		};
		payload.options.forEach((option, index) => {
			const button = optionsEl.createEl("button", {
				cls: "porygon-ask-option",
				attr: { type: "button", title: option, "aria-label": option },
			});
			button.createSpan({ cls: "porygon-ask-option-index", text: String(index + 1) });
			button.createSpan({ cls: "porygon-ask-option-label", text: option });
			button.addEventListener("mouseenter", () => setSelected(index));
			button.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.resolveAskUser(option);
			});
			optionButtons.push(button);
		});
		setSelected(0);

		const inputRow = panel.createDiv({ cls: "porygon-ask-input-row" });
		const inputIcon = inputRow.createDiv({ cls: "porygon-ask-input-icon" });
		setIcon(inputIcon, "pencil");
		const input = inputRow.createEl("input", {
			cls: "porygon-ask-input",
			attr: { type: "text", placeholder: "Something else..." },
		});
		const submitButton = inputRow.createEl("button", {
			cls: "porygon-send-button is-healthy",
			attr: { type: "button", title: "Send reply", "aria-label": "Send reply" },
		});
		setIcon(submitButton, "send-horizontal");

		const submit = () => {
			const value = input.value.trim();
			if (!value) {
				return;
			}
			this.resolveAskUser(value);
		};

		submitButton.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			submit();
		});

		input.addEventListener("keydown", (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				if (input.value.trim()) {
					submit();
				} else {
					const selected = payload.options[selectedIndex];
					if (selected) {
						this.resolveAskUser(selected);
					}
				}
				return;
			}

			if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !input.value) {
				event.preventDefault();
				setSelected(selectedIndex + (event.key === "ArrowDown" ? 1 : -1));
				return;
			}

			if (event.key >= "1" && event.key <= "9" && !input.value) {
				const numeric = Number(event.key);
				if (numeric <= payload.options.length) {
					event.preventDefault();
					const option = payload.options[numeric - 1];
					if (option) {
						this.resolveAskUser(option);
					}
				}
			}
		});

		this.askKeydownHandler = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !this.askPopoverEl) {
				return;
			}

			const target = event.target;
			if (target instanceof HTMLElement && this.askPopoverEl.contains(target)) {
				event.preventDefault();
				event.stopPropagation();
				this.resolveAskUser("User ignored the question/approval");
			}
		};
		window.addEventListener("keydown", this.askKeydownHandler, true);
		input.focus();
	}

	private resolveAskUser(reply: string): void {
		const resolve = this.askResolve;
		this.askResolve = null;
		this.closeAskUserPopover(false);
		resolve?.(reply);
		this.composerInputEl?.focus();
	}

	private closeAskUserPopover(resolveEmpty: boolean): void {
		if (this.askKeydownHandler) {
			window.removeEventListener("keydown", this.askKeydownHandler, true);
			this.askKeydownHandler = null;
		}

		this.askPopoverEl?.remove();
		this.askPopoverEl = null;

		if (resolveEmpty && this.askResolve) {
			const resolve = this.askResolve;
			this.askResolve = null;
			resolve("");
		}
	}

	private getUnavailableMentionPaths(): Set<string> {
		const paths = new Set(this.selectedMentions.map((mention) => mention.path));
		this.messages.forEach((message) => {
			message.mentions?.forEach((mention) => paths.add(mention.path));
		});
		return paths;
	}

	private updateSendButtonState(): void {
		this.updateStreamingIndicator();
		if (!this.sendButtonEl || !this.composerInputEl) {
			return;
		}

		this.sendButtonEl.empty();
		this.sendButtonEl.toggleClass("is-healthy", this.isHealthy);
		this.sendButtonEl.toggleClass("is-unhealthy", !this.isHealthy);
		this.composerEl?.toggleClass("is-unhealthy", !this.isHealthy);
		setIcon(this.sendButtonEl, this.isHealthy ? "send-horizontal" : "unlink");

		const hasMessage = this.composerInputEl.value.trim().length > 0 || this.selectedMentions.length > 0;
		this.sendButtonEl.disabled = !hasMessage || this.isStreaming || this.isCheckingHealth;
		const tooltip = this.getSendButtonTooltip(hasMessage);
		this.sendButtonEl.title = tooltip;
		this.sendButtonEl.ariaLabel = tooltip;
	}

	private updateStreamingIndicator(): void {
		const isActive = this.isStreaming && this.isOnboardingComplete();
		this.contentEl.toggleClass("is-loading", isActive);
	}

	private getSendButtonTooltip(hasMessage: boolean): string {
		if (this.isCheckingHealth) {
			return "Checking Ollama...";
		}

		if (!hasMessage) {
			return "Type a message...";
		}

		return this.isHealthy ? "Send message" : "Ollama is unreachable. Send to retry.";
	}

	private async sendCurrentMessage(): Promise<void> {
		if (!this.composerInputEl || this.isStreaming) {
			return;
		}

		const content = this.composerInputEl.value.trim();
		const mentionSnapshots = [...this.selectedMentions];
		if (!content && mentionSnapshots.length === 0) {
			this.updateSendButtonState();
			return;
		}

		// Don't gate the UI on the health check: showing "Connecting..." can take
		// seconds if Ollama is slow to respond. We kick off the health check in
		// the background to update the indicator; if Ollama is actually
		// unreachable, the agent call below will fail and the catch branch
		// surfaces the error as a warning bubble.
		void this.updateHealthStatus();

		const createdAt = new Date().toISOString();
		this.composerInputEl.value = "";
		this.selectedMentions = [];
		this.renderMentionTags();
		this.closeMentionPopover();
		this.messages.push({ role: "user", content, createdAt, mentions: mentionSnapshots });
		const fileMessages = await this.createFileContextMessages(mentionSnapshots);
		this.messages.push(...fileMessages);
		const porygonMessage: ChatMessage = { role: "porygon", content: "Connecting...", createdAt: new Date().toISOString(), isStreaming: true };
		this.messages.push(porygonMessage);
		this.isStreaming = true;
		this.streamingMessage = porygonMessage;
		this.updateSendButtonState();
		// One reconcile to mount the new user / file / porygon rows. All
		// further per-delta work goes through ChatList.notifyStreamingDelta
		// / notifyChanged and never touches historical rows.
		this.renderMessages();

		if (!this.currentSessionId) {
			this.currentSessionId = crypto.randomUUID();
		}
		const isFirstSendForSession = !this.isSessionMemoryPrimed;
		const agentMessages = isFirstSendForSession
			? this.buildAgentMessages(porygonMessage)
			: this.buildAgentMessagesForLatestTurn(porygonMessage);

		try {
			let thinkingStartedAt: number | null = null;
			let hasStartedStreamingContent = false;
			let hasPlaceholderContent = true;
			const clearPendingAnswerPlaceholder = () => {
				if (!hasStartedStreamingContent && hasPlaceholderContent) {
					porygonMessage.content = "";
					hasPlaceholderContent = false;
					this.chatList?.notifyStreamingDelta(porygonMessage, "content");
				}
			};
			await streamLocalAgent({
				app: this.plugin.app,
				semanticSearch: this.plugin.ragSemanticSearch,
				getIndexProgress: () => this.plugin.ragIndexer.getProgress(),
				getYolo: () => this.plugin.settings.yolo,
				ollamaHost: this.getOllamaBaseUrl(),
				ollamaChatModel: this.plugin.settings.ollamaChatModel,
				ollamaThinking: this.plugin.settings.ollamaThinking,
				personalPrompt: this.plugin.settings.personalPrompt.trim(),
				messages: agentMessages,
				skills: this.plugin.skills,
				sessionId: this.currentSessionId,
				memoriesStore: {
					get: () => this.plugin.settings.memories,
					set: async (raw) => {
						this.plugin.settings.memories = raw;
						await this.plugin.saveSettings();
					},
				},
			}, {
				onToolIntent: (toolIntent) => {
					clearPendingAnswerPlaceholder();
					porygonMessage.toolIntents = [...(porygonMessage.toolIntents ?? []), toolIntent];
					porygonMessage.areToolsCollapsed = false;
					// Structural: routed to this row only, not the whole list.
					this.chatList?.notifyStreamingDelta(porygonMessage, "tool");
				},
				onContentDelta: (delta) => {
					clearPendingAnswerPlaceholder();
					hasStartedStreamingContent = true;
					porygonMessage.content += delta;
					this.chatList?.notifyStreamingDelta(porygonMessage, "content");
				},
				onThinkingDelta: (delta) => {
					clearPendingAnswerPlaceholder();
					thinkingStartedAt = thinkingStartedAt ?? Date.now();
					porygonMessage.thinking = `${porygonMessage.thinking ?? ""}${delta}`;
					porygonMessage.isThinkingCollapsed = false;
					// Routed to this row only. MessageRow materializes the
					// thinking <details> on the first delta automatically.
					this.chatList?.notifyStreamingDelta(porygonMessage, "thinking");
				},
				onAskUser: (payload) => this.handleAskUser(payload),
			});

			this.isSessionMemoryPrimed = true;

			if (porygonMessage.thinking && thinkingStartedAt !== null) {
				porygonMessage.thinkingDurationSeconds = this.getThinkingDurationSeconds(thinkingStartedAt);
				porygonMessage.isThinkingCollapsed = true;
			}
			if (porygonMessage.toolIntents && porygonMessage.toolIntents.length > 0) {
				porygonMessage.areToolsCollapsed = true;
			}
			await this.finalizeStreaming(porygonMessage);
			// Single-row update to switch from "streaming" to "historical"
			// presentation (Thinking... -> Thought for Xs, collapsed bubbles).
			this.chatList?.notifyChanged(porygonMessage);
		} catch (error) {
			await this.finalizeStreaming(porygonMessage);
			this.messages = this.messages.filter((message) => message !== porygonMessage);
			this.messages.push({ role: "warning", content: error instanceof Error ? error.message : String(error) });
			this.renderMessages();
		} finally {
			this.isStreaming = false;
			this.updateSendButtonState();
		}
	}

	// Sync-finalize: drain the row's in-flight rAF render so the post-turn
	// notifyChanged() doesn't race a late delta, then flip isStreaming off.
	// Mirrors open-webui's cancelAnimationFrame + sync parse on done.
	private async finalizeStreaming(message: ChatMessage): Promise<void> {
		if (this.chatList) {
			await this.chatList.finalizeStreaming(message);
		}
		message.isStreaming = false;
		this.streamingMessage = null;
	}

	private getThinkingDurationSeconds(startedAt: number): number {
		return Math.max(1, Math.round((Date.now() - startedAt) / 1000));
	}

	private buildAgentMessages(excludedMessage: ChatMessage): AgentChatMessage[] {
		const messages = this.messages.filter((message): message is ChatMessage & { role: AgentChatMessage["role"] } =>
			(message.role === "user" || message.role === "porygon" || message.role === "file") && message !== excludedMessage,
		);
		return messages.map((message) => ({
			role: message.role,
			content: this.buildAgentMessageContent(message),
		}));
	}

	private buildAgentMessagesForLatestTurn(excludedMessage: ChatMessage): AgentChatMessage[] {
		const allMessages = this.buildAgentMessages(excludedMessage);
		let lastUserIndex = -1;
		for (let index = allMessages.length - 1; index >= 0; index -= 1) {
			if (allMessages[index]?.role === "user") {
				lastUserIndex = index;
				break;
			}
		}
		return lastUserIndex === -1 ? allMessages : allMessages.slice(lastUserIndex);
	}

	private buildAgentMessageContent(message: ChatMessage): string {
		return message.content;
	}

	private async createFileContextMessages(mentions: MentionedItem[]): Promise<ChatMessage[]> {
		const fileMentions = mentions.flatMap((mention) => mention.files);
		return Promise.all(fileMentions.map(async (mentionFile): Promise<ChatMessage> => {
			const file = this.plugin.app.vault.getAbstractFileByPath(mentionFile.path);
			if (!(file instanceof TFile)) {
				return { role: "file", content: `Attached Obsidian file not found: ${mentionFile.path}` };
			}

			const content = await this.plugin.app.vault.cachedRead(file);
			return { role: "file", content: `<file path="${file.path}">\n${content}\n</file>` };
		}));
	}

	private async rehydrateSessionMessages(messages: ChatMessage[], savedMentionPaths: string[]): Promise<ChatMessage[]> {
		const resolvedMentions = this.resolveSavedMentions(savedMentionPaths);
		if (resolvedMentions.length === 0) {
			return messages;
		}

		const firstUserMessage = messages.find((message): message is ChatMessage & { role: "user" } => message.role === "user");
		if (firstUserMessage) {
			firstUserMessage.mentions = resolvedMentions;
		}

		const fileMessages = await this.createFileContextMessages(resolvedMentions);
		const firstUserIndex = firstUserMessage ? messages.indexOf(firstUserMessage) : -1;
		if (firstUserIndex === -1) {
			return [...fileMessages, ...messages];
		}

		return [
			...messages.slice(0, firstUserIndex + 1),
			...fileMessages,
			...messages.slice(firstUserIndex + 1),
		];
	}

	private resolveSavedMentions(paths: string[]): MentionedItem[] {
		return paths.flatMap((path): MentionedItem[] => {
			const resolved = this.resolveSavedMention(path);
			return resolved ? [resolved] : [];
		});
	}

	private resolveSavedMention(path: string): MentionedItem | null {
		const target = this.plugin.app.vault.getAbstractFileByPath(path);
		if (target instanceof TFolder) {
			const files = this.getDirectMarkdownFiles(target).map((file) => this.toMentionedFile(file));
			return { type: "folder", path, basename: target.name, files };
		}

		if (target instanceof TFile) {
			const files = [this.toMentionedFile(target)];
			return { type: "note", path, basename: target.basename, files };
		}

		console.error("Unable to resolve Porygon mention", path);
		return null;
	}

	private async saveSession(): Promise<void> {
		const visibleMessages = this.messages.filter((message): message is ChatMessage & { role: "user" | "porygon" } => message.role === "user" || message.role === "porygon");
		if (visibleMessages.length === 0) {
			this.messages.push({ role: "warning", content: "No session to save." });
			this.renderMessages();
			return;
		}

		try {
			const sessionId = this.currentSessionId ?? crypto.randomUUID();
			const title = await this.getTitleForSave(visibleMessages);
			this.currentSessionId = sessionId;
			this.currentSessionTitle = title;
			const filename = `${PORYGON_SESSIONS_FOLDER}/${sessionId}.md`;
			const content = this.formatSessionForSave(sessionId, title, visibleMessages);
			await this.ensureFolderExists(PORYGON_SESSIONS_FOLDER);
			const existingFile = this.plugin.app.vault.getAbstractFileByPath(filename);

			if (existingFile instanceof TFile) {
				await this.plugin.app.vault.modify(existingFile, content);
			} else {
				await this.plugin.app.vault.create(filename, content);
			}
		} catch (error) {
			this.messages.push({ role: "warning", content: error instanceof Error ? error.message : String(error) });
			this.renderMessages();
		}
	}

	private formatSessionForSave(sessionId: string, title: string, messages: Array<ChatMessage & { role: "user" | "porygon" }>): string {
		const frontmatterData: SessionMetadata = { id: sessionId, title };
		const mentions = this.collectSessionMentions(messages);
		if (mentions.length > 0) {
			frontmatterData.mentions = mentions;
		}
		const frontmatter = stringifyYaml(frontmatterData).trimEnd();
		const messageBlocks = messages.map((message) => this.formatMessageForSave(message));
		return [`${PORYGON_FRONTMATTER_DELIMITER}\n${frontmatter}\n${PORYGON_FRONTMATTER_DELIMITER}`, ...messageBlocks].join("\n\n");
	}

	private collectSessionMentions(messages: ChatMessage[]): string[] {
		const seen = new Set<string>();
		const paths: string[] = [];
		for (const message of messages) {
			if (!message.mentions) {
				continue;
			}

			for (const mention of message.mentions) {
				if (seen.has(mention.path)) {
					continue;
				}

				seen.add(mention.path);
				paths.push(mention.path);
			}
		}
		return paths;
	}

	private async getTitleForSave(messages: ChatMessage[]): Promise<string> {
		if (this.currentSessionTitle.trim()) {
			return this.currentSessionTitle.trim();
		}

		const userMessages = messages
			.filter((message) => message.role === "user")
			.map((message) => message.content.trim())
			.filter((content) => content.length > 0);
		if (userMessages.length === 0) {
			return "";
		}

		try {
			return this.sanitizeGeneratedSessionTitle(await generateSessionTitle({
				ollamaHost: this.getOllamaBaseUrl(),
				ollamaChatModel: this.plugin.settings.ollamaChatModel,
				userMessages,
			})) || this.getFallbackSessionTitle(messages);
		} catch (error) {
			console.error("Unable to generate Porygon session title", error);
			return this.getFallbackSessionTitle(messages);
		}
	}

	private sanitizeGeneratedSessionTitle(title: string): string {
		return title
			.trim()
			.replace(/^['"`]+|['"`]+$/g, "")
			.replace(/\s+/g, " ")
			.split(" ")
			.slice(0, 6)
			.join(" ");
	}

	private getFallbackSessionTitle(messages: ChatMessage[]): string {
		const firstUserMessage = messages.find((message) => message.role === "user" && message.content.trim().length > 0);
		return firstUserMessage?.content.trim().replace(/\s+/g, " ").slice(0, 30) ?? "";
	}

	private formatMessageForSave(message: ChatMessage & { role: "user" | "porygon" }): string {
		const label = message.role === "user" ? "User" : "Porygon";
		return `${label}: \n${message.content}`;
	}

	private async selectSession(session: SessionSummary): Promise<void> {
		this.closeSessionPopover();
		if (this.hasConversationContent()) {
			const decision = await this.confirmSaveBeforeNewConversation();
			if (decision === "cancel") {
				this.composerInputEl?.focus();
				return;
			}

			if (decision === "yes") {
				await this.saveSession();
			}
		}

		await this.loadSession(session.file);
	}

	private async loadSession(file: TFile): Promise<void> {
		try {
			const content = await this.plugin.app.vault.cachedRead(file);
			const parsed = this.parseSession(content);
			const nextSessionId = parsed.metadata.id ?? file.basename;
			if (this.currentSessionId && this.currentSessionId !== nextSessionId) {
				void clearAgentMemory(this.currentSessionId);
			}
			this.currentSessionId = nextSessionId;
			this.currentSessionTitle = parsed.metadata.title ?? "";
			this.isSessionMemoryPrimed = false;
			this.messages = await this.rehydrateSessionMessages(parsed.messages, parsed.metadata.mentions ?? []);
			this.selectedMentions = [];
			if (this.composerInputEl) {
				this.composerInputEl.value = "";
			}
			this.renderMentionTags();
			this.closeMentionPopover();
			this.closeSlashCommandPopover();
			this.updateSendButtonState();
			this.renderMessages();
			this.composerInputEl?.focus();
		} catch (error) {
			this.messages.push({ role: "warning", content: error instanceof Error ? error.message : String(error) });
			this.renderMessages();
		}
	}

	private parseSession(content: string): ParsedSession {
		const { metadata, body } = this.extractSessionMetadata(content);
		const messages = this.parseSessionMessages(body);
		return { metadata, messages };
	}

	private extractSessionMetadata(content: string): { metadata: SessionMetadata; body: string } {
		const info = getFrontMatterInfo(content);
		if (!info.exists) {
			return { metadata: {}, body: content };
		}

		const body = content.slice(info.contentStart).replace(/^\n+/, "");
		return { metadata: this.parseSessionFrontmatter(info.frontmatter), body };
	}

	private parseSessionFrontmatter(yaml: string): SessionMetadata {
		try {
			const parsed: unknown = parseYaml(yaml);
			return this.toSessionMetadata(parsed);
		} catch (error) {
			console.error("Unable to parse Porygon session frontmatter", error);
			return {};
		}
	}

	private toSessionMetadata(value: unknown): SessionMetadata {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return {};
		}

		const record = value as Record<string, unknown>;
		const metadata: SessionMetadata = {};
		if (typeof record.id === "string") {
			metadata.id = record.id;
		}
		if (typeof record.title === "string") {
			metadata.title = record.title;
		}
		const mentions = this.toSavedMentions(record.mentions);
		if (mentions.length > 0) {
			metadata.mentions = mentions;
		}
		return metadata;
	}

	private toSavedMentions(value: unknown): string[] {
		if (!Array.isArray(value)) {
			return [];
		}

		return value.flatMap((entry): string[] => (typeof entry === "string" && entry.length > 0 ? [entry] : []));
	}

	private parseSessionMessages(body: string): ChatMessage[] {
		const lines = body.split("\n");
		const messages: ChatMessage[] = [];
		let currentMessage: ChatMessage | null = null;

		const flushCurrentMessage = () => {
			if (!currentMessage) {
				return;
			}

			currentMessage.content = currentMessage.content.replace(/\n$/, "");
			messages.push(currentMessage);
			currentMessage = null;
		};

		for (const line of lines) {
			if (line === "User:" || line === "User: ") {
				flushCurrentMessage();
				currentMessage = { role: "user", content: "" };
				continue;
			}

			if (line.startsWith("User: ") && !currentMessage) {
				flushCurrentMessage();
				currentMessage = { role: "user", content: line.slice("User: ".length) };
				continue;
			}

			if (line === "Porygon:" || line === "Porygon: ") {
				flushCurrentMessage();
				currentMessage = { role: "porygon", content: "" };
				continue;
			}

			if (line.startsWith("Porygon: ") && !currentMessage) {
				flushCurrentMessage();
				currentMessage = { role: "porygon", content: line.slice("Porygon: ".length) };
				continue;
			}

			if (currentMessage !== null) {
				const existingContent = currentMessage.content;
				currentMessage.content = `${existingContent}${existingContent ? "\n" : ""}${line}`;
			}
		}

		flushCurrentMessage();
		return messages;
	}

	private async ensureFolderExists(path: string): Promise<void> {
		const existingFolder = this.plugin.app.vault.getAbstractFileByPath(path);
		if (existingFolder instanceof TFolder) {
			return;
		}

		await this.plugin.app.vault.adapter.mkdir(path);
	}

	private toMentionedItem(result: MentionSearchResult): MentionedItem {
		return {
			type: result.type,
			path: result.path,
			basename: result.type === "active-note" ? result.files[0]?.basename ?? result.label : result.path.split("/").last() ?? result.label,
			files: result.files.map((file) => this.toMentionedFile(file)),
		};
	}

	private toMentionedFile(file: TFile): MentionedFile {
		return { path: file.path, basename: file.basename };
	}

	private getMentionIcon(type: MentionType): string {
		if (type === "folder") {
			return "folder";
		}

		if (type === "active-note") {
			return "star";
		}

		return "sticky-note";
	}

	private scrollChatToBottom(): void {
		if (!this.chatHistoryEl) {
			return;
		}

		this.chatHistoryEl.scrollTop = this.chatHistoryEl.scrollHeight;
	}

	private async updateHealthStatus(): Promise<boolean> {
		try {
			await this.createOllamaClient().version();
			this.isHealthy = true;
		} catch {
			this.isHealthy = false;
		}

		this.updateSendButtonState();
		return this.isHealthy;
	}

	private setLoading(button: HTMLButtonElement, isLoading: boolean, loadingText = "Saving..."): void {
		button.disabled = isLoading;
		button.setText(isLoading ? loadingText : "Next");
	}

	private getCurrentStepIndex(): number {
		if (this.screen === "ollamaHost") {
			return 0;
		}

		if (this.screen === "ollamaChatModel") {
			return 1;
		}

		if (this.screen === "ollamaEmbeddingModel") {
			return 2;
		}

		return 3;
	}

	private getInitialScreen(): OnboardingScreen {
		if (!this.plugin.settings.ollamaHost) {
			return "welcome";
		}

		if (!this.plugin.settings.ollamaChatModel) {
			return "ollamaChatModel";
		}

		if (!this.plugin.settings.ollamaEmbeddingModel) {
			return "ollamaEmbeddingModel";
		}

		if (!this.plugin.settings.experience) {
			return "experience";
		}

		return "experience";
	}

	private isStepComplete(stepKey: OnboardingSettingKey): boolean {
		return Boolean(this.plugin.settings[stepKey]);
	}

	private isOnboardingComplete(): boolean {
		return Boolean(
			this.plugin.settings.ollamaHost &&
			this.plugin.settings.ollamaChatModel &&
			this.plugin.settings.ollamaEmbeddingModel &&
			this.plugin.settings.experience
		);
	}
}

class SaveBeforeNewConversationModal extends Modal {
	private plugin: PorygonPlugin;
	private resolve: (decision: "yes" | "no" | "cancel") => void;
	private didChoose = false;

	constructor(plugin: PorygonPlugin, resolve: (decision: "yes" | "no" | "cancel") => void) {
		super(plugin.app);
		this.plugin = plugin;
		this.resolve = resolve;
	}

	onOpen(): void {
		this.setTitle("Start a new conversation?");
		this.contentEl.empty();
		this.contentEl.createEl("p", { text: "Do you want to save your conversation before starting a new one?" });
		const actionsEl = this.contentEl.createDiv({ cls: "porygon-confirm-actions" });
		this.createDecisionButton(actionsEl, "Yes", "yes", "mod-cta");
		this.createDecisionButton(actionsEl, "No", "no");
		this.createDecisionButton(actionsEl, "Cancel", "cancel");
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.didChoose) {
			this.resolve("cancel");
		}
	}

	private createDecisionButton(containerEl: HTMLElement, label: string, decision: "yes" | "no" | "cancel", extraClass = ""): void {
		const button = containerEl.createEl("button", {
			cls: extraClass,
			text: label,
		});
		button.addEventListener("click", () => {
			this.didChoose = true;
			this.resolve(decision);
			this.close();
		});
	}
}
