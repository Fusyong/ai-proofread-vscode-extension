import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { buildPdfToTextArgs, type PdfToTextOptions } from './docConverter';

describe('buildPdfToTextArgs', () => {
    it('puts layout mode, encoding, and paths into separate arguments', () => {
        const args = buildPdfToTextArgs('D:\\books\\a.pdf', 'D:\\books\\a.md', {
            layoutMode: 'layout'
        });

        expect(args).toEqual([
            '-layout',
            '-enc',
            'UTF-8',
            'D:\\books\\a.pdf',
            'D:\\books\\a.md'
        ]);
    });

    it('appends optional flags without gluing values to the flag name', () => {
        const options: PdfToTextOptions = {
            layoutMode: 'lineprinter',
            pageRange: { firstPage: 2, lastPage: 8 },
            margins: { left: 10, right: 12, top: 20, bottom: 24 },
            fixed: 10,
            linespacing: 12,
            nodiag: true
        };

        expect(buildPdfToTextArgs('in.pdf', 'out.md', options)).toEqual([
            '-lineprinter',
            '-enc',
            'UTF-8',
            '-f',
            '2',
            '-l',
            '8',
            '-marginl',
            '10',
            '-marginr',
            '12',
            '-margint',
            '20',
            '-marginb',
            '24',
            '-fixed',
            '10',
            '-linespacing',
            '12',
            '-nodiag',
            'in.pdf',
            'out.md'
        ]);
    });
});
