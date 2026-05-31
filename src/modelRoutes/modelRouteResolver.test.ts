import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    const store: Record<string, unknown> = {
        'proofread.platform': 'deepseek',
        'proofread.models.deepseek': 'deepseek-v4-flash',
        modelRoutes: {},
    };
    return {
        workspace: {
            getConfiguration: () => ({
                get: (key: string, def?: unknown) => (key in store ? store[key] : def),
                update: async (key: string, val: unknown) => {
                    store[key] = val;
                },
            }),
        },
        ConfigurationTarget: { Global: 1 },
    };
});

import { isRouteInherited, resolveModelRoute, resolveProofreadModel } from './modelRouteResolver';

describe('modelRouteResolver', () => {
    it('resolves proofread from settings', () => {
        const r = resolveProofreadModel();
        expect(r.platform).toBe('deepseek');
        expect(r.model).toBe('deepseek-v4-flash');
    });

    it('referencePrep inherits proofread by default', () => {
        expect(isRouteInherited('referencePrep')).toBe(true);
        const r = resolveModelRoute('referencePrep');
        expect(r.inherited).toBe(true);
        expect(r.platform).toBe('deepseek');
    });
});
