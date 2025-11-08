import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { FilePathUtils, ErrorUtils } from './utils';

const execAsync = promisify(exec);

/**
 * pdftotext 参数选项接口
 */
export interface PdfToTextOptions {
    // 布局模式（必选）
    layoutMode: 'layout' | 'simple' | 'simple2' | 'table' | 'lineprinter' | 'raw';

    // 页码范围（可选）
    pageRange?: {
        firstPage?: number;
        lastPage?: number;
    };

    // 边距（可选，单位：点）
    margins?: {
        left?: number;
        right?: number;
        top?: number;
        bottom?: number;
    };

    // 布局参数（可选）
    fixed?: number;  // 字符间距（点），用于 layout/table/lineprinter 模式
    linespacing?: number;  // 行间距（点），用于 lineprinter 模式

    // 其他选项
    nodiag?: boolean;  // 丢弃对角线文本
}

/**
 * 预设模式定义
 */
const PRESET_MODES = {
    default: {
        name: '默认模式（保持布局）',
        description: '适合大多数文档，保持原始物理布局',
        options: {
            layoutMode: 'layout' as const
        }
    },
    simple: {
        name: '简单文档模式',
        description: '适合简单单列页面',
        options: {
            layoutMode: 'simple' as const
        }
    },
    table: {
        name: '表格模式',
        description: '优化表格数据，保持行列对齐',
        options: {
            layoutMode: 'table' as const
        }
    },
    ocr: {
        name: 'OCR文档模式',
        description: '适合OCR输出的轻微旋转文本',
        options: {
            layoutMode: 'simple2' as const
        }
    }
};

/**
 * 将docx文件转换为markdown
 * @param docxPath docx文件路径
 * @param mode 转换模式：'default' 或 'strict'
 * @returns 转换后的markdown文件路径
 */
export async function convertDocxToMarkdown(docxPath: string, mode: 'default' | 'markdown_strict' = 'default', outputPath?: string | undefined  ): Promise<string> {
    if (!outputPath) {
        outputPath = FilePathUtils.getFilePath(docxPath, '', '.md');
    }

    const attachmentsDir = path.join(path.dirname(docxPath), 'attachments', path.basename(docxPath, '.docx'));

    try {
        // 检查pandoc是否可用
        try {
            if (process.platform === 'win32') {
                await execAsync('where pandoc');
            } else {
                await execAsync('which pandoc');
            }
        } catch (error) {
            throw new Error('pandoc未安装或不在PATH中，请先安装Pandoc工具包');
        }

        // 确保附件目录存在
        if (!fs.existsSync(attachmentsDir)) {
            fs.mkdirSync(attachmentsDir, { recursive: true });
        }

        let terminal = vscode.window.terminals.find(t => t.name === 'Pandoc');
        if (!terminal) {
            terminal = vscode.window.createTerminal('Pandoc');
        }

        const docxDir = path.dirname(docxPath);
        const docxFileName = path.basename(docxPath);
        const outputFileName = path.basename(outputPath);

        let command: string;
        if (mode === 'default') {
            command = `cd "${docxDir}" & pandoc -f docx -t markdown-smart+pipe_tables+footnotes --wrap=none --toc --extract-media="./attachments/${path.basename(docxPath, '.docx')}" "${docxFileName}" -o "${outputFileName}"`;
        } else {
            command = `cd "${docxDir}" & pandoc -t markdown_strict --extract-media="./attachments/${path.basename(docxPath, '.docx')}" "${docxFileName}" -o "${outputFileName}"`;
        }

        terminal.sendText(command);

        return outputPath;
    } catch (error) {
        throw new Error(`转换docx到markdown失败: ${error}`);
    }
}

/**
 * 将markdown文件转换为docx
 * @param mdPath markdown文件路径
 * @param outputPath 输出文件路径
 * @returns 转换后的docx文件路径
 */
