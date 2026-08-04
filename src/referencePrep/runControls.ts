import type { ReferencePrepStrength, WikipediaLang } from './schema';
import { getStrengthPresetValues } from './strengthPresets';

/** 检索面板可调、当次 run 生效的控制参数 */
export interface ReferencePrepRunControls {
    minSelectScore: number;
    maxSelectedPerQuery: number;
    maxSelectedCharsPerQuery: number;
    maxCandidateHitsPerQuery: number;
    maxEntriesPrimary: number;
    maxEntriesRelevance: number;
    maxEntriesLength: number;
    requirePlanConfirm: boolean;
    wikiDefaultLang: WikipediaLang;
    wikiFallbackLang: WikipediaLang;
    /** 用户是否锁定自定义（切换强度时不覆盖） */
    controlsLocked?: boolean;
}

export const WIKIPEDIA_LANGS: WikipediaLang[] = ['zh', 'en', 'ja', 'fr', 'de', 'ru'];

export function isWikipediaLang(v: unknown): v is WikipediaLang {
    return typeof v === 'string' && (WIKIPEDIA_LANGS as string[]).includes(v);
}

export function defaultControlsForStrength(strength: ReferencePrepStrength): ReferencePrepRunControls {
    const p = getStrengthPresetValues(strength);
    return {
        minSelectScore: p.minSelectScore,
        maxSelectedPerQuery: p.maxSelectedPerQuery,
        maxSelectedCharsPerQuery: p.maxSelectedCharsPerQuery,
        maxCandidateHitsPerQuery: p.maxCandidateHitsPerQuery,
        maxEntriesPrimary: p.maxEntriesPrimary,
        maxEntriesRelevance: p.maxEntriesRelevance,
        maxEntriesLength: p.maxEntriesLength,
        requirePlanConfirm: false,
        wikiDefaultLang: 'zh',
        wikiFallbackLang: 'en',
        controlsLocked: false,
    };
}

export function clampControls(raw: Partial<ReferencePrepRunControls> | undefined, strength: ReferencePrepStrength): ReferencePrepRunControls {
    const base = defaultControlsForStrength(strength);
    if (!raw) return base;
    const num = (v: unknown, fallback: number, min: number, max: number) => {
        const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
        return Math.min(max, Math.max(min, n));
    };
    return {
        minSelectScore: num(raw.minSelectScore, base.minSelectScore, 0, 1),
        maxSelectedPerQuery: Math.round(num(raw.maxSelectedPerQuery, base.maxSelectedPerQuery, 1, 50)),
        maxSelectedCharsPerQuery: Math.round(
            num(raw.maxSelectedCharsPerQuery, base.maxSelectedCharsPerQuery, 500, 100000)
        ),
        maxCandidateHitsPerQuery: Math.round(
            num(raw.maxCandidateHitsPerQuery, base.maxCandidateHitsPerQuery, 1, 100)
        ),
        maxEntriesPrimary: Math.round(num(raw.maxEntriesPrimary, base.maxEntriesPrimary, 1, 30)),
        maxEntriesRelevance: Math.round(num(raw.maxEntriesRelevance, base.maxEntriesRelevance, 0, 30)),
        maxEntriesLength: Math.round(num(raw.maxEntriesLength, base.maxEntriesLength, 0, 30)),
        requirePlanConfirm: raw.requirePlanConfirm === true,
        wikiDefaultLang: isWikipediaLang(raw.wikiDefaultLang) ? raw.wikiDefaultLang : base.wikiDefaultLang,
        wikiFallbackLang: isWikipediaLang(raw.wikiFallbackLang) ? raw.wikiFallbackLang : base.wikiFallbackLang,
        controlsLocked: raw.controlsLocked === true,
    };
}
