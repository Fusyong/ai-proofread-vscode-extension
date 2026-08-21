/** QuickPick 上次选项的说明标记（不依赖 vscode，便于单测）。 */

const LAST_MARK = '上次';

export function markLastChoiceDescription(
    existing: string | undefined,
    isLast: boolean
): string | undefined {
    if (!isLast) {
        return existing;
    }
    if (!existing) {
        return LAST_MARK;
    }
    if (existing.includes(LAST_MARK)) {
        return existing;
    }
    return `${existing} · ${LAST_MARK}`;
}
