export type MemoryImportance = "high" | "medium" | "low";

export interface Memory {
	id: string;
	timestamp: string;
	importance: MemoryImportance;
	content: string;
}

export interface MemoriesStore {
	get(): string;
	set(raw: string): Promise<void>;
}

export interface SaveMemoryInput {
	content: string;
	importance: MemoryImportance;
	id?: string;
}

export const DEFAULT_MEMORIES = "<memories>\n</memories>";

const MAX_MEMORIES_IN_PROMPT = 50;
const MEMORY_LINE = /^\[([0-9a-f]+)\]\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+\[(high|medium|low)\]\s+(.+)$/;
const IMPORTANCE_RANK: Record<MemoryImportance, number> = { high: 3, medium: 2, low: 1 };

export function parseMemories(raw: string): Memory[] {
	const memories: Memory[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const match = MEMORY_LINE.exec(line.trim());
		if (!match) {
			continue;
		}
		const [, id, timestamp, importance, content] = match;
		memories.push({ id: id!, timestamp: timestamp!, importance: importance as MemoryImportance, content: content! });
	}
	return memories;
}

export function serializeMemories(memories: Memory[]): string {
	const body = sortMemories(memories).map(formatMemoryLine).join("\n");
	return body ? `<memories>\n${body}\n</memories>` : DEFAULT_MEMORIES;
}

export function sanitizeMemories(raw: string): string {
	return serializeMemories(parseMemories(raw));
}

export function buildMemoryPromptBlock(raw: string): string {
	const sorted = sortMemories(parseMemories(raw));
	const included = sorted.slice(0, MAX_MEMORIES_IN_PROMPT);
	const omitted = sorted.length - included.length;
	const lines = included.map(formatMemoryLine);
	if (omitted > 0) {
		lines.push(`[note] ${omitted} older memories omitted due to prompt limit.`);
	}
	return lines.length > 0 ? `<memories>\n${lines.join("\n")}\n</memories>` : DEFAULT_MEMORIES;
}

export function applyMemoryChange(raw: string, input: SaveMemoryInput): { raw: string; message: string } {
	const memories = parseMemories(raw);
	const trimmedContent = input.content.trim();

	if (input.id) {
		const index = memories.findIndex((memory) => memory.id === input.id);
		if (index === -1) {
			throw new Error(`Memory not found: ${input.id}`);
		}
		if (trimmedContent === "") {
			memories.splice(index, 1);
			return { raw: serializeMemories(memories), message: `Deleted memory ${input.id}` };
		}
		memories[index] = { id: input.id, timestamp: nowTimestampUtc(), importance: input.importance, content: trimmedContent };
		return { raw: serializeMemories(memories), message: `Updated memory ${input.id}` };
	}

	if (trimmedContent === "") {
		throw new Error("Cannot create a memory with empty content.");
	}
	const id = generateMemoryId();
	memories.push({ id, timestamp: nowTimestampUtc(), importance: input.importance, content: trimmedContent });
	return { raw: serializeMemories(memories), message: `Saved memory ${id}` };
}

function sortMemories(memories: Memory[]): Memory[] {
	return [...memories].sort((a, b) => {
		const rank = IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance];
		if (rank !== 0) {
			return rank;
		}
		return b.timestamp.localeCompare(a.timestamp);
	});
}

function formatMemoryLine(memory: Memory): string {
	return `[${memory.id}] ${memory.timestamp} [${memory.importance}] ${memory.content}`;
}

function nowTimestampUtc(): string {
	return new Date().toISOString().slice(0, 16).replace("T", " ");
}

function generateMemoryId(): string {
	return crypto.randomUUID().split("-")[0]!;
}
