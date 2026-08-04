import * as vscode from 'vscode';
import type { ReferencePrepStrength, ReferenceSourceId } from './schema';
import { getDefaultEnabledSources } from './config';
import {
    clampControls,
    defaultControlsForStrength,
    type ReferencePrepRunControls,
} from './runControls';

const KEY_LAST_RUN = 'ai-proofread.referencePrep.lastRun';

const ALLOWED_SOURCES: ReferenceSourceId[] = ['dict', 'grep_md', 'bm25', 'vector', 'citation', 'web', 'wikipedia'];
const ALLOWED_STRENGTHS: ReferencePrepStrength[] = ['light', 'standard', 'thorough'];

export interface ReferencePrepLastRun {
    enabledSources: ReferenceSourceId[];
    strength: ReferencePrepStrength;
    controls?: Partial<ReferencePrepRunControls>;
}

export function loadReferencePrepLastRun(context: vscode.ExtensionContext): ReferencePrepLastRun & {
    controls: ReferencePrepRunControls;
} {
    const raw = context.workspaceState.get<ReferencePrepLastRun>(KEY_LAST_RUN);
    const configDefaults = getDefaultEnabledSources();
    const sources =
        raw?.enabledSources?.filter((s): s is ReferenceSourceId => ALLOWED_SOURCES.includes(s)) ?? configDefaults;
    const strength =
        raw?.strength && ALLOWED_STRENGTHS.includes(raw.strength) ? raw.strength : ('standard' as const);
    const controls = clampControls(raw?.controls, strength);
    return {
        enabledSources: sources.length > 0 ? sources : configDefaults,
        strength,
        controls,
    };
}

export async function saveReferencePrepLastRun(
    context: vscode.ExtensionContext,
    run: ReferencePrepLastRun
): Promise<void> {
    const strength = ALLOWED_STRENGTHS.includes(run.strength) ? run.strength : 'standard';
    await context.workspaceState.update(KEY_LAST_RUN, {
        enabledSources: run.enabledSources.filter((s) => ALLOWED_SOURCES.includes(s)),
        strength,
        controls: clampControls(run.controls, strength),
    });
}

export { defaultControlsForStrength, clampControls };
export type { ReferencePrepRunControls };
