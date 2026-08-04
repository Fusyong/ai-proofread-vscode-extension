import * as path from 'path';

/** 统一路径分隔符，避免同一文件正/反斜杠重复命中 */
export function normalizeRelPath(rel: string): string {
    return String(rel ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .trim();
}

/** 朗诵进度「分:秒」，不是生卒年（701—762 / 1910—1949） */
const TIME_CODE_LINE = /^\d{1,2}:\d{2}(:\d{2})?$/;
const TOC_SECTION =
    /^(#{1,6}\s*)?\d*\s*(目录|作品原文|词句注释|白话译文|创作背景|作品鉴赏|作者简介|后世影响|作品影响|历代评价)[:：]?$/;
const MD_HEADING_ONLY = /^#{1,6}\s+\S{1,24}$/;
const META_CARD_LINE =
    /^(作品名称|出\s*处|作\s*者|创作年代|创作时间|作品体裁)\s*\S/;

function isNoiseLine(line: string): boolean {
    const l = line.trim();
    if (!l) return true;
    if (TIME_CODE_LINE.test(l)) return true;
    if (TOC_SECTION.test(l)) return true;
    if (META_CARD_LINE.test(l)) return true;
    if (/朗诵|配乐|音频|视频/.test(l) && l.length <= 40 && !/[。！？；]/.test(l)) return true;
    if (MD_HEADING_ONLY.test(l) && !/[。！？；]/.test(l) && l.replace(/^#+\s*/, '').length <= 20) {
        return true;
    }
    return false;
}

function hasTimeCodeLine(snippet: string): boolean {
    return String(snippet ?? '')
        .split(/\n/)
        .some((l) => TIME_CODE_LINE.test(l.trim()));
}

/** 去掉朗诵时间戳/纯目录行/导航残片，保留生卒年与正文 */
export function stripGrepNoiseLines(snippet: string): string {
    return String(snippet ?? '')
        .split(/\n/)
        .filter((l) => !isNoiseLine(l))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 入库/导出用：剥噪声行后返回正文。
 * - 长摘录：去掉 02:42、目录行，保留诗句/鉴赏
 * - 剥后过短或仍是噪声堆：返回空（调用方丢弃）
 * - 不触及生卒年数字
 */
export function sanitizeGrepSnippetForExport(snippet: string, headingPath?: string): string {
    const raw = String(snippet ?? '').trim();
    if (!raw) return '';
    const cleaned = stripGrepNoiseLines(raw);
    const compact = cleaned.replace(/\s+/g, '');
    if (compact.length < 12) return '';
    // 原文夹朗诵时间戳/重噪声，剥后有效正文仍偏短 → 整段不要
    if ((hasTimeCodeLine(raw) || isNoisyGrepSnippet(raw, headingPath)) && compact.length < 48) {
        return '';
    }
    if (isNoisyGrepSnippet(cleaned, headingPath)) return '';
    return cleaned;
}

/**
 * 朗诵时间戳、目录残片、过短碎片等检索噪声。
 * 有效正文过短则整段判噪声；够长则可由 sanitize 保留正文。
 */
export function isNoisyGrepSnippet(snippet: string, headingPath?: string): boolean {
    const s = String(snippet ?? '').trim();
    if (!s) return true;
    const compact = s.replace(/\s+/g, '');
    if (compact.length < 12) return true;

    const lines = s.split(/\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((l) => TIME_CODE_LINE.test(l))) return true;
    if (/^\d{1,2}:\d{2}\s*$/.test(s) || /^(\d{1,2}:\d{2}\s*)+$/.test(s.replace(/\n/g, ' '))) {
        return true;
    }

    if (lines.length <= 4 && lines.every((l) => isNoiseLine(l) || TOC_SECTION.test(l))) {
        return true;
    }

    const cleaned = stripGrepNoiseLines(s);
    const cleanedCompact = cleaned.replace(/\s+/g, '');
    const hasTimeCode = lines.some((l) => TIME_CODE_LINE.test(l));
    const noiseLineCount = lines.filter((l) => isNoiseLine(l)).length;

    if ((hasTimeCode || noiseLineCount >= 2) && cleanedCompact.length < 48) {
        return true;
    }
    if (lines.length >= 2 && noiseLineCount / lines.length >= 0.5 && compact.length < 160) {
        return true;
    }
    if (cleanedCompact.length < 12) return true;

    if (headingPath && /目录/.test(headingPath) && cleanedCompact.length < 40) return true;

    if (MD_HEADING_ONLY.test(s) && !/[。！？；]/.test(s)) return true;

    return false;
}

/** 就地清洗 corpus 通道 hit；不可用则返回 false */
export function sanitizeCorpusChannelHit(hit: {
    source: string;
    snippet?: string;
    referenceBlock?: string;
    headingPath?: string;
}): boolean {
    if (hit.source !== 'grep_md' && hit.source !== 'bm25' && hit.source !== 'vector') {
        return true;
    }
    const oldSnippet = hit.snippet || '';
    const cleaned = sanitizeGrepSnippetForExport(oldSnippet, hit.headingPath);
    if (!cleaned) return false;
    if (cleaned === oldSnippet.trim()) return true;

    hit.snippet = cleaned.slice(0, 500);
    if (hit.referenceBlock) {
        const block = hit.referenceBlock;
        const begin = block.match(/<!-- ai-proofread:grepHit begin[^>]*-->/);
        const end = block.match(/<!-- ai-proofread:grepHit end -->/);
        const header = block.match(/【文献摘录】[^\n]*/);
        if (begin && end && header) {
            hit.referenceBlock = [begin[0], header[0], '', cleaned, end[0]].join('\n');
        } else if (oldSnippet && block.includes(oldSnippet)) {
            hit.referenceBlock = block.replace(oldSnippet, cleaned);
        }
    }
    return true;
}

export function dedupeKeyForHit(relPath: string, startLine: number, endLine: number): string {
    return `${normalizeRelPath(relPath)}:${startLine}-${endLine}`;
}

export function basenameKey(relPath: string): string {
    return path.posix.basename(normalizeRelPath(relPath));
}
