import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
    asProofreadOutputStrings,
    buildOverlayInput,
    formatConflictMessage,
    getProofreadPanelButtons,
    inspectProofreadRounds,
    parseProofreadRound,
    proofreadItemPathFromOutput,
    proofreadItemPathToSegmentsJsonPath,
    proofreadJsonPath,
    proofreadJsonPathToSegmentsJsonPath,
    resolveSegmentsJsonPath,
    round1OutputJsonPath,
    stripProofreadJsonMarkdownSuffix,
    guardOverlayProofreadCommand,
    guardProofreadFileCommand,
} from './proofreadRoundLayout';

function touchJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('parseProofreadRound', () => {
    it('parses numbered and legacy result json', () => {
        expect(parseProofreadRound(path.join('d', '书.proofread.2.json'))).toEqual({
            round: 2,
            jsonPath: path.join('d', '书.proofread.2.json'),
            isLegacyUnnumbered: false,
        });
        expect(parseProofreadRound(path.join('d', '书.proofread.json'))).toEqual({
            round: 1,
            jsonPath: path.join('d', '书.proofread.json'),
            isLegacyUnnumbered: true,
        });
        expect(parseProofreadRound(path.join('d', '书.proofread.2.json.md'))).toBeUndefined();
        expect(parseProofreadRound(path.join('d', '书.json'))).toBeUndefined();
    });
});

describe('path mapping', () => {
    it('maps result json and item json back to segments json', () => {
        expect(proofreadJsonPathToSegmentsJsonPath(path.join('d', '书.proofread.3.json'))).toBe(
            path.join('d', '书.json')
        );
        expect(proofreadJsonPathToSegmentsJsonPath(path.join('d', '书.proofread.json'))).toBe(
            path.join('d', '书.json')
        );
        expect(proofreadItemPathToSegmentsJsonPath(path.join('d', '书.proofread.2-item.json'))).toBe(
            path.join('d', '书.json')
        );
        expect(proofreadItemPathToSegmentsJsonPath(path.join('d', '书.proofread-item.json'))).toBe(
            path.join('d', '书.json')
        );
    });

    it('derives item path from output json', () => {
        expect(proofreadItemPathFromOutput(path.join('d', '书.proofread.2.json'))).toBe(
            path.join('d', '书.proofread.2-item.json')
        );
        expect(proofreadItemPathFromOutput(path.join('d', '书.proofread.json'))).toBe(
            path.join('d', '书.proofread-item.json')
        );
    });

    it('resolves editor path to segments json', () => {
        expect(resolveSegmentsJsonPath(path.join('d', '书.json'))).toBe(path.join('d', '书.json'));
        expect(resolveSegmentsJsonPath(path.join('d', '书.proofread.1.json'))).toBe(path.join('d', '书.json'));
        expect(resolveSegmentsJsonPath(path.join('d', '书.referenceprep.json'))).toBeUndefined();
    });

    it('strips proofread json.md suffix for pdf lookup', () => {
        expect(stripProofreadJsonMarkdownSuffix(path.join('d', '书.proofread.2.json.md'))).toBe(
            path.join('d', '书')
        );
        expect(stripProofreadJsonMarkdownSuffix(path.join('d', '书.proofread.json.md'))).toBe(
            path.join('d', '书')
        );
    });
});

