export const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.svg', '.gif'];

export const isImageKey = (key: string) => IMAGE_EXTENSIONS.some((ext) => key.endsWith(ext));

export type ImageData = {
  key: string;
  url: string;
  loading: boolean;
  error: boolean;
};

/**
 * Compute the initial `images` display state for `ImageViewer` synchronously
 * (i.e. before any effect runs). Every image key gets a slot on first paint
 * so its fixed-size placeholder reserves height immediately — the fix for the
 * layout shift that otherwise drifts the initial scroll-to-latest position.
 *
 * Keys already backed by a usable local blob preview paint that preview at
 * once; every other key starts in the loading state. Non-image keys are
 * filtered out (they are handled by `FileViewer`).
 */
export function buildInitialImages(inputKeys: string[], seededEntries: ImageData[]): ImageData[] {
  const seeded = new Map(seededEntries.map((entry) => [entry.key, entry] as const));
  return inputKeys.filter(isImageKey).map((key) => seeded.get(key) ?? { key, url: '', loading: true, error: false });
}

export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];

export const isVideoKey = (key: string) => {
  const lower = key.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
};
