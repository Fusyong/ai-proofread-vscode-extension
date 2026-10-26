/**
 * 把网页命中写成知识核查提示词能读的参考块。
 * 【网页】在提示词中的可信度低于词典与文献。
 */

import type { FactCheckHit } from './schema';

export function formatWebReferenceBlock(params: {
    title: string;
    url: string;
    summary: string;
    span: string;
    authority?: number;
}): string {
    const lines = [`【网页】${params.title.trim() || params.url}`, `URL: ${params.url.trim()}`];
    if (typeof params.authority === 'number' && Number.isFinite(params.authority) && params.authority >= 0) {
        lines.push(`权威度：${params.authority}`);
    }
    const summary = params.summary.replace(/\s+/g, ' ').trim();
    if (summary) lines.push(`摘录：${summary}`);
    lines.push(`对应断言：${params.span.trim()}`);
    return lines.join('\n');
}

export function referenceAlreadyContains(reference: string, url: string, span: string): boolean {
    const ref = reference ?? '';
    const u = url.trim();
    const s = span.trim();
    if (!u || !s) return false;
    return ref.includes(u) && ref.includes(`对应断言：${s}`);
}

export function sortHitsByAuthority(hits: FactCheckHit[]): FactCheckHit[] {
    return [...hits].sort((a, b) => {
        const aa = typeof a.authority === 'number' ? a.authority : -1;
        const bb = typeof b.authority === 'number' ? b.authority : -1;
        return bb - aa;
    });
}

export function appendHitsToReference(
    reference: string,
    span: string,
    hits: FactCheckHit[]
): { reference: string; added: number } {
    let ref = (reference ?? '').trimEnd();
    let added = 0;
    for (const hit of sortHitsByAuthority(hits)) {
        if (!hit.url.trim()) continue;
        if (referenceAlreadyContains(ref, hit.url, span)) continue;
        const block = formatWebReferenceBlock({
            title: hit.title,
            url: hit.url,
            summary: hit.summary,
            span,
            authority: hit.authority,
        });
        ref = ref ? `${ref}\n\n${block}` : block;
        added++;
    }
    return { reference: ref, added };
}
