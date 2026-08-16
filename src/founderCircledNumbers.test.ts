import { describe, expect, it } from 'vitest';

import {
    decodeFounderDigitOffsets,
    encodeFounderCircledOffsets,
    encodeFounderCircledString,
    numberToUnicodeCircled,
    replaceFounderCircledNumbers,
} from './founderCircledNumbers';

describe('encode/decode Founder circled offsets', () => {
    it('round-trips 11–126 and selected larger numbers', () => {
        const samples = [...Array.from({ length: 116 }, (_, i) => i + 11), 200, 999, 1000, 1234];
        for (const n of samples) {
            const enc = encodeFounderCircledOffsets(n);
            expect(enc).not.toBeNull();
            const [prefix, ...digits] = enc!;
            expect(prefix).toBe(0x0ca);
            expect(decodeFounderDigitOffsets(digits)).toBe(n);
        }
    });

    it('matches known sample encodings', () => {
        expect(encodeFounderCircledOffsets(11)).toEqual([0x0ca, 0x049, 0x053]);
        expect(encodeFounderCircledOffsets(20)).toEqual([0x0ca, 0x04a, 0x052]);
        expect(encodeFounderCircledOffsets(99)).toEqual([0x0ca, 0x051, 0x05b]);
        expect(encodeFounderCircledOffsets(100)).toEqual([0x0ca, 0x08f, 0x098, 0x0a2]);
        expect(encodeFounderCircledOffsets(126)).toEqual([0x0ca, 0x08f, 0x09a, 0x0a8]);
    });
});

describe('numberToUnicodeCircled', () => {
    it('maps 1–50 to circled forms and larger to brackets', () => {
        expect(numberToUnicodeCircled(1)).toBe('①');
        expect(numberToUnicodeCircled(10)).toBe('⑩');
        expect(numberToUnicodeCircled(11)).toBe('⑪');
        expect(numberToUnicodeCircled(20)).toBe('⑳');
        expect(numberToUnicodeCircled(21)).toBe('㉑');
        expect(numberToUnicodeCircled(50)).toBe('㊿');
        expect(numberToUnicodeCircled(51)).toBe('[51]');
    });
});

describe('replaceFounderCircledNumbers', () => {
    it('replaces PUA markers with unicode circled numbers', () => {
        const marker11 = encodeFounderCircledString(11)!;
        const marker100 = encodeFounderCircledString(100)!;
        const input = `肇${marker11}锡${marker100}余`;
        const { text, replacedCount } = replaceFounderCircledNumbers(input, { format: 'unicode' });
        expect(text).toBe('肇⑪锡[100]余');
        expect(replacedCount).toBe(2);
    });

    it('replaces PUA and unicode circled with bracket notes', () => {
        const marker11 = encodeFounderCircledString(11)!;
        const input = `帝①高阳${marker11}兮`;
        const { text, replacedCount } = replaceFounderCircledNumbers(input, { format: 'bracket' });
        expect(text).toBe('帝[1]高阳[11]兮');
        expect(replacedCount).toBe(2);
    });

    it('supports Plane 15 offsets as well as Plane 16', () => {
        const plane15 = encodeFounderCircledString(12, 0xf0000)!;
        const { text } = replaceFounderCircledNumbers(`锡${plane15}`, { format: 'unicode' });
        expect(text).toBe('锡⑫');
    });

    it('strips known layout artifacts by default', () => {
        const junk = String.fromCodePoint(
            0x100b64,
            0x100b65,
            0x100a81,
            0x100a81,
            0x100a81
        );
        const soft = String.fromCodePoint(
            0x100b60,
            0x100b61,
            0x100a81,
            0x100a81,
            0x100a81
        );
        const input = `时序更${soft}替。${junk}不抚壮`;
        const { text, strippedArtifactCount } = replaceFounderCircledNumbers(input, {
            format: 'unicode',
        });
        expect(text).toBe('时序更替。不抚壮');
        expect(strippedArtifactCount).toBe(2);
    });

    it('can keep layout artifacts when disabled', () => {
        const junk = String.fromCodePoint(0x100b64, 0x100b65, 0x100a81);
        const { text, strippedArtifactCount } = replaceFounderCircledNumbers(`甲${junk}乙`, {
            format: 'unicode',
            stripLayoutArtifacts: false,
        });
        expect(text).toBe(`甲${junk}乙`);
        expect(strippedArtifactCount).toBe(0);
    });
});
