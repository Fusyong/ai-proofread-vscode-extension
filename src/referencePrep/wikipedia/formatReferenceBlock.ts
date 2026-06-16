import { digestSha1 } from '../../localDict/dictLookupShared';
import type { WikipediaLang } from '../schema';

export function buildWikipediaHitBeginTag(digest: string): string {
    return `<!-- ai-proofread:wikipediaHit begin sha1=${digest} -->`;
}

export function buildWikipediaHitEndTag(): string {
    return `<!-- ai-proofread:wikipediaHit end -->`;
}

export function formatWikipediaReferenceBlock(params: {
    lang: WikipediaLang;
    title: string;
    url: string;
    extract: string;
    wikidataId?: string;
    claimsSummary?: string;
}): { block: string; digest: string } {
    const bodyParts = [
        `【维基百科·${params.lang}】${params.title}`,
        `URL: ${params.url}`,
    ];
    if (params.wikidataId) {
        bodyParts.push(`Wikidata: ${params.wikidataId}`);
    }
    bodyParts.push(`摘录：${params.extract}`);
    if (params.claimsSummary?.trim()) {
        bodyParts.push(`结构化：${params.claimsSummary.trim()}`);
    }
    const body = bodyParts.join('\n');
    const digest = digestSha1(`${params.lang}|${params.title}|${params.extract.slice(0, 200)}`);
    const block = [buildWikipediaHitBeginTag(digest), body, buildWikipediaHitEndTag()].join('\n');
    return { block, digest };
}
