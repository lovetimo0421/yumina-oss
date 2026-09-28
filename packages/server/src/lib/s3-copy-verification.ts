export type VerifiedCopyMetadata = { MetadataDirective: "REPLACE"; ContentType: string };

export interface CopiedObjectMetadata {
  etag: string | null;
  contentLength: number;
  contentType: string;
}

/** S3-compatible providers may ignore CopySourceIfMatch. Inspect the immutable
 * destination before its database registration can make it public. */
export async function copyAndVerifyObject(
  copy: (metadata?: VerifiedCopyMetadata) => Promise<unknown>,
  head: () => Promise<CopiedObjectMetadata>,
  expected: { etag: string; contentLength?: number; contentType?: string },
): Promise<void> {
  // The destination is addressable by the raw public CDN key before its DB
  // registration. Pin its safe MIME during copy, not after exposure.
  await copy(expected.contentType === undefined ? undefined : {
    MetadataDirective: "REPLACE", ContentType: expected.contentType,
  });
  const actual = await head();
  const normalizeEtag = (value: string) => value.replace(/^"|"$/g, "");
  if (!actual.etag || normalizeEtag(actual.etag) !== normalizeEtag(expected.etag)
    || (expected.contentLength !== undefined && actual.contentLength !== expected.contentLength)
    || (expected.contentType !== undefined && actual.contentType !== expected.contentType)) {
    // Keep the unregistered candidate for the normal sweeper; never publish it.
    throw new Error("Uploaded object changed during registration");
  }
}
