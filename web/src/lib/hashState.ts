// Shareable state lives in the URL hash as `s=<base64url(deflate-raw(query string))>` to keep links short.
// Plain `key=value` hashes (older links) are still accepted.

const MAX_UNPACKED = 64 * 1024; // refuse oversized payloads (e.g. a crafted deflate bomb)

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
	const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			throw new Error('hash state too large');
		}
		chunks.push(value);
	}
	const out = new Uint8Array(size);
	let o = 0;
	for (const c of chunks) (out.set(c, o), (o += c.length));
	return out;
}

const toBase64Url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function packHash(params: URLSearchParams): Promise<string> {
	const packed = await pipe(new TextEncoder().encode(params.toString()), new CompressionStream('deflate-raw'));
	return 's=' + toBase64Url(packed);
}

/** Params from a hash (without the leading '#'), compressed or plain; malformed input yields empty params. */
export async function unpackHash(hash: string): Promise<URLSearchParams> {
	const outer = new URLSearchParams(hash);
	const s = outer.get('s');
	if (s === null) return outer;
	try {
		const bytes = await pipe(fromBase64Url(s), new DecompressionStream('deflate-raw'), MAX_UNPACKED);
		return new URLSearchParams(new TextDecoder().decode(bytes));
	} catch {
		return new URLSearchParams();
	}
}
