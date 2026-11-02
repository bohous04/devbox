export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export class UploadError extends Error {
  constructor(message: string, public status: 400 | 413) { super(message); }
}

// Enforce the limit while reading, including chunked requests with no Content-Length.
export async function readUpload(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (declared > MAX_UPLOAD_BYTES) throw new UploadError("File exceeds the 25 MB upload limit", 413);
  if (!req.body) throw new UploadError("File is empty", 400);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new UploadError("File exceeds the 25 MB upload limit", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new UploadError("File is empty", 400);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
