import { arrayBufferToFloat32Array } from "../store/vector-codec";
import type { RagRetrievalMatch, RagRetriever, RagStore } from "../types";

// Exact retrieval: scores every stored vector with cosine similarity. Works
// against any RagStore; fine for vault-sized indexes, replaceable with an
// ANN or store-native strategy through the retrieval registry.
export class CosineBruteForceRetriever implements RagRetriever {
	private store: RagStore;

	constructor(store: RagStore) {
		this.store = store;
	}

	async retrieve(queryVector: Float32Array, embeddingModel: string, limit: number): Promise<RagRetrievalMatch[]> {
		const vectors = await this.store.getVectorsForEmbeddingModel(embeddingModel);
		return vectors
			.map((vector) => ({
				chunkId: vector.chunkId,
				score: cosineSimilarity(queryVector, arrayBufferToFloat32Array(vector.vector)),
			}))
			.filter((match) => Number.isFinite(match.score))
			.sort((left, right) => right.score - left.score)
			.slice(0, limit);
	}
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
	if (left.length === 0 || left.length !== right.length) {
		return Number.NEGATIVE_INFINITY;
	}

	let dotProduct = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index++) {
		const leftValue = left[index] ?? 0;
		const rightValue = right[index] ?? 0;
		dotProduct += leftValue * rightValue;
		leftMagnitude += leftValue * leftValue;
		rightMagnitude += rightValue * rightValue;
	}

	if (leftMagnitude === 0 || rightMagnitude === 0) {
		return Number.NEGATIVE_INFINITY;
	}

	return dotProduct / Math.sqrt(leftMagnitude * rightMagnitude);
}
