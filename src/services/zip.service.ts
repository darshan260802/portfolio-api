import { ZipArchive } from "archiver";

/**
 * Zips `dir` into an in-memory buffer. Generated projects here are just
 * source + a small data.json + a few downloaded images (no node_modules,
 * no build output), so buffering the whole archive is simpler and more
 * robust than streaming through a response with its own cleanup lifecycle.
 */
export async function zipDirectoryToBuffer(dir: string): Promise<Buffer> {
	const archive = new ZipArchive({ zlib: { level: 9 } });
	const chunks: Buffer[] = [];

	const done = new Promise<void>((resolve, reject) => {
		archive.on("data", (chunk: Buffer) => chunks.push(chunk));
		archive.on("end", () => resolve());
		archive.on("error", (err: Error) => reject(err));
	});

	archive.directory(dir, false);
	void archive.finalize();
	await done;

	return Buffer.concat(chunks);
}
