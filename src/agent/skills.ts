import { App, debounce, Debouncer, getFrontMatterInfo, normalizePath, parseYaml, TAbstractFile, TFile, TFolder } from "obsidian";
import summarizerSkill from "../../skills/summarizer.md";
import explainerSkill from "../../skills/explainer.md";

export interface AgentSkill {
	name: string;
	description: string;
	location: string;
}

interface BundledSkill {
	filename: string;
	content: string;
}

interface ParsedSkillMarkdown {
	frontmatter: Record<string, unknown>;
	content: string;
}

const SKILLS_FOLDER = "porygon/skills";
const REFRESH_DEBOUNCE_MS = 400;
const BUNDLED_SKILLS: BundledSkill[] = [
	{ filename: "summarizer.md", content: summarizerSkill },
	{ filename: "explainer.md", content: explainerSkill},
];

export class SkillsService {
	private skills: AgentSkill[] = [];
	private initialized = false;
	private debouncedRefresh: Debouncer<[], void>;

	constructor(private readonly app: App) {
		this.debouncedRefresh = debounce(() => { void this.refresh(); }, REFRESH_DEBOUNCE_MS, true);
	}

	async initialize(): Promise<void> {
		await ensureBundledSkills(this.app);
		await this.refresh();
		this.initialized = true;
	}

	getSkills(): readonly AgentSkill[] {
		return this.skills;
	}

	isManagedPath(path: string): boolean {
		return path === SKILLS_FOLDER || path.startsWith(`${SKILLS_FOLDER}/`);
	}

	async refresh(): Promise<void> {
		this.skills = await discoverSkills(this.app);
		console.debug("[Porygon Skills] refreshed", { count: this.skills.length, skills: this.skills.map((skill) => skill.location) });
	}

	refreshIfManaged(file: TAbstractFile, oldPath?: string): void {
		if (!this.initialized) {
			return;
		}

		const touchesSkills = this.isManagedPath(file.path) || (oldPath !== undefined && this.isManagedPath(oldPath));
		if (!touchesSkills) {
			return;
		}

		this.debouncedRefresh();
	}

	async loadSkillContent(location: string): Promise<string> {
		const normalizedLocation = normalizePath(location);
		const skill = this.skills.find((candidate) => candidate.location === normalizedLocation);
		if (!skill) {
			return `Skill not found: ${location}. Use only exact locations from <available_skills>.`;
		}

		const file = this.app.vault.getAbstractFileByPath(skill.location);
		if (!(file instanceof TFile)) {
			return `Skill not found: ${location}. Use only exact locations from <available_skills>.`;
		}

		const rawContent = await this.app.vault.cachedRead(file);
		return parseSkillMarkdown(rawContent).content.trim();
	}
}

export function buildAvailableSkillsPrompt(skills: readonly AgentSkill[]): string {
	if (skills.length === 0) {
		return "";
	}

	const body = skills
		.map((skill) => [
			"  <skill>",
			`    <name>${escapeXml(skill.name)}</name>`,
			`    <description>${escapeXml(skill.description)}</description>`,
			`    <location>${escapeXml(skill.location)}</location>`,
			"  </skill>",
		].join("\n"))
		.join("\n");

	return `<available_skills>\n${body}\n</available_skills>`;
}

async function ensureBundledSkills(app: App): Promise<void> {
	const normalizedFolderPath = normalizePath(SKILLS_FOLDER);
	const folderExistedBefore = app.vault.getAbstractFileByPath(normalizedFolderPath) instanceof TFolder;

	await ensureFolder(app, SKILLS_FOLDER);

	// Only seed bundled skills on first run. If the user deletes a bundled
	// skill after that, we respect their choice and don't re-create it.
	if (folderExistedBefore) {
		return;
	}

	for (const skill of BUNDLED_SKILLS) {
		const path = normalizePath(`${SKILLS_FOLDER}/${skill.filename}`);
		if (app.vault.getAbstractFileByPath(path)) {
			continue;
		}

		try {
			await app.vault.create(path, skill.content);
		} catch (error) {
			// Race or pre-existing file: treat as no-op.
			if (app.vault.getAbstractFileByPath(path) instanceof TFile) {
				continue;
			}

			throw error;
		}
	}
}

async function discoverSkills(app: App): Promise<AgentSkill[]> {
	const folder = app.vault.getAbstractFileByPath(SKILLS_FOLDER);
	if (!(folder instanceof TFolder)) {
		return [];
	}

	const skills: AgentSkill[] = [];
	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") {
			continue;
		}

		const rawContent = await app.vault.cachedRead(child);
		const parsedSkill = parseSkillMarkdown(rawContent);
		const rawName = parsedSkill.frontmatter.name;
		const rawDescription = parsedSkill.frontmatter.description;
		const name = typeof rawName === "string" ? rawName.trim() : "";
		const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
		if (!name || !description) {
			continue;
		}

		skills.push({
			name,
			description,
			location: child.path,
		});
	}

	return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
	const normalizedContent = content.replace(/^\uFEFF/, "");
	const info = getFrontMatterInfo(normalizedContent);
	if (!info.exists) {
		return { frontmatter: {}, content: normalizedContent };
	}

	let frontmatter: Record<string, unknown> = {};
	try {
		const parsed: unknown = parseYaml(info.frontmatter);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch (error) {
		console.warn("[Porygon Skills] failed to parse skill frontmatter", error);
	}

	return {
		frontmatter,
		content: normalizedContent.slice(info.contentStart),
	};
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
	const normalizedFolderPath = normalizePath(folderPath);
	const existingFolder = app.vault.getAbstractFileByPath(normalizedFolderPath);
	if (existingFolder instanceof TFolder) {
		return;
	}

	if (existingFolder) {
		throw new Error(`Cannot create folder because a file already exists at ${normalizedFolderPath}`);
	}

	const parentPath = normalizedFolderPath.split("/").slice(0, -1).join("/");
	if (parentPath) {
		await ensureFolder(app, parentPath);
	}

	try {
		await app.vault.createFolder(normalizedFolderPath);
	} catch (error) {
		// Race or pre-existing folder: treat as no-op.
		if (app.vault.getAbstractFileByPath(normalizedFolderPath) instanceof TFolder) {
			return;
		}

		throw error;
	}
}

// XML escaping for text nodes only. Attribute values are not used in the
// generated prompt, so quotes don't need escaping here.
function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