export async function convertMarkdownToDocx(mdPath: string, outputPath?: string | undefined): Promise<string> {
    if (!outputPath) {
        outputPath = FilePathUtils.getFilePath(mdPath, '', '.docx');
    }

    try {
        // 检查pandoc是否可用
        try {
            if (process.platform === 'win32') {
                await execAsync('where pandoc');
            } else {
                await execAsync('which pandoc');
            }
        } catch (error) {
            throw new Error('pandoc未安装或不在PATH中，请先安装Pandoc工具包');
        }

        let terminal = vscode.window.terminals.find(t => t.name === 'Pandoc');
        if (!terminal) {
            terminal = vscode.window.createTerminal('Pandoc');
        }

        const mdDir = path.dirname(mdPath);
        const command = `cd ${mdDir} & pandoc -f markdown -t docx "${mdPath}" -o "${outputPath}"`;
        terminal.sendText(command);

        return outputPath;
    } catch (error) {
        throw new Error(`转换markdown到docx失败: ${error}`);
    }
}

/**
 * 构建 pdftotext 命令
 * @param pdfPath PDF文件路径
 * @param outputPath 输出文件路径
 * @param options 参数选项
 * @returns 完整的命令字符串
 */
function buildPdfToTextCommand(
    pdfPath: string,
    outputPath: string,
    options: PdfToTextOptions
): string {
    const args: string[] = [];

    // 布局模式（必选）
    args.push(`-${options.layoutMode}`);

    // 编码（固定为 UTF-8）
    args.push('-enc UTF-8');

    // 页码范围
    if (options.pageRange?.firstPage) {
        args.push(`-f ${options.pageRange.firstPage}`);
    }
    if (options.pageRange?.lastPage) {
        args.push(`-l ${options.pageRange.lastPage}`);
    }

    // 边距
    if (options.margins?.left !== undefined) {
        args.push(`-marginl ${options.margins.left}`);
    }
    if (options.margins?.right !== undefined) {
        args.push(`-marginr ${options.margins.right}`);
    }
    if (options.margins?.top !== undefined) {
        args.push(`-margint ${options.margins.top}`);
    }
    if (options.margins?.bottom !== undefined) {
        args.push(`-marginb ${options.margins.bottom}`);
    }

    // 布局参数
    if (options.fixed !== undefined) {
        args.push(`-fixed ${options.fixed}`);
    }
    if (options.linespacing !== undefined) {
        args.push(`-linespacing ${options.linespacing}`);
    }

    // 其他选项
    if (options.nodiag) {
        args.push('-nodiag');
    }

    // 构建完整命令
    const pdfDir = path.dirname(pdfPath);
    const pdfFileName = path.basename(pdfPath);
    const outputFileName = path.basename(outputPath);

    return `cd "${pdfDir}" & pdftotext ${args.join(' ')} "${pdfFileName}" "${outputFileName}"`;
}

/**
 * 收集用户选择的 pdftotext 参数
 * @returns 参数选项，如果用户取消则返回 undefined
 */
