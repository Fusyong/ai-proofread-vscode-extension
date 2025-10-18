import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { FilePathUtils, ErrorUtils } from './utils';

const execAsync = promisify(exec);

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

        vscode.window.showInformationMessage('转换完成，请查看输出文件！');

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
        let terminal = vscode.window.terminals.find(t => t.name === 'Pandoc');
        if (!terminal) {
            terminal = vscode.window.createTerminal('Pandoc');
        }

        const mdDir = path.dirname(mdPath);
        const command = `cd ${mdDir} & pandoc -f markdown -t docx "${mdPath}" -o "${outputPath}"`;
        terminal.sendText(command);

        vscode.window.showInformationMessage('转换完成，请查看输出文件！');

        return outputPath;
    } catch (error) {
        throw new Error(`转换markdown到docx失败: ${error}`);
    }
}