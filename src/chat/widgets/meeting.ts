import { normalizePath, setIcon, TFolder } from "obsidian";
import { WidgetContext, WidgetDescriptor } from "./types";

/**
 * AI Meeting Notes widgets (mockup).
 *
 * `meeting` renders an interactive recorder card with two tabs
 * (Transcript / Summary) and Start / Pause / Stop controls. Recording and
 * summarization are not implemented yet: the state machine, tab switching
 * and UI states are fully wired so the real capture/transcription pipeline
 * can plug into `startRecording` / `stopRecording` later.
 *
 * `meetings` lists previously recorded meetings stored under the folder
 * given by the `folder` attribute ({porygonFolder}/meetings).
 */

type MeetingTab = "transcript" | "summary";
type RecorderState = "idle" | "recording" | "paused" | "stopped";

interface TranscriptEntry {
	speaker: "user" | "others";
	text: string;
}

// Placeholder transcript shown while the real capture pipeline is not
// implemented. Demonstrates the "user" vs "others" conversation layout.
const MOCK_TRANSCRIPT: TranscriptEntry[] = [
	{ speaker: "others", text: "Hey, hello! Good morning everyone." },
	{ speaker: "user", text: "Good morning! Let's wait a minute for the rest to join." },
	{ speaker: "others", text: "Sure. Okay, I think we can start. Today I want to go over the recommendation flows and, if we have time, the email campaigns." },
	{ speaker: "user", text: "Sounds good. Please share your screen whenever you're ready." },
];

const MOCK_SUMMARY_PLACEHOLDER = "The AI summary of key points, decisions, and action items will appear here after the meeting ends.";
const CONSENT_TEXT = "By starting, you confirm everyone being recorded has given consent.";

export function renderMeetingWidget(containerEl: HTMLElement, descriptor: WidgetDescriptor, ctx: WidgetContext): void {
	const title = (descriptor.attrs.title ?? "").trim() || "Meeting";
	const startedAt = (descriptor.attrs.date ?? "").trim() || window.moment().format("MMM D, YYYY");

	let state: RecorderState = "idle";
	let activeTab: MeetingTab = "transcript";
	let elapsedSeconds = 0;
	let timerHandle: number | null = null;

	const widgetEl = containerEl.createDiv({ cls: "porygon-widget porygon-widget-meeting" });

	// Header: icon + title + date.
	const headerEl = widgetEl.createDiv({ cls: "porygon-meeting-header" });
	const headerIconEl = headerEl.createSpan({ cls: "porygon-meeting-header-icon" });
	setIcon(headerIconEl, "audio-lines");
	headerEl.createSpan({ cls: "porygon-meeting-title", text: title });
	headerEl.createSpan({ cls: "porygon-meeting-date", text: `@${startedAt}` });

	// Toolbar: tabs, waveform, timer, controls.
	const toolbarEl = widgetEl.createDiv({ cls: "porygon-meeting-toolbar" });

	const tabsEl = toolbarEl.createDiv({ cls: "porygon-meeting-tabs" });
	const transcriptTabBtn = createTabButton(tabsEl, "mic", "Transcript");
	const summaryTabBtn = createTabButton(tabsEl, "list-checks", "Summary");

	const waveEl = toolbarEl.createDiv({ cls: "porygon-meeting-wave", attr: { "aria-hidden": "true" } });
	for (let i = 0; i < 24; i++) {
		waveEl.createSpan({ cls: "porygon-meeting-wave-bar" });
	}

	const timerEl = toolbarEl.createSpan({ cls: "porygon-meeting-timer", text: "" });

	const controlsEl = toolbarEl.createDiv({ cls: "porygon-meeting-controls" });
	const startBtn = controlsEl.createEl("button", { cls: "porygon-meeting-btn is-start", text: "Start transcribing", attr: { type: "button" } });
	const pauseBtn = controlsEl.createEl("button", { cls: "porygon-meeting-btn is-pause", text: "Pause", attr: { type: "button" } });
	const stopBtn = controlsEl.createEl("button", { cls: "porygon-meeting-btn is-stop", text: "Stop", attr: { type: "button" } });

	// Body: one panel per tab.
	const bodyEl = widgetEl.createDiv({ cls: "porygon-meeting-body" });
	const transcriptPanelEl = bodyEl.createDiv({ cls: "porygon-meeting-panel is-transcript" });
	const summaryPanelEl = bodyEl.createDiv({ cls: "porygon-meeting-panel is-summary" });

	// Footer: consent note.
	const footerEl = widgetEl.createDiv({ cls: "porygon-meeting-footer" });
	footerEl.createSpan({ cls: "porygon-meeting-consent", text: CONSENT_TEXT });

	const formatElapsed = (): string => {
		const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, "0");
		const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");
		return `${minutes}:${seconds}`;
	};

	const clearTimer = () => {
		if (timerHandle !== null) {
			window.clearInterval(timerHandle);
			timerHandle = null;
		}
	};

	const startTimer = () => {
		clearTimer();
		timerHandle = window.setInterval(() => {
			elapsedSeconds += 1;
			timerEl.setText(formatElapsed());
		}, 1000);
		ctx.component.register(() => clearTimer());
	};

	const renderTranscript = () => {
		transcriptPanelEl.empty();
		if (state === "idle") {
			transcriptPanelEl.createDiv({
				cls: "porygon-meeting-empty",
				text: "Select \"Start transcribing\" to capture audio from your microphone and system audio. The conversation will appear here.",
			});
			return;
		}
		for (const entry of MOCK_TRANSCRIPT) {
			const entryEl = transcriptPanelEl.createDiv({ cls: `porygon-meeting-entry is-${entry.speaker}` });
			const speakerEl = entryEl.createDiv({ cls: "porygon-meeting-entry-speaker" });
			const speakerIconEl = speakerEl.createSpan({ cls: "porygon-meeting-entry-icon" });
			setIcon(speakerIconEl, entry.speaker === "user" ? "user" : "audio-lines");
			speakerEl.createSpan({ text: entry.speaker === "user" ? "You" : "Others" });
			entryEl.createDiv({ cls: "porygon-meeting-entry-text", text: entry.text });
		}
	};

	const renderSummary = () => {
		summaryPanelEl.empty();
		if (state !== "stopped") {
			summaryPanelEl.createDiv({ cls: "porygon-meeting-empty", text: MOCK_SUMMARY_PLACEHOLDER });
			return;
		}
		summaryPanelEl.createDiv({
			cls: "porygon-meeting-empty",
			text: "Summary generation is not available yet. Once implemented, the AI will produce key points, decisions, and action items from the transcript.",
		});
	};

	const renderTabs = () => {
		transcriptTabBtn.toggleClass("is-active", activeTab === "transcript");
		summaryTabBtn.toggleClass("is-active", activeTab === "summary");
		transcriptPanelEl.toggle(activeTab === "transcript");
		summaryPanelEl.toggle(activeTab === "summary");
	};

	const renderControls = () => {
		startBtn.toggle(state === "idle" || state === "paused" || state === "stopped");
		startBtn.setText(state === "paused" ? "Resume" : state === "stopped" ? "Record again" : "Start transcribing");
		pauseBtn.toggle(state === "recording");
		stopBtn.toggle(state === "recording" || state === "paused");
		widgetEl.toggleClass("is-recording", state === "recording");
		timerEl.setText(state === "idle" ? "" : formatElapsed());
	};

	const render = () => {
		renderTabs();
		renderControls();
		renderTranscript();
		renderSummary();
	};

	startBtn.addEventListener("click", () => {
		if (state === "stopped") {
			elapsedSeconds = 0;
		}
		state = "recording";
		startTimer();
		render();
	});

	pauseBtn.addEventListener("click", () => {
		state = "paused";
		clearTimer();
		render();
	});

	stopBtn.addEventListener("click", () => {
		state = "stopped";
		clearTimer();
		activeTab = "summary";
		render();
	});

	transcriptTabBtn.addEventListener("click", () => {
		activeTab = "transcript";
		renderTabs();
	});

	summaryTabBtn.addEventListener("click", () => {
		activeTab = "summary";
		renderTabs();
	});

	render();
}

