/** Membership upload benefits, shared by enforcement and the plan comparison. */
export function creativeUploadPolicy(plan: string) {
  const priority: 0 | 1 | 2 = plan === "ultra" || plan === "internal" ? 2
    : plan === "go" || plan === "plus" || plan === "pro" ? 1 : 0;
  return { concurrency: [2, 4, 6][priority]!, priority };
}

export const CREATIVE_UPLOAD_FILES_PER_HOUR = 5000;
export const creativeUploadBytesPerHour = (storageLimit: number) => Math.max(128 * 1024 * 1024, storageLimit * 2);
