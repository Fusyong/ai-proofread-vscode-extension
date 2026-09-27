import { describe, expect, it } from 'vitest';
import { cleanTranslateDelivery, normalizeForSourceCompare, parseTranslateProcessOutput } from './bitextCodec';

describe('bitextCodec', () => {
    it('parses s/t and term pairs', () => {
        const raw = `
<bitext>
<s>Hello <term>Alice</term> and Alice again.</s>
<t>你好，<term>爱丽丝</term>，爱丽丝又来了。</t>
</bitext>`;
        const p = parseTranslateProcessOutput(raw, 'Hello Alice and Alice again.');
        expect(p.ok).toBe(true);
        expect(p.terms).toEqual([{ source: 'Alice', target: '爱丽丝' }]);
        expect(p.sourceMatchesInput).toBe(true);
        expect(p.targetPlain).toContain('爱丽丝');
    });

    it('parses key_examples', () => {
        const raw = `<s>a</s><t>甲</t>
<key_examples>
<ex><s>special src</s><t>特殊译</t><note>语气</note></ex>
</key_examples>`;
        const p = parseTranslateProcessOutput(raw, 'a');
        expect(p.keyExamples).toHaveLength(1);
        expect(p.keyExamples[0].note).toBe('语气');
    });

    it('cleanTranslateDelivery strips terms', () => {
        const raw = `<s>x <term>A</term></s><t>译 <term>甲</term></t>`;
        expect(cleanTranslateDelivery(raw)).toBe('译 甲');
    });

    it('normalizeForSourceCompare unifies EOL', () => {
        expect(normalizeForSourceCompare('a\r\nb')).toBe('a\nb');
    });
});
