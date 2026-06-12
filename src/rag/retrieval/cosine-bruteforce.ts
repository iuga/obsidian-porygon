import { arrayBufferToFloat32Array } from "../store/vector-codec";
import type { RagRetrievalMatch, RagRetrievalQuery, RagRetriever, RagStore } from "../types";

// Exact retrieval: scores every stored vector with cosine similarity. Works
// against any RagStore; fine for vault-sized indexes, replaceable with an
// ANN or store-native strategy through the retrieval registry. Ignores
// `query.text` — this is a vector-only strategy.
export class CosineBruteForceRetriever implements RagRetriever {
	private store: RagStore;

	constructor(store: RagStore) {
		this.store = store;
	}

	async retrieve(query: RagRetrievalQuery): Promise<RagRetrievalMatch[]> {
		const vectors = await this.store.getVectorsForEmbeddingModel(query.embeddingModel);
		return vectors
			.map((vector) => ({
				chunkId: vector.chunkId,
				score: cosineSimilarity(query.vector, arrayBufferToFloat32Array(vector.vector)),
			}))
			.filter((match) => Number.isFinite(match.score))
			.sort((left, right) => right.score - left.score)
			.slice(0, query.limit);
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
