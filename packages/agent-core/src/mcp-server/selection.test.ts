import { describe, expect, test } from 'vitest';
import { kiroExportedToolNames } from './selection';
import { optionalTools, allTools } from '../tools';
import { commandExecutionTool } from '../tools/command-execution';
import { fileEditTool } from '../tools/editor';
import { readImageTool } from '../tools/read-image';
import { sendFileToAgentTool } from '../tools/send-file-to-agent';
import { openPreviewTool, closePreviewTool } from '../tools/preview';

/**
 * Tools deliberately NOT exported over MCP to kiro-cli sessions.
 *
 * The first three have native kiro-cli equivalents (execute_bash / fs_write_file /
 * read_image). sendFileToAgent is intentionally worker-internal. Everything else
 * in `optionalTools` MUST be exposed to kiro sessions, otherwise a tool that the
 * system prompt instructs the agent to use is silently missing in the kiro-cli
 * runtime (this is exactly how the lesson tools regressed: they were added to
 * optionalTools for the Bedrock path but never to kiroExportedTools, so "Create
 * Lesson" was unavailable in the kiro-cli-only production environment).
 */
const intentionallyExcludedFromKiro = new Set(
  [commandExecutionTool, fileEditTool, readImageTool, sendFileToAgentTool].map((t) => t.name)
);

describe('kiroExportedTools ⊇ optionalTools (minus intentional exclusions)', () => {
  test('every optional tool is exported to kiro sessions unless intentionally excluded', () => {
    const exported = new Set(kiroExportedToolNames);
    const missing = optionalTools
      .map((t) => t.name)
      .filter((name) => !intentionallyExcludedFromKiro.has(name) && !exported.has(name));

    expect(missing).toEqual([]);
  });

  test('the lesson (memory) tools are exposed to kiro sessions', () => {
    const exported = new Set(kiroExportedToolNames);
    for (const name of ['list_lessons', 'get_lesson', 'create_lesson', 'update_lesson', 'delete_lesson']) {
      expect(exported.has(name)).toBe(true);
    }
  });

  // Naming convention guard: every tool ID must be snake_case ([a-z0-9_]+). This
  // locks the Kiro-aligned naming and fails loudly if a future tool reintroduces
  // a space/Title-Case/camelCase name (the hallucination root cause).
  // Naming convention guard: EVERY tool ID (Bedrock catalogue ∪ kiro MCP export ∪
  // preview tools ∪ the 4 kiro-native-excluded tools) must be snake_case
  // (^[a-z0-9_]+$). Locks the Kiro-aligned naming and fails loudly if any tool
  // reintroduces a space/Title-Case/camelCase name (the hallucination root
  // cause). previewTools are env-gated at import, so include the tool objects
  // directly to force them under the guard regardless of PREVIEW_MICROVM_IMAGE_ARN.
  test('every tool ID (allTools ∪ kiroExported ∪ preview ∪ kiro-native-excluded) is snake_case (^[a-z0-9_]+$)', () => {
    const names = new Set<string>([
      ...allTools.map((t) => t.name),
      ...kiroExportedToolNames,
      openPreviewTool.name,
      closePreviewTool.name,
      // kiro-native-excluded (not MCP-exported) tools still must obey the convention.
      commandExecutionTool.name,
      fileEditTool.name,
      readImageTool.name,
      sendFileToAgentTool.name,
    ]);
    const offenders = [...names].filter((n) => !/^[a-z0-9_]+$/.test(n));
    expect(offenders).toEqual([]);
  });

  test('intentionally-excluded tools stay out of the kiro export (kiro-cli ships equivalents)', () => {
    const exported = new Set(kiroExportedToolNames);
    for (const name of intentionallyExcludedFromKiro) {
      expect(exported.has(name)).toBe(false);
    }
  });
});
