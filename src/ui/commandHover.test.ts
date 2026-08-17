import { describe, expect, it } from 'vitest';
import { commandHoverTitle, shortCommandId } from './commandHover';

describe('shortCommandId', () => {
    it('strips the unified ai-proofread. prefix', () => {
        expect(shortCommandId('ai-proofread.checkWords')).toBe('checkWords');
        expect(shortCommandId('ai-proofread.wordCheck.sortAndFilter')).toBe('wordCheck.sortAndFilter');
    });

    it('leaves other command ids unchanged', () => {
        expect(shortCommandId('workbench.action.openSettings')).toBe('workbench.action.openSettings');
    });
});

describe('commandHoverTitle', () => {
    it('appends the short command after the description', () => {
        expect(commandHoverTitle('字词检查', 'ai-proofread.checkWords')).toBe('字词检查 (checkWords)');
    });

    it('does not duplicate an already-appended command', () => {
        expect(commandHoverTitle('字词检查 (checkWords)', 'ai-proofread.checkWords')).toBe(
            '字词检查 (checkWords)'
        );
    });

    it('falls back to the short command when description is empty', () => {
        expect(commandHoverTitle('  ', 'ai-proofread.splitFile')).toBe('splitFile');
    });
});
