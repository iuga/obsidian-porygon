// Vectors cross the RagStore boundary as ArrayBuffers: structured-clone
// friendly for IndexedDB, byte-exact for any other backend.
export function float32ArrayToArrayBuffer(vector: Float32Array): ArrayBuffer {
	return vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength);
}

export function arrayBufferToFloat32Array(vector: ArrayBuffer): Float32Array {
	return new Float32Array(vector);
}
