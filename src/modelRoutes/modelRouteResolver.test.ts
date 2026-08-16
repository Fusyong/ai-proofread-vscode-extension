import { beforeEach, describe, expect, it, vi } from 'vitest';

const configStore: Record<string, unknown> = {
    'proofread.platform': 'deepseek',
    'proofread.models.deepseek': 'deepseek-v4-flash',
    'proofread.disableThinking': true,
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
    hasRouteThinkingOverride,
    isRouteInherited,
    resolveModelRoute,
    resolveProofreadModel,
    setRouteDisableThinking,
} from './modelRouteResolver';

describe('modelRouteResolver', () => {
    beforeEach(() => {
        configStore['proofread.platform'] = 'deepseek';
        configStore['proofread.models.deepseek'] = 'deepseek-v4-flash';
        configStore['proofread.disableThinking'] = true;
        configStore.modelRoutes = {};
    });

    it('resolves proofread from settings', () => {
        const r = resolveProofreadModel();
        expect(r.platform).toBe('deepseek');
        expect(r.model).toBe('deepseek-v4-flash');
        expect(r.disableThinking).toBe(true);
        expect(r.thinkingOverridden).toBe(false);
    });

    it('referencePrep inherits proofread by default', () => {
        expect(isRouteInherited('referencePrep')).toBe(true);
        const r = resolveModelRoute('referencePrep');
        expect(r.inherited).toBe(true);
        expect(r.inheritedFrom).toBe('proofread');
        expect(r.platform).toBe('deepseek');
        expect(r.disableThinking).toBe(true);
        expect(r.thinkingOverridden).toBe(false);
    });

    it('referencePrepRerank inherits referencePrep by default', () => {
        expect(isRouteInherited('referencePrepRerank')).toBe(true);
        expect(getEffectiveInheritFrom('referencePrepRerank')).toBe('referencePrep');
        const r = resolveModelRoute('referencePrepRerank');
        expect(r.inherited).toBe(true);
        expect(r.inheritedFrom).toBe('referencePrep');
        expect(r.model).toBe('deepseek-v4-flash');
        expect(r.disableThinking).toBe(true);
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

    it('inherits disableThinking from proofread root', () => {
        configStore['proofread.disableThinking'] = false;
        const prep = resolveModelRoute('referencePrep');
        expect(prep.disableThinking).toBe(false);
        const rerank = resolveModelRoute('referencePrepRerank');
        expect(rerank.disableThinking).toBe(false);
    });

    it('allows thinking override while still inheriting platform/model', () => {
        configStore.modelRoutes = {
            referencePrep: { disableThinking: false },
        };
        expect(isRouteInherited('referencePrep')).toBe(true);
        expect(hasRouteThinkingOverride('referencePrep')).toBe(true);
        const prep = resolveModelRoute('referencePrep');
        expect(prep.inherited).toBe(true);
        expect(prep.platform).toBe('deepseek');
        expect(prep.disableThinking).toBe(false);
        expect(prep.thinkingOverridden).toBe(true);
    });

    it('thinking override chains: rerank follows prep override', () => {
        configStore.modelRoutes = {
            referencePrep: { disableThinking: false },
        };
        const rerank = resolveModelRoute('referencePrepRerank');
        expect(rerank.disableThinking).toBe(false);
        expect(rerank.thinkingOverridden).toBe(false);
    });

    it('rerank can override thinking independently of prep', () => {
        configStore.modelRoutes = {
            referencePrep: { disableThinking: false },
            referencePrepRerank: { disableThinking: true },
        };
        const rerank = resolveModelRoute('referencePrepRerank');
        expect(rerank.disableThinking).toBe(true);
        expect(rerank.thinkingOverridden).toBe(true);
        expect(rerank.model).toBe('deepseek-v4-flash');
    });

    it('setRouteDisableThinking clears override', async () => {
        await setRouteDisableThinking('referencePrep', false);
        expect(hasRouteThinkingOverride('referencePrep')).toBe(true);
        expect(resolveModelRoute('referencePrep').disableThinking).toBe(false);

        await setRouteDisableThinking('referencePrep', undefined);
        expect(hasRouteThinkingOverride('referencePrep')).toBe(false);
        expect(resolveModelRoute('referencePrep').disableThinking).toBe(true);
    });

    it('independent platform/model falls back thinking to proofread root', () => {
        configStore['proofread.disableThinking'] = false;
        configStore.modelRoutes = {
            referencePrep: { inherit: false, platform: 'aliyun', model: 'qwen3.8-max' },
        };
        const prep = resolveModelRoute('referencePrep');
        expect(prep.inherited).toBe(false);
        expect(prep.disableThinking).toBe(false);
        expect(prep.thinkingOverridden).toBe(false);
    });
});
