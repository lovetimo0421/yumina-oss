/**
 * 16-bit mono WAV, the format every speech-to-text model takes. Voice input
 * converts the browser's recording (Chrome webm/opus, Safari mp4) to this
 * before upload, because the transcriber we use (MAI-Transcribe) refuses those
 * containers. Table voice builds its utterances in it directly.
 */

export function wavBlob(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i]!)) * 32767, true);
  return new Blob([buf], { type: "audio/wav" });
}

/** A recorded clip as mono WAV at `rate`, or null when this browser can't
 *  decode it (the caller then uploads the original). 60 s at 16 kHz is ~1.9 MB. */
export async function toWav(blob: Blob, rate = 16_000): Promise<Blob | null> {
  const Offline = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  if (!Offline) return null;
  try {
    const bytes = await blob.arrayBuffer();
    // A one-sample context is enough to decode; decodeAudioData resamples to its rate.
    const decoder = new Offline(1, 1, rate);
    const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
      const p = decoder.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
    const length = Math.max(1, Math.round(decoded.duration * rate));
    const ctx = new Offline(1, length, rate);
    const src = ctx.createBufferSource();
    src.buffer = decoded;
    src.connect(ctx.destination);
    src.start();
    const mono = await ctx.startRendering();
    return wavBlob(mono.getChannelData(0), rate);
  } catch {
    return null;
  }
}
