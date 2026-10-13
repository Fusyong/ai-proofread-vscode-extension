/**
 * 正文不分词的字面多模式匹配。
 * 按查找串从长到短占用区间；同一段正文只归属一条更长（同长则表中更靠前）的查找串。
 * 与 String#indexOf 一样按 UTF-16 码元比较，不调用分词。
 */

export interface LiteralMatch {
    start: number;
    end: number;
    variant: string;
    preferred: string;
}

interface AcOut {
    variant: string;
    preferred: string;
    len: number;
    /** 越小越优先：先词长降序，同长保持词表插入顺序 */
    priority: number;
}

interface AcNode {
    next: Map<number, AcNode>;
    fail: AcNode | null;
    outputs: AcOut[];
}

const automatonCache = new WeakMap<Record<string, string>, AcNode>();

function newNode(): AcNode {
    return { next: new Map(), fail: null, outputs: [] };
}

function buildAutomaton(dict: Record<string, string>): AcNode {
    const cached = automatonCache.get(dict);
    if (cached) return cached;

    const root = newNode();
    root.fail = root;

    const entries: { variant: string; preferred: string; index: number }[] = [];
    let index = 0;
    for (const variant of Object.keys(dict)) {
        const preferred = dict[variant];
        if (!variant || !preferred) continue;
        entries.push({ variant, preferred, index });
        index++;
    }
    const ranked = [...entries].sort((a, b) => b.variant.length - a.variant.length || a.index - b.index);
    const priority = new Map<string, number>();
    for (let i = 0; i < ranked.length; i++) priority.set(ranked[i].variant, i);

    for (const { variant, preferred } of entries) {
        let node = root;
        for (let i = 0; i < variant.length; i++) {
            const code = variant.charCodeAt(i);
            let next = node.next.get(code);
            if (!next) {
                next = newNode();
                node.next.set(code, next);
            }
            node = next;
        }
        node.outputs.push({
            variant,
            preferred,
            len: variant.length,
            priority: priority.get(variant) ?? 0,
        });
    }

    const queue: AcNode[] = [];
    for (const child of root.next.values()) {
        child.fail = root;
        queue.push(child);
    }
    let head = 0;
    while (head < queue.length) {
        const cur = queue[head++];
        for (const [code, child] of cur.next) {
            let fail = cur.fail ?? root;
            while (fail !== root && !fail.next.has(code)) fail = fail.fail ?? root;
            const linked = fail.next.get(code) ?? root;
            child.fail = linked === child ? root : linked;
            queue.push(child);
        }
    }

    automatonCache.set(dict, root);
    return root;
}

/**
 * 在 text 中找出 dict（查找串 → 建议串）的不重叠命中。
 * 先接受更长的查找串；同长时先接受词表中更靠前的一条。
 */
export function findLiteralMatches(
    text: string,
    dict: Record<string, string>,
    isCancelled?: () => boolean
): LiteralMatch[] {
    if (!text || Object.keys(dict).length === 0) return [];

    const root = buildAutomaton(dict);
    const pending: (LiteralMatch & { priority: number })[] = [];
    let node = root;

    for (let i = 0; i < text.length; i++) {
        if ((i & 8191) === 0 && isCancelled?.()) break;
        const code = text.charCodeAt(i);
        while (node !== root && !node.next.has(code)) node = node.fail ?? root;
        node = node.next.get(code) ?? root;
        let outNode: AcNode | null = node;
        while (outNode && outNode !== root) {
            for (const item of outNode.outputs) {
                pending.push({
                    start: i + 1 - item.len,
                    end: i + 1,
                    variant: item.variant,
                    preferred: item.preferred,
                    priority: item.priority,
                });
            }
            outNode = outNode.fail;
        }
    }

    pending.sort((a, b) => a.priority - b.priority || a.start - b.start);
    const covered = new Uint8Array(text.length);
    const accepted: LiteralMatch[] = [];
    for (let i = 0; i < pending.length; i++) {
        if ((i & 1023) === 0 && isCancelled?.()) break;
        const m = pending[i];
        let overlap = false;
        for (let p = m.start; p < m.end; p++) {
            if (covered[p]) {
                overlap = true;
                break;
            }
        }
        if (overlap) continue;
        for (let p = m.start; p < m.end; p++) covered[p] = 1;
        accepted.push({ start: m.start, end: m.end, variant: m.variant, preferred: m.preferred });
    }
    accepted.sort((a, b) => a.start - b.start || a.end - b.end);
    return accepted;
}
