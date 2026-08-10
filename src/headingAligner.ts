/**
 * 对齐两个 Markdown 文件中指定级别的 ATX 标题。
 * 换行符约定：入口处统一为 LF，内部仅按 LF 按行处理。
 *
 * 序号与配套标记：
 * - 中文数字 [一二三四五六七八九十〇] → 标记 [、（）()]
 * - 阿拉伯数字 / 字母 → 标记 [.()]
 */

/**
 * 比较模式：
 * - fullText：去空白后比较全文
 * - serialOrFullText（默认）：两侧都有前部序号则只比序号；否则比全文
 */
export type HeadingAlignMode = 'fullText' | 'serialOrFullText';

export interface MdHeading {
    /** 1-based 行号（基于规范化 LF 文本） */
    line: number;
    level: number;
    /** 标题正文（不含 # 前缀） */
    text: string;
}

export type HeadingAlignMismatchReason =
    | 'content'
    | 'level'
    | 'missingLeft'
    | 'missingRight';

export interface HeadingAlignMismatch {
    index: number;
    reason: HeadingAlignMismatchReason;
    left?: MdHeading;
    right?: MdHeading;
    leftNormalized?: string;
    rightNormalized?: string;
}

export interface HeadingAlignResult {
    left: MdHeading[];
    right: MdHeading[];
    /** 首个对不齐处；undefined 表示全部对齐 */
    mismatch?: HeadingAlignMismatch;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

const CN_NUM_RE = /[一二三四五六七八九十〇]/;
const CN_NUM_CHAR_RE = /[一二三四五六七八九十〇]/;
const CN_OPEN_RE = /[、（(]/;
const CN_CLOSE_RE = /[、）)]/;
const CN_MARK_RE = /[、（）()]/g;

const AR_OPEN_RE = /[.(]/;
const AR_CLOSE_RE = /[.)]/;
const AR_MARK_RE = /[.()]/g;

/** 整题仅为中文序号 + 配套标记 */
const SERIAL_ONLY_CN_RE = /^[、（(]*[一二三四五六七八九十〇]+[、）)]*$/;

/** 整题仅为阿拉伯数字序号 + 配套标记 */
const SERIAL_ONLY_DIGIT_RE = /^[.(]*\d+[.)]*$/;

/** 整题仅为字母序号 + 配套标记，如 A. */
const SERIAL_ONLY_LETTER_RE = /^[.(]*[a-zA-Z]+[.)]+$/;

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 去掉全部空白 */
export function stripHeadingWhitespace(title: string): string {
    return title.replace(/\s+/g, '');
}

/**
 * 标题是否「只有前部序号+标记」（正文已省略）。
 * 例：`1` / `1.` / `(1)` / `一、` / `（一）` / `A.` → true
 * `1. 题干` / `2. B` / `十.`（点号非中文配套标记）→ false
 */
export function isOnlyLeadingSerial(title: string): boolean {
    const s = stripHeadingWhitespace(title);
    if (!s) {
        return false;
    }
    return SERIAL_ONLY_CN_RE.test(s) || SERIAL_ONLY_DIGIT_RE.test(s) || SERIAL_ONLY_LETTER_RE.test(s);
}

function stripMarksForSerial(raw: string): string {
    if (CN_NUM_RE.test(raw)) {
        return raw.replace(CN_MARK_RE, '');
    }
    return raw.replace(AR_MARK_RE, '');
}

/**
 * 提取标题最左侧一组序号（去掉配套标记后）。无有效序号则返回 null。
 * 只取最左侧一组，不吞后续字母选项/子序号。
 * 例：`1.` / `(1)` → `1`；`一、` / `（一）` → `一`；
 * `4. A. 徐特立` → `4`；`12.a)前言` → `12`；`2. B` → `2`；`A.概述` → `A`
 */
export function extractLeadingSerial(title: string): string | null {
    const s = stripHeadingWhitespace(title);
    if (!s) {
        return null;
    }

    if (isOnlyLeadingSerial(title)) {
        const serial = stripMarksForSerial(s);
        return serial.length > 0 ? serial : null;
    }

    // 1) 中文数字序号 + 标记 [、（）()]
    let i = 0;
    while (i < s.length && CN_OPEN_RE.test(s[i]!)) {
        i++;
    }
    const cnStart = i;
    while (i < s.length && CN_NUM_CHAR_RE.test(s[i]!)) {
        i++;
    }
    if (i > cnStart) {
        while (i < s.length && CN_CLOSE_RE.test(s[i]!)) {
            i++;
        }
        const serial = stripMarksForSerial(s.slice(0, i));
        return serial.length > 0 ? serial : null;
    }

    // 2) 阿拉伯数字序号 + 标记 [.()] —— 只取最左侧一组
    i = 0;
    while (i < s.length && AR_OPEN_RE.test(s[i]!)) {
        i++;
    }
    const digitStart = i;
    while (i < s.length && /\d/.test(s[i]!)) {
        i++;
    }
    if (i > digitStart) {
        while (i < s.length && AR_CLOSE_RE.test(s[i]!)) {
            i++;
        }
        const serial = stripMarksForSerial(s.slice(0, i));
        return serial.length > 0 ? serial : null;
    }

    // 3) 字母序号 + 标记 [.()]，须带标记（标题以字母序号开头时）
    i = 0;
    while (i < s.length && AR_OPEN_RE.test(s[i]!)) {
        i++;
    }
    if (i < s.length && /[a-zA-Z]/.test(s[i]!)) {
        let j = i;
        while (j < s.length && /[a-zA-Z]/.test(s[j]!)) {
            j++;
        }
        let k = j;
        while (k < s.length && AR_CLOSE_RE.test(s[k]!)) {
            k++;
        }
        if (k > j) {
            const serial = stripMarksForSerial(s.slice(0, k));
            return serial.length > 0 ? serial : null;
        }
    }

    return null;
}

/**
 * 提取 ATX 标题（按文档出现位置顺序）。
 * @param content 文档内容
 * @param levels 若给定，只保留这些级别；若省略则提取全部级别
 */
export function extractMdHeadings(content: string, levels?: number | number[]): MdHeading[] {
    const text = normalizeLineEndings(content);
    const lines = text.split('\n');
    const result: MdHeading[] = [];
    const levelSet =
        levels === undefined
            ? undefined
            : new Set(Array.isArray(levels) ? levels : [levels]);

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(HEADING_RE);
        if (!m) {
            continue;
        }
        const headingLevel = m[1].length;
        if (levelSet && !levelSet.has(headingLevel)) {
            continue;
        }
        result.push({
            line: i + 1,
            level: headingLevel,
            text: m[2].trimEnd(),
        });
    }

