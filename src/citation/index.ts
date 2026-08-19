/**
 * 引文核对模块
 */

export const citationModuleVersion = '0.0.1';
export { ReferenceStore, resolveReferencesPath, getCitationNormalizeOptions } from './referenceStore';
export type { ReferenceSentence, RefSentenceRow, Bm25Hit } from './referenceStore';
export {
    collectQuotedCitations,
    collectBlockquoteCitations,
    collectAllCitations,
    citationEntryFromSelection,
    splitCitationBlocksIntoSentences
} from './citationCollector';
export { stripLeadingBlockquoteMarkers } from './stripBlockquote';
export type {
    CitationEntry,
    CitationSentence,
    CitationBlockWithSentences
} from './citationCollector';
