/**
 * 检查字词：根据「更好的字词」合并 raw_notes / usage_notes，提供简短版（tooltip）与完整版（查看说明）
 * 规划见 docs/xh7-word-check-plan.md
 */

import type { WordCheckNotes } from './types';
import { getNotes } from './tableLoader';

/** tooltip 最大字符数，超出截断并加「… 详见说明」 */
const TOOLTIP_MAX_LEN = 200;

/** 简单去除 HTML 标签（用于纯文本 tooltip） */
function stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, '').trim();
}

function joinNotes(notes: WordCheckNotes): string {
    const parts: string[] = [];
    if (notes.raw?.length) parts.push(...notes.raw);
    if (notes.usage?.length) parts.push(...notes.usage);
    return parts.join('\n').trim();
}

/**
 * 简短版注释，用于 TreeItem.tooltip（截断至 TOOLTIP_MAX_LEN，过长加「… 详见说明」）
 * @param variant 可选，用于 tgscc 按「需要提示的词」取 notes
 */
export function getShortNotesForPreferred(preferred: string, variant?: string): string {
    const notes = getNotes(preferred, variant);
    const full = joinNotes(notes);
    if (!full) return '';
    const plain = stripHtml(full);
    if (plain.length <= TOOLTIP_MAX_LEN) return plain;
    return plain.slice(0, TOOLTIP_MAX_LEN) + '… 详见说明';
}

/**
 * 完整版注释，用于「查看说明」Webview（可保留 HTML）
 * @param variant 可选，用于 tgscc 按「需要提示的词」取 notes
 */
export function getFullNotesForPreferred(preferred: string, variant?: string): { raw: string[]; usage: string[] } {
    const notes = getNotes(preferred, variant);
    return {
        raw: notes.raw ?? [],
        usage: notes.usage ?? [],
    };
}

/**
 * 将完整注释格式化为 HTML 片段，供 Webview 展示
 */
export function formatFullNotesAsHtml(preferred: string, variant: string): string {
    const { raw, usage } = getFullNotesForPreferred(preferred, variant);
    const sections: string[] = [];
    if (raw.length > 0) {
        sections.push('<h4>字形/原始说明</h4>', '<div class="notes">' + raw.join('<br/>') + '</div>');
    }
    if (usage.length > 0) {
        sections.push('<h4>用法说明</h4>', '<div class="notes">' + usage.join('<br/>') + '</div>');
    }
    if (sections.length === 0) {
        return `<p>「${preferred}」暂无说明。</p>`;
    }
    return `<p><strong>${variant}</strong> → <strong>${preferred}</strong></p>` + sections.join('');
}