    return result;
}

/**
 * 规范化标题以便展示/对照。
 * - fullText：仅去空白
 * - serialOrFullText：有序号则取序号，否则去空白全文
 */
export function normalizeHeadingText(
    title: string,
    mode: HeadingAlignMode = 'serialOrFullText'
): string {
    if (mode === 'fullText') {
        return stripHeadingWhitespace(title);
    }
    return extractLeadingSerial(title) ?? stripHeadingWhitespace(title);
}

/**
 * 判断两标题是否对齐。
 * - fullText：去空白后全文相同
 * - serialOrFullText：两侧都有前部序号则只比序号；否则比全文（去空白）
 */
export function headingsEqual(
    left: string,
    right: string,
    mode: HeadingAlignMode = 'serialOrFullText'
): boolean {
    if (mode === 'fullText') {
        return stripHeadingWhitespace(left) === stripHeadingWhitespace(right);
    }

    const leftSerial = extractLeadingSerial(left);
    const rightSerial = extractLeadingSerial(right);
    if (leftSerial !== null && rightSerial !== null) {
        return leftSerial === rightSerial;
    }
    return stripHeadingWhitespace(left) === stripHeadingWhitespace(right);
}

/**
 * 解析用户输入的标题级别列表。
 * 支持半角/全角逗号分隔，如 `1,2,4` 或 `1，2，4`。
 * @returns 去重后的级别数组（1–6，保持输入顺序）；非法时返回错误信息
 */
