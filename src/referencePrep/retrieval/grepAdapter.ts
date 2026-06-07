import type { CorpusHit, ReferencePrepGrepQuery, ReferencePrepPlanQuery, ReferencePrepStrength } from '../schema';
import type { ResourceScope } from '../schema';
import { retrieveGrepHits } from './grepRetrievalService';

export { resetGrepHitCounter } from './grepRetrievalService';

export function executeGrepQuery(params: {
    query: ReferencePrepPlanQuery;
    grepBlock: ReferencePrepGrepQuery;
    priority: number;
    strength: ReferencePrepStrength;
    existingReference: string;
    scope?: ResourceScope;
    referencesRoot?: string;
    roundId?: string;
}): CorpusHit[] {
    return retrieveGrepHits({
        queries: [
            {
                queryId: params.query.queryId,
                patterns: params.grepBlock.patterns,
                priority: params.priority,
                contextLines: params.grepBlock.contextLines,
                unit: params.grepBlock.unit,
                scopePaths: params.grepBlock.scopePaths,
            },
        ],
        strength: params.strength,
        existingReference: params.existingReference,
        scope: params.scope,
        referencesRoot: params.referencesRoot,
        roundId: params.roundId,
    });
}
