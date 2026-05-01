import { normalizeLineEndings } from '../utils';
import type { EditorialPathBlock, ParsedEditorialMemory } from './types';

const HDR = '<!-- ai-proofread:editorial-memory v1 -->';
const SEC_GLOBAL = '## 全局';
const SEC_STRUCTURE = '## 按文档结构';
const SEC_RECENT = '## 近期记忆';
const SEC_PENDING = '## 结构已变更待核对';

export const DEFAULT_EDITORIAL_MEMORY_FILE = `${HDR}

${SEC_GLOBAL}

${SEC_STRUCTURE}

${SEC_RECENT}

${SEC_PENDING}

`;

function extractSection(content: string, title: string): { body: string; restParts: string[] } | null {
    const re = new RegExp(`^${title}\\s*$`, 'm');
    const m = content.match(re);
    if (!m || m.index === undefined) {
        return null;
    }
    const start = m.index + m[0].length;
    const tail = content.slice(start);
    const next = tail.search(/^## /m);
    const body = next === -1 ? tail : tail.slice(0, next);
    return { body, restParts: [] };
}

function parsePathRegion(regionBody: string): EditorialPathBlock[] {
    const text = regionBody.replace(/^\n+/, '');
    if (!text.trim()) {
        return [];
    }
    const lines = text.split('\n');
    const blocks: EditorialPathBlock[] = [];
    let i = 0;
    while (i < lines.length) {
        let docRel: string | undefined;
        const line = lines[i];
        if (line.startsWith('### doc:')) {
            docRel = line.replace(/^### doc:\s*/, '').trim();
            i++;
        }
        if (i >= lines.length) {
            break;
        }
        const pathLine = lines[i];
        const pm = pathLine.match(/^### path:\s*(.+)\s*$/);
        if (!pm) {
            i++;
            continue;
        }
        const path = pm[1].trim();
        const startIdx = docRel !== undefined ? i - 1 : i;
        i++;
        let attention = 0;
        if (i < lines.length) {
            const am = lines[i].match(/^<!--\s*attention_score:\s*(\d+)\s*-->\s*$/);
            if (am) {
                attention = parseInt(am[1], 10) || 0;
                i++;
            }
        }
        const bodyStart = i;
        while (i < lines.length && !lines[i].startsWith('### path:') && !lines[i].startsWith('### doc:')) {
            i++;
        }
        const blockLines = lines.slice(startIdx, i);
        blocks.push({
            docRel,
            path,
            attentionScore: attention,
            fullRaw: blockLines.join('\n').replace(/\n+$/, '') + '\n',
        });
    }
    return blocks;
}

export function parseEditorialMemory(raw: string): ParsedEditorialMemory {
    const content = normalizeLineEndings(raw);
    const preambleEnd = content.indexOf(SEC_GLOBAL);
    const preamble = preambleEnd === -1 ? '' : content.slice(0, preambleEnd).trimEnd();

    const g = extractSection(content, SEC_GLOBAL);
    const globalBody = g ? g.body.replace(/^\n+/, '').replace(/\n+$/, '') : '';

    const s = extractSection(content, SEC_STRUCTURE);
    const structureBlocks = s ? parsePathRegion(s.body) : [];

    const r = extractSection(content, SEC_RECENT);
    const recentSectionBody = r ? r.body.replace(/^\n+/, '').replace(/\n+$/, '') : '';

    const p = extractSection(content, SEC_PENDING);
    const pendingBlocks = p ? parsePathRegion(p.body) : [];

    return { preamble: preamble || HDR, globalBody, structureBlocks, recentSectionBody, pendingBlocks };
}

export function serializeEditorialMemory(p: ParsedEditorialMemory): string {
    const pre = p.preamble.trimEnd();
    const global = p.globalBody.trim() ? `${p.globalBody.trim()}\n` : '';
    const struct = p.structureBlocks.map((b) => b.fullRaw.trimEnd() + '\n').join('\n');
    const recent = p.recentSectionBody.trim() ? `${p.recentSectionBody.trim()}\n` : '';
    const pend = p.pendingBlocks.map((b) => b.fullRaw.trimEnd() + '\n').join('\n');

    return `${pre}

${SEC_GLOBAL}
${global ? global + '\n' : '\n'}${SEC_STRUCTURE}
${struct ? struct + '\n' : '\n'}${SEC_RECENT}
${recent ? recent + '\n' : '\n'}${SEC_PENDING}
${pend ? pend + '\n' : '\n'}
`;
}

export function upsertPathBlock(
    blocks: EditorialPathBlock[],
    path: string,
    docRel: string | undefined,
    bodyMd: string,
    preserveAttention: number | undefined
): EditorialPathBlock[] {
    const next = [...blocks];
    const idx = next.findIndex((b) => b.path === path && (b.docRel ?? '') === (docRel ?? ''));
    const att = preserveAttention ?? 0;
    const attLine = att > 0 ? `<!-- attention_score: ${att} -->\n` : '<!-- attention_score: 0 -->\n';
    const docLine = docRel ? `### doc: ${docRel}\n` : '';
    const fullRaw = `${docLine}### path: ${path}\n${attLine}${bodyMd.trim()}\n`;
    const block: EditorialPathBlock = {
        docRel,
        path,
        attentionScore: att,
        fullRaw,
    };
    if (idx >= 0) {
        next[idx] = block;
    } else {
        next.push(block);
    }
    return next;
}
