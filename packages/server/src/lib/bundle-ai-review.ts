// Bundles and their review queue are hosted-only; the open-source edition has
// nothing to look at. Kept as a module so the world review sweep can import it.
export function queueBundleAiReview(_bundleId: string, pingAdmins: () => void): void {
  pingAdmins();
}

export async function sweepBundleAiReviews(_limit = 5): Promise<void> {}
