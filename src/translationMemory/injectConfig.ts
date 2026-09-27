/**
 * 翻译注入预算与相关配置（纯读取，便于单测 mock）。
 */

import * as vscode from 'vscode';

export type TranslateInjectConfig = {
    termsActiveMax: number;
    recentRoundsMax: number;
    termsTopN: number;
    injectTermsMaxChars: number;
    injectExamplesMaxChars: number;
    injectSimilarMaxChars: number;
    similarTopK: number;
    similarThreshold: number;
    bitextIndexMaxPairs: number;
    sourceLang: string;
    targetLang: string;
    /** 翻译专用温度；未配置则 undefined，调用方回退校对温度 */
    temperature?: number;
    warnIfNoStyleSample: boolean;
};

export function readTranslateInjectConfig(
    config: { get<T>(key: string, defaultValue?: T): T | undefined } = vscode.workspace.getConfiguration(
        'ai-proofread'
    )
): TranslateInjectConfig {
    const tempRaw = config.get<number | null>('translate.temperature', null);
    let temperature: number | undefined;
    if (typeof tempRaw === 'number' && Number.isFinite(tempRaw) && tempRaw >= 0 && tempRaw < 2) {
        temperature = tempRaw;
    }
    return {
        termsActiveMax: config.get<number>('translationMemory.termsActiveMax', 80) ?? 80,
        recentRoundsMax: config.get<number>('translationMemory.recentRoundsMax', 3) ?? 3,
        termsTopN: config.get<number>('translationMemory.injectTermsTopN', 20) ?? 20,
        injectTermsMaxChars:
            config.get<number>('translationMemory.injectTermsMaxChars', 4000) ?? 4000,
        injectExamplesMaxChars:
            config.get<number>('translationMemory.injectExamplesMaxChars', 6000) ?? 6000,
        injectSimilarMaxChars:
            config.get<number>('translationMemory.injectSimilarMaxChars', 3000) ?? 3000,
        similarTopK: config.get<number>('translationMemory.similarTopK', 3) ?? 3,
        similarThreshold: config.get<number>('translationMemory.similarThreshold', 0.45) ?? 0.45,
        bitextIndexMaxPairs:
            config.get<number>('translationMemory.bitextIndexMaxPairs', 8000) ?? 8000,
        sourceLang: String(config.get<string>('translate.sourceLang', '') ?? '').trim(),
        targetLang: String(config.get<string>('translate.targetLang', 'zh-Hans') ?? 'zh-Hans').trim(),
        temperature,
        warnIfNoStyleSample: config.get<boolean>('translate.warnIfNoStyleSample', true) ?? true,
    };
}

/** 将译向说明拼进源文本特性（请求侧） */
export function buildDirectionHintXml(cfg: TranslateInjectConfig): string {
    const src = cfg.sourceLang;
    const tgt = cfg.targetLang;
    if (!src && !tgt) {
        return '';
    }
    const lines = ['<translation_direction>'];
    if (src) {
        lines.push(`source_lang: ${src}`);
    }
    if (tgt) {
        lines.push(`target_lang: ${tgt}`);
    }
    lines.push('</translation_direction>');
    return '\n' + lines.join('\n');
}

export function clipInjectText(s: string, max: number): string {
    const t = s.trim();
    if (t.length <= max) {
        return t;
    }
    return t.slice(0, Math.max(0, max - 1)) + '…';
}
