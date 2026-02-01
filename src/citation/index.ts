/**
 * 引文核对模块
 */

export const citationModuleVersion = '0.0.1';
export { ReferenceStore, resolveReferencesPath, getCitationNormalizeOptions } from './referenceStore';
export type { ReferenceSentence, RefSentenceRow } from './referenceStore';
export {
    collectQuotedCitations,
    collectBlockquoteCitations,
    collectAllCitations,
    splitCitationBlocksIntoSentences
} from './citationCollector';
export type {
    CitationEntry,
    CitationSentence,
    CitationBlockWithSentences
} from './citationCollector';
