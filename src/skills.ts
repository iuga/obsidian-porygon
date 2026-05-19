import { App, normalizePath, TAbstractFile, TFile, TFolder } from "obsidian";
import summarizerSkill from "../skills/summarizer.md";

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
	frontmatter: Record<string, string>;
	content: string;
}

const SKILLS_FOLDER = "porygon/skills";
const BUNDLED_SKILLS: BundledSkill[] = [
	{ filename: "summarizer.md", content: summarizerSkill },
];

export class SkillsService {
	private skills: AgentSkill[] = [];
	private initialized = false;

	constructor(private readonly app: App) {}

	async initialize(): Promise<void> {
		await ensureBundledSkills(this.app);
		await this.refresh();
		this.initialized = true;
	}

	getSkills(): AgentSkill[] {
		return this.skills;
	}

	isManagedPath(path: string): boolean {
		return path === SKILLS_FOLDER || path.startsWith(`${SKILLS_FOLDER}/`);
	}

	async refresh(): Promise<void> {
		this.skills = await discoverSkills(this.app);
		console.debug("[Porygon Skills] refreshed", { count: this.skills.length, skills: this.skills.map((skill) => skill.location) });
	}

	async refreshIfManaged(file: TAbstractFile, oldPath?: string): Promise<void> {
		if (!this.initialized) {
			return;
		}

		if (this.isManagedPath(file.path) || (oldPath && this.isManagedPath(oldPath))) {
			await this.refresh();
		}
	}

	async loadSkillContent(location: string): Promise<string> {
		const normalizedLocation = normalizePath(location);
		if (!this.skills.some((skill) => skill.location === normalizedLocation)) {
			return `Skill not found: ${location}. Use only exact locations from <available_skills>.`;
		}

		const file = this.app.vault.getAbstractFileByPath(normalizePath(`${SKILLS_FOLDER}/${normalizedLocation}`));
		if (!(file instanceof TFile)) {
			return `Skill not found: ${location}. Use only exact locations from <available_skills>.`;
		}

		const rawContent = await this.app.vault.cachedRead(file);
		return parseSkillMarkdown(rawContent).content.trim();
	}
}

export function buildAvailableSkillsPrompt(skills: AgentSkill[]): string {
	if (skills.length === 0) {
		return "";
	}

	let message = "<available_skills>\n";
	for (const skill of skills) {
		message += "  <skill>\n";
		message += `    <name>${escapeXml(skill.name)}</name>\n`;
		message += `    <description>${escapeXml(skill.description)}</description>\n`;
		message += `    <location>${escapeXml(skill.location)}</location>\n`;
		message += "  </skill>\n";
	}
	message += "</available_skills>";
	return message;
}

async function ensureBundledSkills(app: App): Promise<void> {
	await ensureFolder(app, SKILLS_FOLDER);

	for (const skill of BUNDLED_SKILLS) {
		const path = normalizePath(`${SKILLS_FOLDER}/${skill.filename}`);
		if (app.vault.getAbstractFileByPath(path)) {
			continue;
		}

		try {
			await app.vault.create(path, skill.content);
		} catch (error) {
			if (app.vault.getAbstractFileByPath(path) instanceof TFile || String(error).contains("File already exists")) {
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
		const name = parsedSkill.frontmatter.name?.trim();
		const description = parsedSkill.frontmatter.description?.trim();
		if (!name || !description) {
			continue;
		}

		skills.push({
			name,
			description,
			location: child.name,
		});
	}

	return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
	const normalizedContent = content.replace(/^\uFEFF/, "");
	const match = normalizedContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) {
		return { frontmatter: {}, content: normalizedContent };
	}

	return {
		frontmatter: parseFrontmatter(match[1] ?? ""),
		content: normalizedContent.slice(match[0].length),
	};
}

function parseFrontmatter(content: string): Record<string, string> {
	const frontmatter: Record<string, string> = {};
	let currentKey: string | null = null;

	for (const line of content.split(/\r?\n/)) {
		const keyValueMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (keyValueMatch) {
			const key = keyValueMatch[1] ?? "";
			const value = keyValueMatch[2] ?? "";
			frontmatter[key] = unquoteYamlString(value.trim());
			currentKey = key;
			continue;
		}

		if (currentKey && /^\s+/.test(line)) {
			frontmatter[currentKey] = `${frontmatter[currentKey]} ${line.trim()}`.trim();
		}
	}

	return frontmatter;
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
		if (app.vault.getAbstractFileByPath(normalizedFolderPath) instanceof TFolder || String(error).contains("Folder already exists")) {
			return;
		}

		throw error;
	}
}

function unquoteYamlString(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}

	return value;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
