import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { getFrontMatterInfo } from "obsidian";
import { RagBuildChunksInput, RagMarkdownChunk } from "./types";

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 200;

export async function buildMarkdownChunks(input: RagBuildChunksInput): Promise<RagMarkdownChunk[]> {
	const splitter = new RecursiveCharacterTextSplitter({
		chunkSize: input.chunkSize ?? DEFAULT_CHUNK_SIZE,
		chunkOverlap: input.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP,
	});
	const text = stripFrontmatter(input.content).trim();
	if (!text) {
		return [];
	}

	const chunks = await splitter.splitText(text);
	return chunks.map((chunk, index) => ({
		id: createChunkId(input.path, index),
		path: input.path,
		chunkIndex: index,
		text: chunk,
		title: input.basename,
		mtime: input.mtime,
		size: input.size,
	}));
}

export function createChunkId(path: string, chunkIndex: number): string {
	return `${path}#${chunkIndex}`;
}

export function stripFrontmatter(content: string): string {
	const info = getFrontMatterInfo(content);
	return info.exists ? content.slice(info.contentStart) : content;
}
