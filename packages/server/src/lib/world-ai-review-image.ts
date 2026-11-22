import sharp from "sharp";

/**
 * A cover as one small JPEG for the AI review. An animated cover is shown as
 * its first, middle and last frames side by side: a cover that turns revealing
 * halfway through (11/07 backtest, "The Last Lap") must not pass on frame one.
 */
export async function coverToReviewJpeg(buffer: Buffer): Promise<Buffer> {
  const meta = await sharp(buffer, { animated: true }).metadata();
  const pages = meta.pages ?? 1;
  const frames = pages > 1 ? [...new Set([0, Math.floor(pages / 2), pages - 1])] : [0];
  if (frames.length === 1) {
    return sharp(buffer, { page: 0 }).rotate().resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 86 }).toBuffer();
  }
  const tile = 512;
  const parts = await Promise.all(frames.map((page) => sharp(buffer, { page })
    .resize(tile, tile, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).png().toBuffer()));
  return sharp({ create: { width: tile * parts.length, height: tile, channels: 3, background: "#ffffff" } })
    .composite(parts.map((input, i) => ({ input, left: i * tile, top: 0 })))
    .jpeg({ quality: 86 }).toBuffer();
}

/**
 * The card's other pictures as grids of 4×4 tiles. An animated picture gets
 * its first, middle and last frames as three tiles (the same reason as the
 * cover). A picture that can't be decoded is counted in `failed` so the
 * caller treats it as unseen.
 */
export async function imagesToReviewGrids(buffers: Buffer[], perGrid = 16): Promise<{ grids: Buffer[]; failed: number }> {
  const tile = 256, cols = 4;
  let failed = 0;
  const perPicture = await Promise.all(buffers.map(async (b) => {
    try {
      const pages = (await sharp(b, { animated: true }).metadata()).pages ?? 1;
      const frames = pages > 1 ? [...new Set([0, Math.floor(pages / 2), pages - 1])] : [0];
      return await Promise.all(frames.map((page) => sharp(b, { page }).rotate()
        .resize(tile, tile, { fit: "contain", background: "#ffffff" }).flatten({ background: "#ffffff" }).png().toBuffer()));
    } catch {
      failed++;
      return [];
    }
  }));
  const tiles = perPicture.flat();
  const grids: Buffer[] = [];
  for (let i = 0; i < tiles.length; i += perGrid) {
    const group = tiles.slice(i, i + perGrid);
    const rows = Math.ceil(group.length / cols);
    grids.push(await sharp({ create: { width: tile * Math.min(cols, group.length), height: tile * rows, channels: 3, background: "#ffffff" } })
      .composite(group.map((input, j) => ({ input, left: (j % cols) * tile, top: Math.floor(j / cols) * tile })))
      .jpeg({ quality: 82 }).toBuffer());
  }
  return { grids, failed };
}

/** Portrait and desktop covers side by side, judged together as the cover. */
export async function coversSideBySide(portrait: Buffer, landscape: Buffer): Promise<Buffer> {
  const height = 768;
  const [a, b] = await Promise.all([portrait, landscape].map((x) => sharp(x).resize({ height, withoutEnlargement: false }).png().toBuffer({ resolveWithObject: true })));
  return sharp({ create: { width: a!.info.width + b!.info.width + 16, height, channels: 3, background: "#ffffff" } })
    .composite([{ input: a!.data, left: 0, top: 0 }, { input: b!.data, left: a!.info.width + 16, top: 0 }])
    .jpeg({ quality: 86 }).toBuffer();
}
