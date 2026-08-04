import type { ReferencePrepIntent, ReferenceSourceId } from '../schema';

/** intent 映射到的候选来源（按优先级） */
export function sourcesForIntent(intent: ReferencePrepIntent): ReferenceSourceId[] {
    switch (intent) {
        case 'entity_name':
        case 'term_norm':
            return ['dict', 'grep_md', 'bm25', 'vector', 'wikipedia', 'web'];
        case 'word_usage':
            return ['dict', 'grep_md', 'bm25', 'vector'];
        case 'citation':
            return ['grep_md', 'bm25', 'vector'];
        case 'general_fact':
            return ['grep_md', 'bm25', 'vector', 'dict', 'wikipedia', 'web'];
        default:
            return ['dict', 'grep_md', 'bm25', 'vector'];
    }
}

export function resolveSourcesForQuery(
    intent: ReferencePrepIntent,
    enabledSources: ReferenceSourceId[]
): ReferenceSourceId[] {
    const enabled = new Set(enabledSources);
    return sourcesForIntent(intent).filter((s) => enabled.has(s));
}
