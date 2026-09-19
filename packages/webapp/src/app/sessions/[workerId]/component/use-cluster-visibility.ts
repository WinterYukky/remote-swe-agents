import { useState } from 'react';
import { useEffect, useRef } from 'react';
import type { MessageView } from './MessageList';
import { hashTargetInMessages } from './message-clustering';

type UseClusterVisibilityOptions = {
  /** Whether the run currently contains an executing tool. */
  running: boolean;
  /** Whether this cluster should default to open when not running (latest group). */
  defaultExpanded: boolean;
};

type UseClusterVisibilityResult = {
  /** Whether the cluster body is currently shown. */
  visible: boolean;
  /**
   * Whether the body has EVER been shown. Children are mounted once this is
   * true and then kept mounted (hidden via CSS while `visible` is false), so
   * a collapse/expand cycle never unmounts them — preserving the lazy
   * image-URL cache inside `ToolUseRenderer` and each child's local state.
   */
  everVisible: boolean;
  /** Whether the cluster is currently expanded (for aria-expanded). */
  expanded: boolean;
  /** Toggle the user-controlled override. */
  toggle: () => void;
};

/**
 * Shared open/close state for a collapsible activity cluster.
 *
 * Default visibility (until the user or a search-jump overrides it):
 * - a RUNNING cluster is open (shows the run in progress);
 * - a non-running cluster follows `defaultExpanded` (the latest group opens on
 *   initial load / history view);
 * - BUT once a cluster is observed transitioning running → done within this
 *   mounted session (streaming completion), it AUTO-FOLDS:
 *   the just-finished latest cluster collapses into its ▶ replay row,
 *   instead of staying open just because it is the last group.
 * A user toggle (or search-jump) sets an explicit override that wins over all
 * of the above.
 *
 * `everVisible` latches so children mount once and stay mounted. Search-jump
 * (M-1b): on mount / `hashchange`, if the `#msg-<SK>` hash targets a member of
 * a collapsed cluster, force it visible and re-dispatch `hashchange` so
 * MessageList's scroll-to-hash handler lands on the now-visible anchor.
 */
export function useClusterVisibility(
  messages: MessageView[],
  { running, defaultExpanded }: UseClusterVisibilityOptions
): UseClusterVisibilityResult {
  const [override, setOverride] = useState<boolean | undefined>(undefined);

  // Track running so we can detect a true→false (completion) transition and
  // auto-fold once. Adjusted DURING render (React-sanctioned derived-state
  // pattern, same as `everVisible` below) to stay lint-clean — no ref
  // mutation or setState-in-effect.
  const [autoFolded, setAutoFolded] = useState(false);
  const [lastRunning, setLastRunning] = useState(running);
  if (lastRunning !== running) {
    setLastRunning(running);
    if (lastRunning && !running) setAutoFolded(true);
  }

  const derivedDefault = running ? true : autoFolded ? false : defaultExpanded;
  const visible = override ?? derivedDefault;

  const [everVisible, setEverVisible] = useState(visible);
  if (visible && !everVisible) setEverVisible(true);

  const handledHashRef = useRef<string | null>(null);

  useEffect(() => {
    const maybeExpandForHash = () => {
      const hash = window.location.hash;
      if (handledHashRef.current === hash) return;
      if (!hashTargetInMessages(messages, hash)) return;
      handledHashRef.current = hash;
      // Force the body visible (idempotent if already shown) so the targeted
      // anchor is mounted and not `hidden`, then re-dispatch `hashchange` on
      // the next frame so MessageList's existing scroll-to-hash handler runs
      // against the now-visible anchor. `everVisible` follows via the
      // render-time latch above.
      setOverride(true);
      requestAnimationFrame(() => {
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
    };
    maybeExpandForHash();
    window.addEventListener('hashchange', maybeExpandForHash);
    return () => window.removeEventListener('hashchange', maybeExpandForHash);
  }, [messages, defaultExpanded, running]);

  return {
    visible,
    everVisible,
    expanded: visible,
    toggle: () => setOverride(!visible),
  };
}
