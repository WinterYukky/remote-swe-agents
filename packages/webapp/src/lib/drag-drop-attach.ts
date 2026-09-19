/**
 * Shared drag & drop attachment helpers used by the chat input (MessageForm)
 * and the new-session form (NewSessionForm). Extracted as pure functions so
 * the "don't accept a drop while the form is busy" guard is testable without a
 * real DataTransfer or a mounted component. Accepting a drop while the form is
 * submitting/creating would upload the file to S3 and then silently discard it
 * when the action's success handler clears attachments / navigates away, so the
 * busy guard must run for every drop entry point.
 */

type MinimalDataTransfer = {
  types: readonly string[] | string[];
};

/**
 * True when the drag payload contains files (as opposed to a text/selection
 * drag). Mirrors the browser's `dataTransfer.types.includes('Files')` check.
 */
export function isFileDrag(dataTransfer: MinimalDataTransfer | null | undefined): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes('Files');
}

type DropArgs = {
  dataTransfer: (MinimalDataTransfer & { files?: FileList | File[] }) | null | undefined;
  /** True while the form is submitting/creating; the drop is ignored (parity with the disabled picker). */
  disabled: boolean;
  preventDefault: () => void;
  /** Invoked with the dropped files only when the drop is accepted. */
  onFiles: (files: FileList | File[]) => void;
};

/**
 * Handle an attachment drop with the busy guard applied. Returns true when the
 * drop was accepted (files handed to `onFiles`), false when ignored (busy,
 * non-file drag, or empty). `preventDefault` is only called for a genuine file
 * drag that is not blocked, so unrelated drags keep their default behavior.
 */
export function handleAttachmentDrop({ dataTransfer, disabled, preventDefault, onFiles }: DropArgs): boolean {
  if (disabled) return false;
  if (!isFileDrag(dataTransfer)) return false;
  preventDefault();
  const files = dataTransfer?.files;
  if (files && files.length > 0) {
    onFiles(files);
    return true;
  }
  return false;
}
