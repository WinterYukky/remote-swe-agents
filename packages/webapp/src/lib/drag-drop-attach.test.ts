import { describe, test, expect, vi } from 'vitest';
import { isFileDrag, handleAttachmentDrop } from './drag-drop-attach';

describe('isFileDrag', () => {
  test('true when types include Files', () => {
    expect(isFileDrag({ types: ['Files'] })).toBe(true);
    expect(isFileDrag({ types: ['text/plain', 'Files'] })).toBe(true);
  });

  test('false for non-file drags / missing dataTransfer', () => {
    expect(isFileDrag({ types: ['text/plain'] })).toBe(false);
    expect(isFileDrag({ types: [] })).toBe(false);
    expect(isFileDrag(null)).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });
});

describe('handleAttachmentDrop', () => {
  const file = new File(['x'], 'a.txt', { type: 'text/plain' });

  test('accepts a file drop when not disabled', () => {
    const preventDefault = vi.fn();
    const onFiles = vi.fn();
    const accepted = handleAttachmentDrop({
      dataTransfer: { types: ['Files'], files: [file] },
      disabled: false,
      preventDefault,
      onFiles,
    });
    expect(accepted).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onFiles).toHaveBeenCalledOnce();
    expect(onFiles.mock.calls[0][0]).toHaveLength(1);
  });

  test('does NOT process files while disabled (busy guard: prevents silent upload+discard)', () => {
    const preventDefault = vi.fn();
    const onFiles = vi.fn();
    const accepted = handleAttachmentDrop({
      dataTransfer: { types: ['Files'], files: [file] },
      disabled: true,
      preventDefault,
      onFiles,
    });
    expect(accepted).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
    // preventDefault is skipped when blocked so the window-level listener can
    // still stop the browser from opening the dropped file.
    expect(preventDefault).not.toHaveBeenCalled();
  });

  test('ignores non-file drags', () => {
    const preventDefault = vi.fn();
    const onFiles = vi.fn();
    const accepted = handleAttachmentDrop({
      dataTransfer: { types: ['text/plain'] },
      disabled: false,
      preventDefault,
      onFiles,
    });
    expect(accepted).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onFiles).not.toHaveBeenCalled();
  });

  test('ignores an empty file drop', () => {
    const preventDefault = vi.fn();
    const onFiles = vi.fn();
    const accepted = handleAttachmentDrop({
      dataTransfer: { types: ['Files'], files: [] },
      disabled: false,
      preventDefault,
      onFiles,
    });
    expect(accepted).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
  });
});