export function renderMeetingsWidget(containerEl: HTMLElement, descriptor: WidgetDescriptor, ctx: WidgetContext): void {
	const folderPath = (descriptor.attrs.folder ?? "").trim();

	const widgetEl = containerEl.createDiv({ cls: "porygon-widget porygon-widget-meetings" });
	const headerEl = widgetEl.createDiv({ cls: "porygon-meeting-header" });
	const headerIconEl = headerEl.createSpan({ cls: "porygon-meeting-header-icon" });
	setIcon(headerIconEl, "calendar-clock");
	headerEl.createSpan({ cls: "porygon-meeting-title", text: "Recorded meetings" });

	const listEl = widgetEl.createDiv({ cls: "porygon-meetings-list" });

	const folder = folderPath ? ctx.app.vault.getAbstractFileByPath(normalizePath(folderPath)) : null;
	const files = folder instanceof TFolder
		? folder.children
			.filter((child) => !(child instanceof TFolder))
			.sort((a, b) => b.name.localeCompare(a.name))
		: [];

	if (files.length === 0) {
		listEl.createDiv({ cls: "porygon-meeting-empty", text: "No meetings recorded yet. Use /meeting to record your first one." });
		return;
	}

	for (const file of files) {
		const itemEl = listEl.createEl("a", {
			cls: "porygon-meetings-item",
			attr: { "data-href": file.path, "aria-label": file.name, role: "link", tabindex: "0" },
		});
		const iconEl = itemEl.createSpan({ cls: "porygon-meetings-item-icon" });
		setIcon(iconEl, "audio-lines");
		itemEl.createSpan({ cls: "porygon-meetings-item-name", text: file.name.replace(/\.md$/, "") });
		itemEl.addEventListener("click", (event) => {
			event.preventDefault();
			ctx.openLink(file.path, event.ctrlKey || event.metaKey);
		});
	}
}

function createTabButton(containerEl: HTMLElement, icon: string, label: string): HTMLButtonElement {
	const btn = containerEl.createEl("button", { cls: "porygon-meeting-tab", attr: { type: "button" } });
	const iconEl = btn.createSpan({ cls: "porygon-meeting-tab-icon" });
	setIcon(iconEl, icon);
	btn.createSpan({ text: label });
	return btn;
}
