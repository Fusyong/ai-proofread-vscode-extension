import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: () => [],
        }),
    },
}));

import {
    executionsMatch,
    promptExecutionLabel,
    promptExecutionOf,
    resolvePromptTask,
} from './promptTask';

describe('promptTask execution labels', () => {
    it('maps translate to serial and others to parallel', () => {
        expect(promptExecutionOf('translate')).toBe('serial');
        expect(promptExecutionLabel('translate')).toBe('串行');
        expect(promptExecutionOf('proofread')).toBe('parallel');
        expect(promptExecutionOf('annotate')).toBe('parallel');
        expect(promptExecutionLabel('restructure')).toBe('并行');
    });

    it('treats parallel family as matching', () => {
        expect(executionsMatch('proofread', 'annotate')).toBe(true);
        expect(executionsMatch('proofread', 'translate')).toBe(false);
    });

    it('resolves preset book translate as translate', () => {
        expect(resolvePromptTask('__preset_book_translate_full__')).toBe('translate');
        expect(promptExecutionLabel(resolvePromptTask('__preset_book_translate_full__'))).toBe('串行');
    });
});
