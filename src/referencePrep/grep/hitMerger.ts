export interface RawGrepLineHit {
    file: string;
    line: number;
    lineText: string;
    pattern: string;
    patternValue: number;
}

export interface MergedGrepHit {
    file: string;
    startLine: number;
    endLine: number;
    snippet: string;
    aggregatedValue: number;
}

const PROXIMITY_LINES = 5;

/**
 * 同行多 pattern：取 max(value)；邻近行合并；按价值降序。
 */
export function mergeGrepLineHits(
    hits: RawGrepLineHit[],
    opts: { maxHits: number; proximityLines?: number }
): MergedGrepHit[] {
    if (hits.length === 0) return [];
    const proximity = opts.proximityLines ?? PROXIMITY_LINES;

    const byFileLine = new Map<string, RawGrepLineHit>();
    for (const h of hits) {
        const key = `${h.file}:${h.line}`;
        const prev = byFileLine.get(key);
        if (!prev) {
            byFileLine.set(key, h);
        } else {
            byFileLine.set(key, {
                ...prev,
                patternValue: Math.max(prev.patternValue, h.patternValue),
            });
        }
    }

    const lines = [...byFileLine.values()].sort((a, b) => {
        if (a.file !== b.file) return a.file.localeCompare(b.file);
        return a.line - b.line;
    });

    const blocks: MergedGrepHit[] = [];
    let cur: MergedGrepHit | null = null;
    for (const h of lines) {
        const val = h.patternValue;
        if (
            cur &&
            cur.file === h.file &&
            h.line - cur.endLine <= proximity
        ) {
            cur.endLine = h.line;
            cur.snippet += '\n' + h.lineText;
            cur.aggregatedValue = Math.max(cur.aggregatedValue, val);
        } else {
            if (cur) blocks.push(cur);
            cur = {
                file: h.file,
                startLine: h.line,
                endLine: h.line,
                snippet: h.lineText,
                aggregatedValue: val,
            };
        }
    }
    if (cur) blocks.push(cur);

    blocks.sort((a, b) => b.aggregatedValue - a.aggregatedValue);
    return blocks.slice(0, opts.maxHits);
}
