import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { CommandBuilder } from './utils';

describe('CommandBuilder.formatExecutable', () => {
    const bundledExe = 'c:\\Users\\DELL\\.vscode\\extensions\\huangfusyong.ai-proofreader-1.11.0\\vendor\\xpdf\\win64\\pdftotext.exe';

    it('adds call operator for quoted paths in PowerShell', () => {
        expect(CommandBuilder.formatExecutable(bundledExe, 'powershell')).toBe(
            `& "${bundledExe}"`
        );
    });

    it('quotes paths without call operator in CMD', () => {
        expect(CommandBuilder.formatExecutable(bundledExe, 'cmd')).toBe(`"${bundledExe}"`);
    });

    it('leaves PATH command names unchanged', () => {
        expect(CommandBuilder.formatExecutable('pdftotext.exe', 'powershell')).toBe('pdftotext.exe');
    });
});
