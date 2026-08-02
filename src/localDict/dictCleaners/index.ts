/**
 * 常用词典正文清理：在通用 HTML→文本之后、截断之前按 dictId/tags 应用。
 */

export type DictCleaner = (text: string) => string;

/** 去掉重复版权/导航噪声与多余空行（通用 MDX） */
export function cleanGenericMdxNoise(text: string): string {
    let out = String(text ?? '');
    if (!out) return out;
    // 常见页眉/页脚噪声行
    out = out
        .split('\n')
        .filter((line) => {
            const t = line.trim();
            if (!t) return true;
            if (/^(版权所有|Copyright|All rights reserved)/i.test(t)) return false;
            if (/^(返回目录|目录|首页|上一页|下一页)$/i.test(t)) return false;
            if (/^https?:\/\/\S+$/i.test(t) && t.length < 80) return false;
            return true;
        })
        .join('\n');
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

/** 辞海类：去掉 audio 残片、参见导航残留 */
export function cleanCihaiStyle(text: string): string {
    let out = cleanGenericMdxNoise(text);
    out = out.replace(/您的浏览器不支持\s*audio\s*标签/gi, '');
    out = out.replace(/<\/?audio\b[^>]*>/gi, '');
    out = out.replace(/\baudio\s*标签\b/gi, '');
    // 重复的「李　白（701—762）」类标题行只留首行附近一次即可：压缩连续重复行
    out = out.replace(/^(李\s*白[^\n]*)\n\1\n/gm, '$1\n');
    out = out.replace(/^[【\[]参见[】\]][^\n]*\n+/gm, '');
    out = out.replace(/[ \t]+\n/g, '\n');
    out = out.replace(/\n{3,}/g, '\n\n').trim();
    return out;
}

const BY_ID: Record<string, DictCleaner> = {
    cihai: cleanCihaiStyle,
    'cihai-7': cleanCihaiStyle,
    cihai7: cleanCihaiStyle,
    ci_hai: cleanCihaiStyle,
};

const BY_TAG: Array<{ tag: string; clean: DictCleaner }> = [
    { tag: '辞海', clean: cleanCihaiStyle },
    { tag: 'cihai', clean: cleanCihaiStyle },
    { tag: '百科', clean: cleanGenericMdxNoise },
];

export function resolveDictCleaner(params: {
    dictId?: string;
    tags?: string[];
}): DictCleaner {
    const id = (params.dictId ?? '').toLowerCase();
    if (id && BY_ID[id]) return BY_ID[id];
    const tags = (params.tags ?? []).map((t) => t.toLowerCase());
    for (const rule of BY_TAG) {
        if (tags.includes(rule.tag.toLowerCase()) || tags.some((t) => t.includes(rule.tag.toLowerCase()))) {
            return rule.clean;
        }
    }
    return cleanGenericMdxNoise;
}

export function cleanDictDefinition(params: {
    text: string;
    dictId?: string;
    tags?: string[];
}): string {
    const cleaner = resolveDictCleaner(params);
    return cleaner(params.text);
}
