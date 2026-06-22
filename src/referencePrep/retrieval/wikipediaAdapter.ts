import type { ReferencePrepPlanQuery, CorpusHit, ReferencePrepStrength, WikipediaLang } from '../schema';
import { getWikipediaConfig, getWikipediaBudgetForStrength } from '../config';
import { getStrengthPreset } from '../config';
import { formatWikipediaReferenceBlock } from '../wikipedia/formatReferenceBlock';
import { getWikimediaClient } from '../wikipedia/wikimediaClient';

let hitCounter = 0;

export function resetWikipediaHitCounter(): void {
    hitCounter = 0;
}

function nextHitId(): string {
    hitCounter += 1;
    return `h-wiki-${hitCounter}`;
}

function resolveLang(queryLang: WikipediaLang | undefined, globalDefault: WikipediaLang): WikipediaLang {
    if (queryLang === 'zh' || queryLang === 'en') return queryLang;
    return globalDefault;
}

function isDisambiguationPage(title: string, flag?: boolean): boolean {
    return Boolean(flag) || /消歧义|disambiguation/i.test(title);
}

export async function executeWikipediaQuery(params: {
    query: ReferencePrepPlanQuery;
    wikiBlock: NonNullable<ReferencePrepPlanQuery['wikipedia']>;
    existingReference: string;
    priority: number;
    strength: ReferencePrepStrength;
    roundId?: string;
    requestsBudget: { used: number; max: number };
}): Promise<{ hits: CorpusHit[]; requestsUsed: number }> {
    const globalConfig = getWikipediaConfig();
    const preset = getStrengthPreset(params.strength);
    const maxExtractChars = Math.min(globalConfig.maxExtractChars, preset.wikipediaMaxExtractChars);
    const maxHits = preset.wikipediaMaxHitsPerRound;

    const client = getWikimediaClient();
    const budgetMax = params.requestsBudget.max - params.requestsBudget.used;
    if (budgetMax <= 0 || client.isBudgetExhausted()) {
        return { hits: [], requestsUsed: 0 };
    }
    client.resetSessionBudget(budgetMax);

    const lang = resolveLang(params.wikiBlock.lang, globalConfig.defaultLang);
    const includeWikidata =
        params.wikiBlock.includeWikidata !== false && globalConfig.includeWikidata;

    const titlesToFetch: string[] = [];
    const searchTerms = (params.wikiBlock.searchTerms ?? []).slice(0, 3);
    const directTitles = (params.wikiBlock.titles ?? []).slice(0, 3);

    for (const t of directTitles) {
        const s = t.trim();
        if (s) titlesToFetch.push(s);
    }

    for (const term of searchTerms) {
        if (client.isBudgetExhausted() || client.isPaused()) break;
        const title = await client.searchTitle(lang, term);
        if (title) titlesToFetch.push(title);
    }

    if (titlesToFetch.length === 0 && searchTerms.length > 0 && globalConfig.fallbackLang !== lang) {
        for (const term of searchTerms) {
            if (client.isBudgetExhausted() || client.isPaused()) break;
            const title = await client.searchTitle(globalConfig.fallbackLang, term);
            if (title) titlesToFetch.push(title);
        }
    }

    const uniqueTitles = [...new Set(titlesToFetch)].slice(0, maxHits);
    if (uniqueTitles.length === 0) {
        const used = client.getRequestsUsed();
        params.requestsBudget.used += used;
        return { hits: [], requestsUsed: used };
    }

    const fetchLang = lang;
    let pages = await client.fetchPages(fetchLang, uniqueTitles);

    if (pages.length === 0 && globalConfig.fallbackLang !== lang) {
        pages = await client.fetchPages(globalConfig.fallbackLang, uniqueTitles);
    }

    const hits: CorpusHit[] = [];
    const seenDigest = new Set<string>();

    for (const page of pages) {
        if (hits.length >= maxHits) break;
        if (isDisambiguationPage(page.title, page.disambiguation)) {
            continue;
        }
        if (!page.extract) continue;

        let claimsSummary = '';
        if (includeWikidata && page.wikidataId) {
            claimsSummary = await client.fetchWikidataSummary(page.wikidataId);
        }

        const extract =
            page.extract.length > maxExtractChars
                ? page.extract.slice(0, maxExtractChars) + '…'
                : page.extract;

        const { block, digest } = formatWikipediaReferenceBlock({
            lang: page.lang,
            title: page.title,
            url: page.url,
            extract,
            wikidataId: page.wikidataId,
            claimsSummary: claimsSummary || undefined,
        });

        if (params.existingReference.includes(block) || seenDigest.has(digest)) {
            continue;
        }
        seenDigest.add(digest);

        const baseValue = directTitles.includes(page.title) ? 0.85 : 0.7;
        hits.push({
            hitId: nextHitId(),
            source: 'wikipedia',
            queryId: params.query.queryId,
            baseValue,
            aggregatedValue: baseValue,
            snippet: extract.slice(0, 500),
            digest,
            referenceBlock: block,
            status: 'active',
            kind: 'evidence',
            llmPriority: params.priority,
            roundId: params.roundId,
            pageTitle: page.title,
            pageUrl: page.url,
            wikiLang: page.lang,
            wikidataId: page.wikidataId,
            wikidataClaims: claimsSummary || undefined,
        });
    }

    const requestsUsed = client.getRequestsUsed();
    params.requestsBudget.used += requestsUsed;

    return { hits, requestsUsed };
}

export function getWikipediaBudgetForRun(strength: ReferencePrepStrength): number {
    return getWikipediaBudgetForStrength(strength);
}