export function parseHeadingLevels(input: string): { levels: number[] } | { error: string } {
    const parts = input
        .split(/[,，]/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

    if (parts.length === 0) {
        return { error: '请至少输入一个标题级别（1–6），多个用逗号分隔，如 1，2，4' };
    }

    const levels: number[] = [];
    const seen = new Set<number>();
    for (const part of parts) {
        if (!/^\d+$/.test(part)) {
            return { error: `无效级别「${part}」：请输入 1–6 的整数，多个用逗号分隔` };
        }
        const n = parseInt(part, 10);
        if (n < 1 || n > 6) {
            return { error: `级别 ${n} 超出范围，须在 1–6 之间` };
        }
        if (!seen.has(n)) {
            seen.add(n);
            levels.push(n);
        }
    }
    return { levels };
}

/**
 * 不对齐时的处理提示：优先处理哪一侧、在该侧往哪找。
 * left = 当前窗口（primary），right = 对侧窗口（secondary）
 */
export interface HeadingAlignFixHint {
    /** 优先处理的一侧 */
    preferSide: 'left' | 'right' | 'both';
    /** 在优先侧的查找位置：本处 / 往上 / 往下 */
    direction: 'here' | 'up' | 'down';
    /** 一行可读的处置建议 */
    action: string;
}

function headingsPairEqual(a: MdHeading, b: MdHeading, mode: HeadingAlignMode): boolean {
    return a.level === b.level && headingsEqual(a.text, b.text, mode);
}

/**
 * 根据不对齐处及前后项，推断更可能该处理哪一侧、往上还是往下。
 */
export function diagnoseHeadingMismatch(
    left: MdHeading[],
    right: MdHeading[],
    mismatch: HeadingAlignMismatch,
    mode: HeadingAlignMode = 'serialOrFullText'
): HeadingAlignFixHint {
    const i = mismatch.index;
    const LOOKAHEAD = 8;

    if (mismatch.reason === 'missingLeft') {
        return {
            preferSide: 'left',
            direction: 'down',
            action: '当前侧标题已用尽、对侧仍有 → 优先在当前侧从上一对齐处往下补标题；或在对侧本处往上检查是否多标了标题。',
        };
    }
    if (mismatch.reason === 'missingRight') {
        return {
            preferSide: 'right',
            direction: 'down',
            action: '对侧标题已用尽、当前侧仍有 → 优先在对侧从上一对齐处往下补标题；或在当前侧本处往上检查是否多标了标题。',
        };
    }

    const L = left[i];
    const R = right[i];
    if (!L || !R) {
        return {
            preferSide: 'both',
            direction: 'here',
            action: '请在两侧已跳转位置核对标题。',
        };
    }

    // 当前侧本项 = 对侧下一项 → 对侧本处多了一项
    if (right[i + 1] && headingsPairEqual(L, right[i + 1], mode)) {
        return {
            preferSide: 'right',
            direction: 'here',
            action: '对侧本处多了一项（其下一项才与当前侧对齐）→ 优先在对侧本处删改多余标题。',
        };
    }
    // 对侧本项 = 当前侧下一项 → 当前侧本处多了一项
    if (left[i + 1] && headingsPairEqual(R, left[i + 1], mode)) {
        return {
            preferSide: 'left',
            direction: 'here',
            action: '当前侧本处多了一项（其下一项才与对侧对齐）→ 优先在当前侧本处删改多余标题。',
        };
    }

    // 当前侧本项在对侧更下方才出现 → 对侧中间多了，从本处往上删；或当前侧往下缺了
    for (let j = i + 2; j < Math.min(i + LOOKAHEAD, right.length); j++) {
        if (headingsPairEqual(L, right[j], mode)) {
            const gap = j - i;
            return {
                preferSide: 'right',
                direction: 'up',
                action: `对侧在本处之后约 ${gap} 项才与当前侧对齐 → 优先在对侧从本处往上删改多余标题；若是当前侧缺课，则在当前侧本处往下补。`,
            };
        }
    }
    // 对侧本项在当前侧更下方才出现
    for (let j = i + 2; j < Math.min(i + LOOKAHEAD, left.length); j++) {
        if (headingsPairEqual(R, left[j], mode)) {
            const gap = j - i;
            return {
                preferSide: 'left',
                direction: 'up',
                action: `当前侧在本处之后约 ${gap} 项才与对侧对齐 → 优先在当前侧从本处往上删改多余标题；若是对侧缺课，则在对侧本处往下补。`,
            };
        }
    }

    if (mismatch.reason === 'level') {
        return {
            preferSide: 'both',
            direction: 'here',
            action: '两侧本处级别不同 → 在级别不对的一侧本处改正 # 数量。',
        };
    }

    return {
        preferSide: 'both',
        direction: 'here',
        action: '两侧本处标题内容不一致 → 在需改的一侧本处改文字；若属缺课/多课，再结合上下邻近标题判断往上删还是往下补。',
    };
}

/**
 * 在所选级别内，按文档出现位置顺序对齐两侧标题；一旦对不齐即返回首个差异。
 * 每一对还须级别相同，且标题内容符合比较模式。
 */
export function alignHeadings(
    leftContent: string,
    rightContent: string,
    levels: number | number[],
    mode: HeadingAlignMode = 'serialOrFullText'
): HeadingAlignResult {
    const levelList = Array.isArray(levels) ? levels : [levels];
    const left = extractMdHeadings(leftContent, levelList);
    const right = extractMdHeadings(rightContent, levelList);
    const n = Math.max(left.length, right.length);

    for (let i = 0; i < n; i++) {
        const L = left[i];
        const R = right[i];

        if (!L) {
            return {
                left,
                right,
                mismatch: { index: i, reason: 'missingLeft', right: R },
            };
        }
        if (!R) {
            return {
                left,
                right,
                mismatch: { index: i, reason: 'missingRight', left: L },
            };
        }

        if (L.level !== R.level) {
            return {
                left,
                right,
                mismatch: {
                    index: i,
                    reason: 'level',
                    left: L,
                    right: R,
                    leftNormalized: `H${L.level}`,
                    rightNormalized: `H${R.level}`,
                },
            };
        }

        if (!headingsEqual(L.text, R.text, mode)) {
            return {
                left,
                right,
                mismatch: {
                    index: i,
                    reason: 'content',
                    left: L,
                    right: R,
                    leftNormalized: normalizeHeadingText(L.text, mode),
                    rightNormalized: normalizeHeadingText(R.text, mode),
                },
            };
        }
    }

    return { left, right };
}
