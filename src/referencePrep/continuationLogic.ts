import type { ReferencePrepProcessFileV020 } from './schema';

export interface ReferencePrepSessionEntry {
    anchorPath: string;
    targetPreview?: string;
    userInput?: string;
    updatedAt: string;
    activeHits: number;
    roundCount: number;
}

function normalizeTarget(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function targetsMatch(stored: string | undefined, current: string): boolean {
    if (!stored?.trim()) return true;
    return normalizeTarget(stored) === normalizeTarget(current);
}

export function summarizeSession(
    anchorPath: string,
    proc: ReferencePrepProcessFileV020
): ReferencePrepSessionEntry {
    const activeHits = proc.corpus.filter((h) => h.status === 'active').length;
    return {
        anchorPath,
        targetPreview: proc.targetPreview ?? proc.userInput?.slice(0, 200),
        userInput: proc.userInput,
        updatedAt:
            proc.rounds.length > 0
                ? proc.rounds[proc.rounds.length - 1].finishedAt ??
                  proc.rounds[proc.rounds.length - 1].startedAt
                : new Date().toISOString(),
        activeHits,
        roundCount: proc.rounds.length,
    };
}
