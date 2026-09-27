import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
    },
}));

import { splitIntoTranslationUnits, splitText } from './splitter';

describe('splitIntoTranslationUnits', () => {
    it('splits by blank lines and headings', () => {
        const text = `# Title\n\nPara one.\n\nPara two.\n`;
        const units = splitIntoTranslationUnits(text);
        expect(units).toEqual(['# Title', 'Para one.', 'Para two.']);
    });

    it('keeps fenced code as one unit', () => {
        const text = `Before\n\n\`\`\`js\nconst a = 1;\nconst b = 2;\n\`\`\`\n\nAfter\n`;
        const units = splitIntoTranslationUnits(text);
        expect(units).toHaveLength(3);
        expect(units[1]).toContain('```js');
        expect(units[1]).toContain('const b');
    });

    it('splitText paragraph mode maps targets', () => {
        const { segments } = splitText('A\n\nB\n', { mode: 'paragraph' });
        expect(segments.map((s) => s.target)).toEqual(['A', 'B']);
    });
});
