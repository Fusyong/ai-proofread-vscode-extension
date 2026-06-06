import type { CorpusHit, ReferencePrepGrepQuery, ReferencePrepPlanQuery, ReferencePrepStrength } from '../schema';
import { retrieveGrepHits } from './grepRetrievalService';

export { resetGrepHitCounter } from './grepRetrievalService';

export function executeGrepQuery(params: {
    query: ReferencePrepPlanQuery;
    grepBlock: ReferencePrepGrepQuery;
    priority: number;
    strength: ReferencePrepStrength;
    existingReference: string;
}): CorpusHit[] {
    return retrieveGrepHits({
        queries: [
            {
                queryId: params.query.queryId,
                patterns: params.grepBlock.patterns,
                priority: params.priority,
                contextLines: params.grepBlock.contextLines,
            },
        ],
        strength: params.strength,
        existingReference: params.existingReference,
    });
}
