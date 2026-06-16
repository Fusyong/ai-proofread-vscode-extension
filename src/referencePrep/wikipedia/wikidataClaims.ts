/** Wikidata 属性白名单与摘要格式化（无 VS Code 依赖，便于单测） */

export const WIKIDATA_PROPERTY_LABELS: Record<string, string> = {
    P569: '出生',
    P570: '死亡',
    P571: '成立',
    P576: '解散',
    P27: '国籍',
    P31: '类型',
    P106: '职业',
};

function formatWikidataTime(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const v = value as { time?: string; precision?: number };
    if (!v.time) return '';
    const m = v.time.match(/^([+-]?\d{4})/);
    if (m) return m[1].replace(/^\+/, '');
    return v.time.replace(/^\+/, '').slice(0, 10);
}

function extractClaimValue(mainsnak: unknown): string {
    if (!mainsnak || typeof mainsnak !== 'object') return '';
    const snak = mainsnak as { datavalue?: { value?: unknown; type?: string } };
    const dv = snak.datavalue;
    if (!dv) return '';
    if (dv.type === 'time') {
        return formatWikidataTime(dv.value);
    }
    if (dv.type === 'wikibase-entityid') {
        const ent = dv.value as { id?: string };
        return ent?.id ?? '';
    }
    if (typeof dv.value === 'string') return dv.value;
    return '';
}

function pickBestStatement(statements: unknown[]): unknown | null {
    if (!Array.isArray(statements) || statements.length === 0) return null;
    const preferred = statements.find(
        (s) => s && typeof s === 'object' && (s as { rank?: string }).rank === 'preferred'
    );
    return preferred ?? statements[0];
}

export function summarizeWikidataClaims(entities: Record<string, unknown>, qid: string): string {
    const entity = entities[qid] as
        | { claims?: Record<string, unknown[]>; labels?: Record<string, { value?: string }> }
        | undefined;
    if (!entity?.claims) return '';
    const parts: string[] = [];
    for (const [pid, label] of Object.entries(WIKIDATA_PROPERTY_LABELS)) {
        const stmts = entity.claims[pid];
        if (!Array.isArray(stmts) || stmts.length === 0) continue;
        const st = pickBestStatement(stmts) as { mainsnak?: unknown } | null;
        if (!st) continue;
        let val = extractClaimValue(st.mainsnak);
        if (val.startsWith('Q')) {
            const ent = entities[val] as { labels?: Record<string, { value?: string }> } | undefined;
            val = ent?.labels?.zh?.value ?? ent?.labels?.en?.value ?? val;
        }
        if (val) parts.push(`${label} ${val}`);
    }
    return parts.join('；');
}