export async function collectPdfToTextOptions(): Promise<PdfToTextOptions | undefined> {
    // 步骤1：选择预设模式或自定义
    const presetItems = [
        { label: PRESET_MODES.default.name, description: PRESET_MODES.default.description, value: 'default' },
        { label: PRESET_MODES.simple.name, description: PRESET_MODES.simple.description, value: 'simple' },
        { label: PRESET_MODES.table.name, description: PRESET_MODES.table.description, value: 'table' },
        { label: PRESET_MODES.ocr.name, description: PRESET_MODES.ocr.description, value: 'ocr' },
        { label: '自定义模式', description: '手动配置所有参数', value: 'custom' }
    ];

    const presetChoice = await vscode.window.showQuickPick(presetItems, {
        placeHolder: '请选择转换模式',
        ignoreFocusOut: true
    });

    if (!presetChoice) {
        return undefined;
    }

    let options: PdfToTextOptions;

    // 如果选择预设模式
    if (presetChoice.value !== 'custom') {
        const preset = PRESET_MODES[presetChoice.value as keyof typeof PRESET_MODES];
        options = { ...preset.options };

        // 询问是否设置页码范围
        const setPageRange = await vscode.window.showQuickPick(
            ['否', '是'],
            { placeHolder: '是否设置页码范围？', ignoreFocusOut: true }
        );

        if (setPageRange === '是') {
            const firstPage = await vscode.window.showInputBox({
                prompt: '请输入起始页码（留空跳过）',
                placeHolder: '例如：1',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value && (isNaN(Number(value)) || Number(value) < 1)) {
                        return '请输入有效的页码（大于0的整数）';
                    }
                    return null;
                }
            });

            if (firstPage === undefined) {
                return undefined; // 用户取消
            }

            const lastPage = await vscode.window.showInputBox({
                prompt: '请输入结束页码（留空跳过）',
                placeHolder: '例如：10',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value && (isNaN(Number(value)) || Number(value) < 1)) {
                        return '请输入有效的页码（大于0的整数）';
                    }
                    if (value && firstPage && Number(value) < Number(firstPage)) {
                        return '结束页码不能小于起始页码';
                    }
                    return null;
                }
            });

            if (lastPage === undefined) {
                return undefined; // 用户取消
            }

            if (firstPage || lastPage) {
                options.pageRange = {};
                if (firstPage) options.pageRange.firstPage = Number(firstPage);
                if (lastPage) options.pageRange.lastPage = Number(lastPage);
            }
        }
    } else {
        // 自定义模式：分步收集参数

        // 2.1 选择布局模式
        const layoutItems = [
            { label: 'layout', description: '保持原始物理布局（默认推荐，适合大多数文档）', value: 'layout' as const },
            { label: 'simple', description: '简单单列模式（适合简单单列页面）', value: 'simple' as const },
            { label: 'simple2', description: '简单单列模式（处理轻微旋转文本，如OCR输出）', value: 'simple2' as const },
            { label: 'table', description: '表格模式（优化表格数据，保持行列对齐）', value: 'table' as const },
            { label: 'lineprinter', description: '行打印机模式（固定字符间距和行高）', value: 'lineprinter' as const },
            { label: 'raw', description: '保持内容流顺序（取决于PDF生成方式）', value: 'raw' as const }
        ];

        const layoutChoice = await vscode.window.showQuickPick(layoutItems, {
            placeHolder: '请选择布局模式',
            ignoreFocusOut: true
        });

        if (!layoutChoice) {
            return undefined;
        }

        options = { layoutMode: layoutChoice.value };

        // 2.2 设置页码范围（可选）
        const setPageRange = await vscode.window.showQuickPick(
            ['否', '是'],
            { placeHolder: '是否设置页码范围？', ignoreFocusOut: true }
        );

        if (setPageRange === '是') {
            const firstPage = await vscode.window.showInputBox({
                prompt: '请输入起始页码（留空跳过）',
                placeHolder: '例如：1',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value && (isNaN(Number(value)) || Number(value) < 1)) {
                        return '请输入有效的页码（大于0的整数）';
                    }
                    return null;
                }
            });

            if (firstPage === undefined) {
                return undefined;
            }

            const lastPage = await vscode.window.showInputBox({
                prompt: '请输入结束页码（留空跳过）',
                placeHolder: '例如：10',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value && (isNaN(Number(value)) || Number(value) < 1)) {
                        return '请输入有效的页码（大于0的整数）';
                    }
                    if (value && firstPage && Number(value) < Number(firstPage)) {
                        return '结束页码不能小于起始页码';
                    }
                    return null;
                }
            });

            if (lastPage === undefined) {
                return undefined;
            }

            if (firstPage || lastPage) {
                options.pageRange = {};
                if (firstPage) options.pageRange.firstPage = Number(firstPage);
                if (lastPage) options.pageRange.lastPage = Number(lastPage);
            }
        }

        // 2.3 设置边距（可选）
        const setMargins = await vscode.window.showQuickPick(
            ['否', '是'],
            { placeHolder: '是否设置边距？', ignoreFocusOut: true }
        );

        if (setMargins === '是') {
            const left = await vscode.window.showInputBox({
                prompt: '左边距（点，留空跳过）',
                placeHolder: '例如：10',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value && (isNaN(Number(value)) || Number(value) < 0)) {
                        return '请输入非负数';
                    }
                    return null;
                }
            });

            if (left === undefined) return undefined;

            const right = await vscode.window.showInputBox({
                prompt: '右边距（点，留空跳过）',
                placeHolder: '例如：10',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value && (isNaN(Number(value)) || Number(value) < 0)) {
                        return '请输入非负数';
                    }
                    return null;
                }
            });

            if (right === undefined) return undefined;

            const top = await vscode.window.showInputBox({
                prompt: '上边距（点，留空跳过）',
                placeHolder: '例如：10',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value && (isNaN(Number(value)) || Number(value) < 0)) {
                        return '请输入非负数';
                    }
                    return null;
                }
            });

            if (top === undefined) return undefined;

            const bottom = await vscode.window.showInputBox({
                prompt: '下边距（点，留空跳过）',
                placeHolder: '例如：10',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (value && (isNaN(Number(value)) || Number(value) < 0)) {
                        return '请输入非负数';
                    }
                    return null;
                }
            });

            if (bottom === undefined) return undefined;

            if (left || right || top || bottom) {
                options.margins = {};
                if (left) options.margins.left = Number(left);
                if (right) options.margins.right = Number(right);
                if (top) options.margins.top = Number(top);
                if (bottom) options.margins.bottom = Number(bottom);
            }
        }

        // 2.4 选择其他选项（多选）
        const otherOptions = await vscode.window.showQuickPick(
            [
                { label: '丢弃对角线文本（跳过水印等）', value: 'nodiag' },
                { label: '跳过（不设置其他选项）', value: 'skip' }
            ],
            {
                placeHolder: '选择其他选项（可多选，或选择"跳过"）',
                canPickMany: true,
                ignoreFocusOut: true
            }
        );

        if (otherOptions === undefined) {
            return undefined;
        }

        if (otherOptions.some(opt => opt.value === 'nodiag')) {
            options.nodiag = true;
        }

        // 2.5 高级参数（根据布局模式显示）
        if (options.layoutMode === 'layout' || options.layoutMode === 'table' || options.layoutMode === 'lineprinter') {
            const setFixed = await vscode.window.showQuickPick(
                ['否', '是'],
                { placeHolder: '是否设置字符间距（fixed）？', ignoreFocusOut: true }
            );

            if (setFixed === '是') {
                const fixed = await vscode.window.showInputBox({
                    prompt: '字符间距（点）',
                    placeHolder: '例如：10',
                    ignoreFocusOut: true,
                    validateInput: (value) => {
                        if (!value || isNaN(Number(value)) || Number(value) <= 0) {
                            return '请输入正数';
                        }
                        return null;
                    }
                });

                if (fixed === undefined) return undefined;
                if (fixed) options.fixed = Number(fixed);
            }
        }

        if (options.layoutMode === 'lineprinter') {
            const setLinespacing = await vscode.window.showQuickPick(
                ['否', '是'],
                { placeHolder: '是否设置行间距（linespacing）？', ignoreFocusOut: true }
            );

            if (setLinespacing === '是') {
                const linespacing = await vscode.window.showInputBox({
                    prompt: '行间距（点）',
                    placeHolder: '例如：12',
                    ignoreFocusOut: true,
                    validateInput: (value) => {
                        if (!value || isNaN(Number(value)) || Number(value) <= 0) {
                            return '请输入正数';
                        }
                        return null;
                    }
                });

                if (linespacing === undefined) return undefined;
                if (linespacing) options.linespacing = Number(linespacing);
            }
        }
    }

    return options;
}

