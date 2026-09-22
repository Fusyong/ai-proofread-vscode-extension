/**
 * 文档级句子对齐入口：锚点算法 / 词流反解（可回退锚点）
 */

import {
    alignSentencesAnchor,
    type AlignmentAlgorithm,
    type AlignmentItem,
    type AlignmentOptions
} from './sentenceAligner';
import { splitChineseSentencesWithOffsets } from './splitter';
import {
    detectSentenceReorder,
    projectSentencePairsFromWordDiff
} from './wordDiffSentenceProjection';

export type { AlignmentAlgorithm };
export type DocumentAlignmentOptions = AlignmentOptions;

export interface DocumentAlignmentResult {
    alignment: AlignmentItem[];
    /** 实际采用的算法（可能因回退与请求不同） */
    usedAlgorithm: AlignmentAlgorithm;
    fellBackToAnchor: boolean;
    sentencesA: string[];
    sentencesB: string[];
    lineNumbersA: number[];
    lineNumbersB: number[];
}

export function attachAlignmentLineNumbers(
    alignment: AlignmentItem[],
    lineNumbersA: number[],
    lineNumbersB: number[]
): void {
    for (const item of alignment) {
        if (item.a_indices && item.a_indices.length > 0) {
            item.a_line_numbers = item.a_indices.map(i => lineNumbersA[i]);
            item.a_line_number = lineNumbersA[item.a_indices[0]];
        } else if (item.a_index !== undefined && item.a_index !== null) {
            item.a_line_number = lineNumbersA[item.a_index];
            item.a_line_numbers = [lineNumbersA[item.a_index]];
        }

        if (item.b_indices && item.b_indices.length > 0) {
            item.b_line_numbers = item.b_indices.map(i => lineNumbersB[i]);
            item.b_line_number = lineNumbersB[item.b_indices[0]];
        } else if (item.b_index !== undefined && item.b_index !== null) {
            item.b_line_number = lineNumbersB[item.b_index];
            item.b_line_numbers = [lineNumbersB[item.b_index]];
        }
    }
}

/**
 * 对两篇全文做句子对齐（含分句、可选词流反解与回退）。
 */
export function alignDocuments(
    textA: string,
    textB: string,
    options: DocumentAlignmentOptions = {}
): DocumentAlignmentResult {
    const algorithm = options.algorithm ?? 'anchor';
    const fallback = options.wordDiffFallbackToAnchor !== false;

    const minSentenceChars = options.minSentenceChars ?? 8;
    const spansA = splitChineseSentencesWithOffsets(textA, true, minSentenceChars);
    const spansB = splitChineseSentencesWithOffsets(textB, true, minSentenceChars);
    const sentencesA = spansA.map(s => s.sentence);
    const sentencesB = spansB.map(s => s.sentence);
    const lineNumbersA = spansA.map(s => s.startLine);
    const lineNumbersB = spansB.map(s => s.startLine);

    const runAnchor = (): AlignmentItem[] =>
        alignSentencesAnchor(sentencesA, sentencesB, options);

    if (algorithm === 'anchor') {
        const alignment = runAnchor();
        attachAlignmentLineNumbers(alignment, lineNumbersA, lineNumbersB);
        options.algorithm = 'anchor';
        options.algorithmDisplayName = algorithmDisplayName('anchor');
        return {
            alignment,
            usedAlgorithm: 'anchor',
            fellBackToAnchor: false,
            sentencesA,
            sentencesB,
            lineNumbersA,
            lineNumbersB
        };
    }

    let alignment = projectSentencePairsFromWordDiff(textA, textB, options, spansA, spansB);
    let usedAlgorithm: AlignmentAlgorithm = 'wordDiff';
    let fellBackToAnchor = false;

    if (fallback && detectSentenceReorder(alignment, options, sentencesA, sentencesB)) {
        alignment = runAnchor();
        usedAlgorithm = 'anchor';
        fellBackToAnchor = true;
    }

    attachAlignmentLineNumbers(alignment, lineNumbersA, lineNumbersB);
    options.algorithm = fellBackToAnchor ? 'anchor' : 'wordDiff';
    options.algorithmDisplayName = algorithmDisplayName(
        fellBackToAnchor ? 'anchor' : 'wordDiff',
        fellBackToAnchor
    );
    return {
        alignment,
        usedAlgorithm,
        fellBackToAnchor,
        sentencesA,
        sentencesB,
        lineNumbersA,
        lineNumbersB
    };
}

export function algorithmDisplayName(
    algorithm: AlignmentAlgorithm,
    fellBackToAnchor = false
): string {
    if (fellBackToAnchor) {
        return '词流反解→锚点（调序回退）';
    }
    if (algorithm === 'wordDiff') {
        return '词流反解';
    }
    return '锚点算法';
}
