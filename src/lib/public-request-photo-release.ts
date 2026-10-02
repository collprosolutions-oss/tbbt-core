export type PublicRequestPhotoReleaseFn = (input: {
  slug: string;
  assetIds: string[];
}) => Promise<unknown>;

/**
 * Client-side cleanup after a public request attempt is refused.
 * Call sites must go through this helper so a rejected submit cannot
 * leave that attempt's unattached photos charged.
 */
export async function releaseRequestPhotosAfterRejectedSubmit(
  release: PublicRequestPhotoReleaseFn,
  input: { slug: string; assetIds: string[] },
) {
  return release({
    slug: input.slug,
    assetIds: [...input.assetIds],
  });
}

export function countRejectedSubmitPhotoReleaseCalls(source: string) {
  return (source.match(/releaseRequestPhotosAfterRejectedSubmit\s*\(/g) ?? []).length;
}
