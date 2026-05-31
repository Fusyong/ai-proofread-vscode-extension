import * as vscode from 'vscode';
import type { ReferencePrepStrength, ReferenceSourceId } from './schema';
import { getDefaultEnabledSources } from './config';

const KEY_LAST_RUN = 'ai-proofread.referencePrep.lastRun';

const ALLOWED_SOURCES: ReferenceSourceId[] = ['dict', 'grep_md', 'citation', 'web'];
const ALLOWED_STRENGTHS: ReferencePrepStrength[] = ['light', 'standard', 'thorough'];

export interface ReferencePrepLastRun {
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
}

export function loadReferencePrepLastRun(context: vscode.ExtensionContext): ReferencePrepLastRun {
    const raw = context.workspaceState.get<ReferencePrepLastRun>(KEY_LAST_RUN);
    const configDefaults = getDefaultEnabledSources();
    const sources =
        raw?.enabledSources?.filter((s): s is ReferenceSourceId => ALLOWED_SOURCES.includes(s)) ?? configDefaults;
    const strength =
        raw?.strength && ALLOWED_STRENGTHS.includes(raw.strength) ? raw.strength : ('standard' as const);
    return {
        enabledSources: sources.length > 0 ? sources : configDefaults,
        strength,
    };
}

export async function saveReferencePrepLastRun(
    context: vscode.ExtensionContext,
    run: ReferencePrepLastRun
): Promise<void> {
    await context.workspaceState.update(KEY_LAST_RUN, {
        enabledSources: run.enabledSources.filter((s) => ALLOWED_SOURCES.includes(s)),
        strength: ALLOWED_STRENGTHS.includes(run.strength) ? run.strength : 'standard',
    });
}
