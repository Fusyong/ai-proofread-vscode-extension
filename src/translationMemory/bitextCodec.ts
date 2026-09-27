/**
 * 翻译过程输出编解码：`<bitext><s>…</s><t>…</t></bitext>` + `<term>` + 可选 `<key_examples>`。
 */

export interface KeyExample {
    source: string;
    target: string;
    note?: string;
}

export interface TermPair {
    source: string;
    target: string;
}

export interface ParseBitextResult {
    ok: boolean;
    sourceRaw: string;
    targetRaw: string;
    /** 剥除 `<term>` 后的源/译 */
    sourcePlain: string;
    targetPlain: string;
    terms: TermPair[];
    keyExamples: KeyExample[];
    warnings: string[];
    /** 源侧与输入归一化后是否全等 */
    sourceMatchesInput?: boolean;
}

const TERM_RE = /<term>([\s\S]*?)<\/term>/gi;

export function stripTermTags(text: string): string {
    return String(text ?? '').replace(TERM_RE, '$1');
}

export function extractTermContents(text: string): string[] {
    const out: string[] = [];
    const re = /<term>([\s\S]*?)<\/term>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        out.push(m[1].trim());
    }
    return out;
}

/** 归一化：统一 EOL 为 \n，不压缩段内空白 */
export function normalizeForSourceCompare(text: string): string {
    return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function extractTag(html: string, tag: string): string | null {
    const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = html.match(re);
    return m ? m[1] : null;
}

function parseKeyExamples(raw: string): KeyExample[] {
    const block = extractTag(raw, 'key_examples');
    if (block == null) {
        return [];
    }
    const examples: KeyExample[] = [];
    const exRe = /<ex>([\s\S]*?)<\/ex>/gi;
    let m: RegExpExecArray | null;
    while ((m = exRe.exec(block)) !== null) {
        const inner = m[1];
        const s = extractTag(inner, 's');
        const t = extractTag(inner, 't');
        if (s == null || t == null) {
            continue;
        }
        const note = extractTag(inner, 'note');
        examples.push({
            source: stripTermTags(s).trim(),
            target: stripTermTags(t).trim(),
            note: note != null ? note.trim() : undefined,
        });
    }
    return examples;
}

/**
 * 解析模型过程输出。支持外层可选 `<bitext>`。
 */
export function parseTranslateProcessOutput(raw: string, inputUnit?: string): ParseBitextResult {
    const warnings: string[] = [];
    const text = String(raw ?? '').trim();
    let s = extractTag(text, 's');
    let t = extractTag(text, 't');
    if (s == null || t == null) {
        const bitext = extractTag(text, 'bitext');
        if (bitext != null) {
            s = extractTag(bitext, 's');
            t = extractTag(bitext, 't');
        }
    }
    if (s == null || t == null) {
        return {
            ok: false,
            sourceRaw: '',
            targetRaw: '',
            sourcePlain: '',
            targetPlain: text,
            terms: [],
            keyExamples: [],
            warnings: ['未找到成对的 <s>/<t>；已将全文视为译文候选'],
        };
    }

    const sourceTerms = extractTermContents(s);
    const targetTerms = extractTermContents(t);
    if (sourceTerms.length !== targetTerms.length) {
        warnings.push(`<term> 左右数量不一致：源 ${sourceTerms.length}，译 ${targetTerms.length}`);
    }
    const n = Math.min(sourceTerms.length, targetTerms.length);
    const terms: TermPair[] = [];
    for (let i = 0; i < n; i++) {
        if (sourceTerms[i] && targetTerms[i]) {
            terms.push({ source: sourceTerms[i], target: targetTerms[i] });
        }
    }

    const sourcePlain = stripTermTags(s);
    const targetPlain = stripTermTags(t);
    let sourceMatchesInput: boolean | undefined;
    if (inputUnit != null) {
        sourceMatchesInput =
            normalizeForSourceCompare(sourcePlain) === normalizeForSourceCompare(inputUnit);
        if (!sourceMatchesInput) {
            warnings.push('源侧 <s> 去掉 <term> 后与输入单元不完全一致');
        }
    }

    return {
        ok: true,
        sourceRaw: s,
        targetRaw: t,
        sourcePlain,
        targetPlain,
        terms,
        keyExamples: parseKeyExamples(text),
        warnings,
        sourceMatchesInput,
    };
}

/** 从过程文本或已解析结果取交付译文 */
export function cleanTranslateDelivery(rawOrParsed: string | ParseBitextResult): string {
    if (typeof rawOrParsed === 'string') {
        const p = parseTranslateProcessOutput(rawOrParsed);
        return p.targetPlain.trimEnd();
    }
    return rawOrParsed.targetPlain.trimEnd();
}
