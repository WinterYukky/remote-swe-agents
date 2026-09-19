import { describe, expect, test } from 'vitest';
import { buildInitialImages, isImageKey, isVideoKey, type ImageData } from './image-viewer-utils';

describe('isImageKey', () => {
  test('accepts supported image extensions (case-sensitive lowercase)', () => {
    for (const key of ['a.jpg', 'a.jpeg', 'a.png', 'a.webp', 'a.svg', 'a.gif']) {
      expect(isImageKey(key)).toBe(true);
    }
  });

  test('rejects non-image / file keys', () => {
    for (const key of ['a.pdf', 'a.txt', 'a.zip', 'a', 'a.png.txt']) {
      expect(isImageKey(key)).toBe(false);
    }
  });
});

describe('buildInitialImages', () => {
  test('reserves a loading slot for every image key on first paint', () => {
    const result = buildInitialImages(['x.png', 'y.jpg'], []);
    expect(result).toEqual([
      { key: 'x.png', url: '', loading: true, error: false },
      { key: 'y.jpg', url: '', loading: true, error: false },
    ]);
  });

  test('filters out non-image keys so FileViewer handles them instead', () => {
    const result = buildInitialImages(['x.png', 'doc.pdf', 'y.gif'], []);
    expect(result.map((i) => i.key)).toEqual(['x.png', 'y.gif']);
  });

  test('paints seeded blob previews immediately, others stay loading', () => {
    const seeded: ImageData[] = [{ key: 'x.png', url: 'blob:abc', loading: false, error: false }];
    const result = buildInitialImages(['x.png', 'y.png'], seeded);
    expect(result).toEqual([
      { key: 'x.png', url: 'blob:abc', loading: false, error: false },
      { key: 'y.png', url: '', loading: true, error: false },
    ]);
  });

  test('preserves input key order', () => {
    const result = buildInitialImages(['b.png', 'a.png', 'c.gif'], []);
    expect(result.map((i) => i.key)).toEqual(['b.png', 'a.png', 'c.gif']);
  });
});

describe('isVideoKey', () => {
  test('accepts supported video extensions', () => {
    for (const key of ['a.mp4', 'a.webm', 'a.mov', 'a.m4v', 'a.ogv']) {
      expect(isVideoKey(key)).toBe(true);
    }
  });

  test('accepts upper-case / mixed-case video extensions (iPhone IMG_1234.MOV)', () => {
    for (const key of ['worker/abc/IMG_1234.MOV', 'a.MP4', 'a.Mov', 'a.WEBM', 'b.M4V']) {
      expect(isVideoKey(key)).toBe(true);
    }
  });

  test('rejects image / other file keys', () => {
    for (const key of ['a.png', 'a.pdf', 'a.txt', 'a', 'a.mp4.txt']) {
      expect(isVideoKey(key)).toBe(false);
    }
  });
});
