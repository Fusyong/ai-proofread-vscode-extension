import type { EditorialPathBlock } from './types';

export function normalizeDocPath(s: string): string {
    return s.replace(/\\/g, '/').trim();
}

/** 宽窗：path 与 heading 在「前缀链」上相关（非兄弟分叉的粗判） */
export function pathsPrefixRelated(headingPath: string, blockPath: string): boolean {
    if (headingPath === '(无标题)' || blockPath === '(无标题)') {
        return false;
    }
    return (
        headingPath === blockPath ||
        headingPath.startsWith(blockPath + ' >') ||
        blockPath.startsWith(headingPath + ' >')
    );
}

/** 窄窗：祖先或自身，或 heading 下有限深度子节 */
export function pathMatchesAncestorChain(
    headingPath: string,
    blockPath: string,
    includeChildDepth: number
): boolean {
    if (headingPath === '(无标题)' || blockPath === '(无标题)') {
        return false;
    }
    const isAnc = headingPath === blockPath || headingPath.startsWith(blockPath + ' >');
    if (isAnc) {
        return true;
    }
    if (includeChildDepth <= 0) {
        return false;
    }
    if (!blockPath.startsWith(headingPath + ' >')) {
        return false;
    }
    const rest = blockPath.slice(headingPath.length + 3);
    const depth = rest ? rest.split(' > ').length : 0;
    return depth > 0 && depth <= includeChildDepth;
}

export function docMatches(block: EditorialPathBlock, documentId: string): boolean {
    if (!block.docRel) {
        return true;
    }
    return normalizeDocPath(block.docRel) === normalizeDocPath(documentId);
}

export function filterBlocksForDoc(blocks: EditorialPathBlock[], documentId: string): EditorialPathBlock[] {
    return blocks.filter((b) => docMatches(b, documentId));
}

export function scoreBlocksForReference(blocks: EditorialPathBlock[]): EditorialPathBlock[] {
    return [...blocks].sort((a, b) => b.attentionScore - a.attentionScore);
}

export function takeBlocksWithinCharBudget(
    blocks: EditorialPathBlock[],
    maxBlocks: number,
    maxChars: number
): EditorialPathBlock[] {
    const out: EditorialPathBlock[] = [];
    let used = 0;
    for (const b of blocks) {
        if (out.length >= maxBlocks) {
            break;
        }
        const len = b.fullRaw.length;
        if (out.length > 0 && used + len > maxChars) {
            break;
        }
        out.push(b);
        used += len;
    }
    return out;
}

export function buildMatchedSet(
    structureBlocks: EditorialPathBlock[],
    headingPath: string,
    documentId: string,
    mode: 'prefixThenNarrow' | 'ancestorChainOnly',
    includeChildDepth: number,
    maxChars: number
): EditorialPathBlock[] {
    const scoped = filterBlocksForDoc(structureBlocks, documentId);
    let cand =
        mode === 'ancestorChainOnly'
            ? scoped.filter((b) => pathMatchesAncestorChain(headingPath, b.path, includeChildDepth))
            : scoped.filter((b) => pathsPrefixRelated(headingPath, b.path));

    const charLen = (blocks: EditorialPathBlock[]) =>
        blocks.reduce((s, b) => s + b.fullRaw.length, 0);

    if (mode === 'prefixThenNarrow' && charLen(cand) > maxChars) {
        cand = scoped.filter((b) => pathMatchesAncestorChain(headingPath, b.path, includeChildDepth));
    }

    if (charLen(cand) <= maxChars) {
        return cand;
    }
    const sorted = scoreBlocksForReference(cand);
    const out: EditorialPathBlock[] = [];
    let used = 0;
    for (const b of sorted) {
        if (used + b.fullRaw.length > maxChars) {
            continue;
        }
        out.push(b);
        used += b.fullRaw.length;
    }
    return out;
}

export function buildReferenceSet(
    structureBlocks: EditorialPathBlock[],
    pendingBlocks: EditorialPathBlock[],
    headingPath: string,
    documentId: string,
    matched: EditorialPathBlock[],
    maxBlocks: number,
    maxChars: number
): EditorialPathBlock[] {
    const matchedKey = new Set(matched.map((b) => `${normalizeDocPath(b.docRel ?? '')}||${b.path}`));
    const all = [...filterBlocksForDoc(structureBlocks, documentId), ...pendingBlocks];
    const ref = all.filter((b) => !matchedKey.has(`${normalizeDocPath(b.docRel ?? '')}||${b.path}`));
    const sorted = scoreBlocksForReference(ref);
    return takeBlocksWithinCharBudget(sorted, maxBlocks, maxChars);
}

export function attentionForHeading(structureBlocks: EditorialPathBlock[], headingPath: string, documentId: string): number {
    const scoped = filterBlocksForDoc(structureBlocks, documentId);
    const hit = scoped.find((b) => b.path === headingPath);
    return hit?.attentionScore ?? 0;
}
