import { beforeEach, describe, expect, it, vi } from 'vitest';

const configStore: Record<string, unknown> = {
    'proofread.platform': 'deepseek',
    'proofread.models.deepseek': 'deepseek-v4-flash',
    modelRoutes: {},
};

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (key: string, def?: unknown) => (key in configStore ? configStore[key] : def),
            update: async (key: string, val: unknown) => {
                configStore[key] = val;
            },
        }),
    },
    ConfigurationTarget: { Global: 1 },
}));

import {
    getEffectiveInheritFrom,
    isRouteInherited,
    resolveModelRoute,
    resolveProofreadModel,
} from './modelRouteResolver';

describe('modelRouteResolver', () => {
    beforeEach(() => {
        configStore['proofread.platform'] = 'deepseek';
        configStore['proofread.models.deepseek'] = 'deepseek-v4-flash';
        configStore.modelRoutes = {};
    });

    it('resolves proofread from settings', () => {
        const r = resolveProofreadModel();
        expect(r.platform).toBe('deepseek');
        expect(r.model).toBe('deepseek-v4-flash');
    });

    it('referencePrep inherits proofread by default', () => {
        expect(isRouteInherited('referencePrep')).toBe(true);
        const r = resolveModelRoute('referencePrep');
        expect(r.inherited).toBe(true);
        expect(r.inheritedFrom).toBe('proofread');
        expect(r.platform).toBe('deepseek');
    });

    it('referencePrepRerank inherits referencePrep by default', () => {
        expect(isRouteInherited('referencePrepRerank')).toBe(true);
        expect(getEffectiveInheritFrom('referencePrepRerank')).toBe('referencePrep');
        const r = resolveModelRoute('referencePrepRerank');
        expect(r.inherited).toBe(true);
        expect(r.inheritedFrom).toBe('referencePrep');
        expect(r.model).toBe('deepseek-v4-flash');
    });

    it('referencePrepScope inherits referencePrep by default', () => {
        expect(isRouteInherited('referencePrepScope')).toBe(true);
        const r = resolveModelRoute('referencePrepScope');
        expect(r.inheritedFrom).toBe('referencePrep');
    });

    it('chained inherit: rerank follows independent referencePrep', () => {
        configStore.modelRoutes = {
            referencePrep: { inherit: false, platform: 'deepseek', model: 'deepseek-v4-pro' },
        };
        const prep = resolveModelRoute('referencePrep');
        expect(prep.inherited).toBe(false);
        expect(prep.model).toBe('deepseek-v4-pro');

        const rerank = resolveModelRoute('referencePrepRerank');
        expect(rerank.inherited).toBe(true);
        expect(rerank.inheritedFrom).toBe('referencePrep');
        expect(rerank.model).toBe('deepseek-v4-pro');
    });

    it('referencePrepRerank can inherit proofread when inheritFrom set', () => {
        configStore.modelRoutes = {
            referencePrep: { inherit: false, platform: 'deepseek', model: 'deepseek-v4-pro' },
            referencePrepRerank: { inherit: true, inheritFrom: 'proofread' },
        };
        const rerank = resolveModelRoute('referencePrepRerank');
        expect(rerank.inheritedFrom).toBe('proofread');
        expect(rerank.model).toBe('deepseek-v4-flash');
    });
});
