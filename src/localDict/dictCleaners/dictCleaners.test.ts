import { describe, expect, it } from 'vitest';
import { cleanCihaiStyle, cleanDictDefinition, cleanGenericMdxNoise } from './index';

describe('dictCleaners', () => {
    it('strips copyright and nav lines', () => {
        const raw = '正文一行\n版权所有：某某出版社\n下一页\n\n\n第二段';
        expect(cleanGenericMdxNoise(raw)).toBe('正文一行\n\n第二段');
    });

    it('cihai cleaner removes 参见 header lines', () => {
        const raw = '【参见】某某条\n李白（701—762），唐代诗人。';
        expect(cleanCihaiStyle(raw)).toContain('李白');
        expect(cleanCihaiStyle(raw)).not.toMatch(/参见/);
    });

    it('resolves by dictId or tag', () => {
        const t = cleanDictDefinition({
            text: '版权所有\n词条正文',
            dictId: 'cihai',
        });
        expect(t).toBe('词条正文');
        const t2 = cleanDictDefinition({
            text: '版权所有\n词条正文',
            tags: ['辞海'],
        });
        expect(t2).toBe('词条正文');
    });

    it('strips audio unsupported message for cihai7', () => {
        const raw = '李白 您的浏览器不支持 audio 标签\n李　白（701—762）\n唐诗人。';
        const t = cleanDictDefinition({ text: raw, dictId: 'cihai7' });
        expect(t).not.toMatch(/audio/i);
        expect(t).toContain('唐诗人');
    });
});