/**
 * 将PDF文件转换为markdown
 * @param pdfPath PDF文件路径
 * @param outputPath 输出文件路径
 * @param options 参数选项（如果未提供，将使用默认选项）
 * @returns 转换后的markdown文件路径
 */
export async function convertPdfToMarkdown(
    pdfPath: string,
    outputPath?: string | undefined,
    options?: PdfToTextOptions
): Promise<string> {
    if (!outputPath) {
        outputPath = FilePathUtils.getFilePath(pdfPath, '', '.md');
    }

    // 如果没有提供选项，使用默认选项
    if (!options) {
        options = { layoutMode: 'layout' };
    }

    try {
        // 检查pdftotext是否可用 - 使用 where 命令检查命令是否存在
        try {
            if (process.platform === 'win32') {
                await execAsync('where pdftotext');
            } else {
                await execAsync('which pdftotext');
            }
        } catch (error) {
            throw new Error('pdftotext未安装或不在PATH中，请正确安装');
        }

        let terminal = vscode.window.terminals.find(t => t.name === 'PDF转换');
        if (!terminal) {
            terminal = vscode.window.createTerminal('PDF转换');
        }

        const command = buildPdfToTextCommand(pdfPath, outputPath, options);
        terminal.sendText(command);

        return outputPath;
    } catch (error) {
        throw new Error(`转换PDF到markdown失败: ${error}`);
    }
}