describe('inspectProofreadRounds', () => {
    it('treats empty dir as no conflicts maxRound 0', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        const inspected = inspectProofreadRounds(dir, '书');
        expect(inspected.maxRound).toBe(0);
        expect(inspected.hasConflicts).toBe(false);
        expect(inspected.files).toEqual([]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('treats legacy unnumbered as round 1 when .1.json is absent', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.json'), ['a']);
        const inspected = inspectProofreadRounds(dir, '书');
        expect(inspected.maxRound).toBe(1);
        expect(inspected.hasConflicts).toBe(false);
        expect(round1OutputJsonPath(dir, '书', inspected)).toBe(path.join(dir, '书.proofread.json'));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does not flag a missing middle round as a conflict', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.1.json'), ['a']);
        touchJson(path.join(dir, '书.proofread.3.json'), ['c']);
        const inspected = inspectProofreadRounds(dir, '书');
        expect(inspected.hasConflicts).toBe(false);
        expect(inspected.maxRound).toBe(3);
        expect(inspected.issues).toEqual([]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('flags legacy and numbered round 1 as a conflict', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.1.json'), ['a']);
        touchJson(path.join(dir, '书.proofread.json'), ['legacy']);
        const inspected = inspectProofreadRounds(dir, '书');
        expect(inspected.hasConflicts).toBe(true);
        expect(inspected.issues.some((i) => i.kind === 'conflict' && i.round === 1)).toBe(true);
        expect(inspected.message).toContain('第 1 轮存在多份');
        expect(formatConflictMessage(inspected.issues)).toContain('书.proofread.json');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('ignores other basenames and companion md/item files', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.1.json'), ['a']);
        touchJson(path.join(dir, '附录.proofread.2.json'), ['x']);
        fs.writeFileSync(path.join(dir, '书.proofread.1.json.md'), 'md', 'utf8');
        touchJson(path.join(dir, '书.proofread.1-item.json'), ['{}']);
        const inspected = inspectProofreadRounds(dir, '书');
        expect(inspected.maxRound).toBe(1);
        expect(inspected.hasConflicts).toBe(false);
        expect(inspected.files).toHaveLength(1);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('buildOverlayInput', () => {
    it('replaces target and keeps other fields', () => {
        const next = buildOverlayInput(
            [
                { target: '旧1', reference: 'r', extra: 1 },
                { target: '旧2', context: 'c' },
            ],
            ['新1', '新2']
        );
        expect(next).toEqual([
            { target: '新1', reference: 'r', extra: 1 },
            { target: '新2', context: 'c' },
        ]);
    });

    it('rejects length mismatch and nulls', () => {
        expect(() => buildOverlayInput([{ target: 'a' }], ['x', 'y'])).toThrow(/切分已变化/);
        expect(() => buildOverlayInput([{ target: 'a' }, { target: 'b' }], ['x', null])).toThrow(
            /未完成/
        );
    });
});

describe('getProofreadPanelButtons', () => {
    it('enables first-round button when no results', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        const buttons = getProofreadPanelButtons(dir, '书');
        expect(buttons.llmEnabled).toBe(true);
        expect(buttons.llmLabel).toBe('LLM 校对 JSON');
        expect(buttons.overlayEnabled).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('uses resume label when round 1 has nulls', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.1.json'), ['a', null]);
        const buttons = getProofreadPanelButtons(dir, '书');
        expect(buttons.llmEnabled).toBe(true);
        expect(buttons.llmLabel).toBe('LLM 校对 JSON - 续跑');
        expect(buttons.overlayEnabled).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('enables overlay after round 1 completes', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.1.json'), ['a']);
        const buttons = getProofreadPanelButtons(dir, '书');
        expect(buttons.llmEnabled).toBe(false);
        expect(buttons.overlayEnabled).toBe(true);
        expect(buttons.overlayLabel).toBe('重叠校对 JSON');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('uses overlay resume when latest higher round has nulls', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.1.json'), ['a']);
        touchJson(path.join(dir, '书.proofread.2.json'), [null]);
        const buttons = getProofreadPanelButtons(dir, '书');
        expect(buttons.llmEnabled).toBe(false);
        expect(buttons.overlayEnabled).toBe(true);
        expect(buttons.overlayLabel).toBe('重叠校对 JSON - 续跑');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('enables overlay next when only a complete higher round exists', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.2.json'), ['a']);
        const buttons = getProofreadPanelButtons(dir, '书');
        expect(buttons.hasConflicts).toBe(false);
        expect(buttons.llmEnabled).toBe(false);
        expect(buttons.overlayEnabled).toBe(true);
        expect(buttons.overlayLabel).toBe('重叠校对 JSON');
        expect(buttons.llmHint).toMatch(/已有重叠校对结果/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('disables both when an incomplete higher round has no previous round', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.2.json'), [null]);
        const buttons = getProofreadPanelButtons(dir, '书');
        expect(buttons.llmEnabled).toBe(false);
        expect(buttons.overlayEnabled).toBe(false);
        expect(buttons.overlayHint).toMatch(/无法续跑第 2 轮/);
        expect(buttons.overlayHint).toMatch(/缺少上一轮/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('disables both on round 1 conflict', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.json'), ['a']);
        touchJson(path.join(dir, '书.proofread.1.json'), ['b']);
        const buttons = getProofreadPanelButtons(dir, '书');
        expect(buttons.hasConflicts).toBe(true);
        expect(buttons.llmEnabled).toBe(false);
        expect(buttons.overlayEnabled).toBe(false);
        expect(buttons.llmHint).toMatch(/第 1 轮存在多份/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('asProofreadOutputStrings', () => {
    it('accepts string or null arrays', () => {
        expect(asProofreadOutputStrings(['a', null])).toEqual(['a', null]);
        expect(asProofreadOutputStrings([{ target: 'a' }])).toBeUndefined();
    });
});

describe('command guards', () => {
    it('refuses proofread file when maxRound >= 2 even without round 1', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.2.json'), ['b']);
        const g = guardProofreadFileCommand(dir, '书');
        expect(g.ok).toBe(false);
        expect(g.message).toMatch(/已有重叠校对结果/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('refuses proofread file when round 1 is complete', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.1.json'), ['a']);
        const g = guardProofreadFileCommand(dir, '书');
        expect(g.ok).toBe(false);
        expect(g.message).toMatch(/第 1 轮已完成/);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('refuses overlay with no results or incomplete round 1', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        expect(guardOverlayProofreadCommand(dir, '书').ok).toBe(false);
        touchJson(path.join(dir, '书.proofread.1.json'), [null]);
        expect(guardOverlayProofreadCommand(dir, '书').ok).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('plans overlay next and resume', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.1.json'), ['a']);
        const next = guardOverlayProofreadCommand(dir, '书');
        expect(next).toMatchObject({ ok: true, mode: 'next', round: 2 });
        touchJson(path.join(dir, '书.proofread.2.json'), [null]);
        const resume = guardOverlayProofreadCommand(dir, '书');
        expect(resume).toMatchObject({ ok: true, mode: 'resume', round: 2 });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('allows overlay next from a complete higher round without earlier rounds', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.2.json'), ['b']);
        const next = guardOverlayProofreadCommand(dir, '书');
        expect(next).toMatchObject({
            ok: true,
            mode: 'next',
            round: 3,
            previousJsonPath: path.join(dir, '书.proofread.2.json'),
        });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('refuses overlay resume when previous round is missing or incomplete', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-round-'));
        touchJson(path.join(dir, '书.proofread.2.json'), [null]);
        const missing = guardOverlayProofreadCommand(dir, '书');
        expect(missing.ok).toBe(false);
        expect(missing.message).toMatch(/缺少上一轮/);
        touchJson(path.join(dir, '书.proofread.1.json'), [null]);
        const incomplete = guardOverlayProofreadCommand(dir, '书');
        expect(incomplete.ok).toBe(false);
        expect(incomplete.message).toMatch(/上一轮（第 1 轮）尚未完成/);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
