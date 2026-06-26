import { App } from "obsidian";
import { RagIndexProgress, RagSemanticSearchService } from "../../rag";
import { MemoriesStore } from "../memories";
import { SkillsService } from "../skills";
import { createActiveFileTool } from "./active-file";
import { askUserTool } from "./ask-user";
import { createBacklinksTool } from "./backlinks";
import { createCopyTool } from "./copy";
import { createCreateFolderTool } from "./create-folder";
import { createEditTool } from "./edit";
import { createListTool } from "./list";
import { createLoadSkillTool } from "./load-skill";
import { createRenameTool } from "./rename";
import { createSaveMemoryTool } from "./save-memory";
import { createSearchTool } from "./search";
import { createViewTool } from "./view";

export type { AskUserInterruptPayload } from "./shared";

export function createAgentTools(
	app: App,
	semanticSearch: RagSemanticSearchService,
	getIndexProgress: () => RagIndexProgress,
	skills: SkillsService,
	getYolo: () => boolean,
	memoriesStore: MemoriesStore,
) {
	return [
		createSearchTool(app, semanticSearch, getIndexProgress),
		createListTool(app),
		createViewTool(app),
		createEditTool(app, getYolo),
		createRenameTool(app, getYolo),
		createCreateFolderTool(app, getYolo),
		createCopyTool(app),
		createActiveFileTool(app),
		createBacklinksTool(app),
		createLoadSkillTool(skills),
		createSaveMemoryTool(memoriesStore),
		askUserTool,
	];
}
