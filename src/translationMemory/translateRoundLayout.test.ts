import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    getTranslatePanelButtons,
    guardTranslateFileCommand,
    inspectTranslateRounds,
    parseTranslateRound,
    translateJsonPath,
    translateJsonPathToSegmentsJsonPath,
    translateProcessJsonPath,
} from './translateRoundLayout';

describe('translateRoundLayout', () => {
    it('parseTranslateRound extracts round', () => {
        const p = parseTranslateRound('/tmp/ch1.translate.2.json');
        expect(p?.round).toBe(2);
    });

    it('does not parse process sidecar as numbered round', () => {
        expect(parseTranslateRound('/tmp/ch1.translate.1-process.json')).toBeUndefined();
    });

    it('maps translate output back to segments json', () => {
        expect(translateJsonPathToSegmentsJsonPath(path.join('/w', 'ch1.translate.1.json'))).toBe(
            path.join('/w', 'ch1.json')
        );
        expect(translateJsonPathToSegmentsJsonPath(path.join('/w', 'ch1.translate.1-process.json'))).toBe(
            path.join('/w', 'ch1.json')
        );
    });

    it('guard and panel buttons detect resume', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-round-'));
        const base = 'ch1';
        const out = translateJsonPath(dir, base, 1);
        fs.writeFileSync(out, JSON.stringify(['a', null], null, 2), 'utf8');
        const guard = guardTranslateFileCommand(dir, base);
        expect(guard.resume).toBe(true);
        expect(guard.processJsonPath).toBe(translateProcessJsonPath(dir, base, 1));
        const buttons = getTranslatePanelButtons(dir, base);
        expect(buttons.llmLabel).toContain('续跑');
        const inspected = inspectTranslateRounds(dir, base);
        expect(inspected.maxRound).toBe(1);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
