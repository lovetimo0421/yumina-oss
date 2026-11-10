type ObjectBody = AsyncIterable<Uint8Array> & { destroy?: () => void };

export async function readObjectBodyLimited(body: ObjectBody | null | undefined, contentLength: number | undefined, maxBytes: number): Promise<Buffer> {
  if (!body) throw new Error("MEDIA_INVALID_SIZE");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // Close the response even when its header lets us reject before reading.
    if ((contentLength ?? 0) > maxBytes) throw new Error("MEDIA_INVALID_SIZE");
    for await (const chunk of body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error("MEDIA_INVALID_SIZE");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, size);
  } finally { body.destroy?.(); }
}
