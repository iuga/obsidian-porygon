import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { applyMemoryChange, MemoriesStore } from "../memories";
import { intentSchema, toToolErrorMessage } from "./shared";

export function createSaveMemoryTool(store: MemoriesStore) {
	return tool(
		async ({ content, importance, id }: { content: string; importance: "high" | "medium" | "low"; id?: string | null }): Promise<string> => {
			try {
				const normalizedId = typeof id === "string" && id.length > 0 ? id : undefined;
				const result = applyMemoryChange(store.get(), { content, importance, id: normalizedId });
				await store.set(result.raw);
				return result.message;
			} catch (error) {
				return toToolErrorMessage(error);
			}
		},
		{
			name: "save_memory",
			description: "Persist a long-term memory about the user or their context. Memories should be short and concrete; check the <memories> block first and skip anything already recorded. Omit id to append a new memory. Provide id with non-empty content to replace an existing memory. Provide id with empty content to delete an existing memory.",
			schema: z.object({
				intent: intentSchema,
				content: z.string().describe("The memory text. Keep it short and concrete. Leave empty only when deleting an existing memory by id."),
				importance: z.enum(["high", "medium", "low"]).describe("How critical this memory is. Use high for durable facts and constraints, medium for stable preferences, low for transient observations."),
				id: z.union([z.string(), z.null()]).optional().describe("Existing memory id to update or delete. Omit or pass null to append a new memory."),
			}),
		}
	);
}
