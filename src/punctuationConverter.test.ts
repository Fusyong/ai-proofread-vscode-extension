import { describe, expect, it } from 'vitest';

import { fullToHalfPunctuation, halfToFullPunctuation } from './punctuationConverter';

describe('halfToFullPunctuation', () => {
    it('converts common half-width punctuation to full-width', () => {
        expect(halfToFullPunctuation('你好,世界;注意:危险!真的?(示例)')).toBe(
            '你好，世界；注意：危险！真的？（示例）'
        );
    });

    it('leaves other characters unchanged', () => {
        expect(halfToFullPunctuation('a.b"c\'d-e_f')).toBe('a.b"c\'d-e_f');
    });

    it('is a no-op when there is nothing to convert', () => {
        expect(halfToFullPunctuation('你好，世界')).toBe('你好，世界');
    });
});

describe('fullToHalfPunctuation', () => {
    it('converts common full-width punctuation to half-width', () => {
        expect(fullToHalfPunctuation('你好，世界；注意：危险！真的？（示例）')).toBe(
            '你好,世界;注意:危险!真的?(示例)'
        );
    });

    it('leaves other characters unchanged', () => {
        expect(fullToHalfPunctuation('“引号”。省略号…')).toBe('“引号”。省略号…');
    });

    it('is a no-op when there is nothing to convert', () => {
        expect(fullToHalfPunctuation('hello, world!')).toBe('hello, world!');
    });
});
