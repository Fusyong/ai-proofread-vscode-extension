/**
 * JSON 顺序翻译：逐项处理 → 更新翻译记忆 → 下一项（禁止并行写记忆）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { RateLimiter } from '../rateLimiter';
import { ProgressTracker } from '../progressTracker';
import { Logger } from '../utils';
import {
    AliyunApiClient,
    DeepseekApiClient,
    GoogleApiClient,
    OllamaApiClient,
    type ApiClient,
    type ProcessStats,
} from '../proofreader';
import { cleanTranslateDelivery, parseTranslateProcessOutput } from './bitextCodec';
import { buildTranslationMemoryXml, mergeTranslationMemoryFromParsed } from './service';
import { readJsonStringArray } from './translateRoundLayout';

export type TranslateSourceItem = {
    target: string;
    reference?: string;
    context?: string;
    [key: string]: unknown;
};

function createClient(platform: string, model: string): ApiClient {
    switch (platform) {
        case 'google':
            return new GoogleApiClient(model);
        case 'aliyun':
            return new AliyunApiClient(model);
        case 'ollama':
            return new OllamaApiClient(model);
        case 'deepseek':
        default:
            return new DeepseekApiClient(model);
    }
}

function buildPrevTranslatedContext(
    sources: TranslateSourceItem[],
    deliveries: (string | null)[],
    index: number
): string {
    if (index <= 0) {
        return '';
    }
    const prevSrc = String(sources[index - 1]?.target ?? '');
    const prevTgt = deliveries[index - 1];
    if (!prevTgt || typeof prevTgt !== 'string' || !prevSrc.trim()) {
        return '';
    }
    return `<prev_unit>\n<s>\n${prevSrc}\n</s>\n<t>\n${prevTgt}\n</t>\n</prev_unit>`;
}

function writeMarkdownFromDeliveries(mdPath: string, deliveries: (string | null)[]): void {
    const parts = deliveries.map((d) => (d == null ? '' : d));
    fs.writeFileSync(mdPath, parts.join('\n\n') + '\n', 'utf8');
}

/**
 * 顺序翻译切分 JSON。
 * - 输出 `{base}.translate.N.json`：交付译文数组（string|null）
 * - 旁路 `{base}.translate.N-process.json`：过程原文数组
 * - 每完成一项：candidate 写入翻译记忆；可选注入上一单元已译邻段
 */
export async function processTranslateJsonSequential(
    jsonInPath: string,
    jsonOutPath: string,
    processOutPath: string,
    options: {
        platform?: string;
        model?: string;
        rpm?: number;
        temperature?: number;
        onProgress?: (info: string) => void;
        onProgressUpdate?: (progressTracker: ProgressTracker) => void;
        token?: vscode.CancellationToken;
        context?: vscode.ExtensionContext;
        sourceTextCharacteristics?: string;
        /** 工作区锚点（写翻译记忆）；默认用 jsonInPath 所在目录的伪 Uri */
        memoryAnchorUri?: vscode.Uri;
        includePrevTranslatedUnit?: boolean;
        styleSampleText?: string;
    } = {}
): Promise<ProcessStats> {
    const logger = Logger.getInstance();
    const {
        platform = 'deepseek',
        model = 'deepseek-v4-pro',
        rpm = 15,
        temperature = 1,
        onProgress,
        onProgressUpdate,
        token,
        context,
        sourceTextCharacteristics = '',
        includePrevTranslatedUnit = true,
        styleSampleText = '',
    } = options;

    const anchor =
        options.memoryAnchorUri ??
        vscode.Uri.file(path.dirname(jsonInPath));

    const inputParagraphs = JSON.parse(fs.readFileSync(jsonInPath, 'utf8')) as TranslateSourceItem[];
    if (!Array.isArray(inputParagraphs)) {
        throw new Error('输入 JSON 须为数组');
    }
    const totalCount = inputParagraphs.length;

    let outputParagraphs = readJsonStringArray(jsonOutPath, totalCount);
    if (!outputParagraphs) {
        if (fs.existsSync(jsonOutPath)) {
            throw new Error(
                `输出 JSON 长度与输入不一致，或格式无效：${jsonOutPath}。请删除或修正后重试。`
            );
        }
        outputParagraphs = new Array(totalCount).fill(null);
        fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
    }

    let processParagraphs = readJsonStringArray(processOutPath, totalCount);
    if (!processParagraphs) {
        processParagraphs = new Array(totalCount).fill(null);
        fs.writeFileSync(processOutPath, JSON.stringify(processParagraphs, null, 2), 'utf8');
    }

    const progressTracker = new ProgressTracker(inputParagraphs, onProgressUpdate);
    for (let i = 0; i < outputParagraphs.length; i++) {
        if (outputParagraphs[i] !== null) {
            progressTracker.updateProgress(i, 'completed');
        }
    }
    if (onProgressUpdate) {
        onProgressUpdate(progressTracker);
    }

    const indicesToProcess: number[] = [];
    for (let i = 0; i < totalCount; i++) {
        if (outputParagraphs[i] === null) {
            indicesToProcess.push(i);
        }
    }

    const client = createClient(platform, model);
    const rateLimiter = new RateLimiter(rpm);
    const mdOutPath = `${jsonOutPath}.md`;

    for (const index of indicesToProcess) {
        if (token?.isCancellationRequested || progressTracker.isCancellationRequested()) {
            progressTracker.setCancelled(true);
            break;
        }

        const paragraph = inputParagraphs[index] ?? { target: '' };
        const targetText = String(paragraph.target ?? '');
        let referenceText = String(paragraph.reference ?? '');
        if (styleSampleText.trim()) {
            referenceText = referenceText
                ? `${styleSampleText.trim()}\n\n${referenceText}`
                : styleSampleText.trim();
        }
        let contextText = String(paragraph.context ?? '');

        if (!targetText || targetText.trim() === '') {
            outputParagraphs[index] = targetText;
            processParagraphs[index] = targetText;
            fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
            fs.writeFileSync(processOutPath, JSON.stringify(processParagraphs, null, 2), 'utf8');
            progressTracker.updateProgress(index, 'completed');
            const skipInfo = `跳过 No. ${index + 1}/${totalCount} (target 为空)\n${'-'.repeat(40)}\n`;
            logger.info(skipInfo);
            onProgress?.(skipInfo);
            continue;
        }

        progressTracker.updateProgress(index, 'submitted');

        const prevUnit = includePrevTranslatedUnit
            ? buildPrevTranslatedContext(inputParagraphs, outputParagraphs, index)
            : '';
        if (prevUnit) {
            contextText = contextText ? `${contextText}\n\n${prevUnit}` : prevUnit;
        }

        const tmXml = buildTranslationMemoryXml(anchor, targetText);
        let preText = referenceText ? `<reference>\n${referenceText}\n</reference>` : '';
        if (contextText.trim() && contextText.trim() !== targetText.trim()) {
            preText += `\n<context>\n${contextText}\n</context>`;
        }
        if (tmXml) {
            preText += tmXml;
        }
        const labeledTarget = `<target>\n${targetText}\n</target>`;

        const progressInfo =
            `顺序翻译 No. ${index + 1}/${totalCount}, Len ${targetText.length}` +
            `${prevUnit ? ' +prev_unit' : ''}` +
            `${tmXml.includes('translation_memory') ? ' +tm' : ''}` +
            `${tmXml.includes('<similar_bitext>') ? ' +similar' : ''}` +
            `\n${targetText.slice(0, 30)} ...\n${'-'.repeat(40)}\n`;
        logger.info(progressInfo);
        onProgress?.(progressInfo);

        await rateLimiter.wait();
        const startTime = Date.now();
        try {
            const raw = await client.proofread(
                labeledTarget,
                preText,
                temperature,
                context,
                undefined,
                sourceTextCharacteristics
            );
            const elapsed = (Date.now() - startTime) / 1000;
            if (!raw) {
                progressTracker.updateProgress(index, 'failed', '空响应');
                const err = `段落 ${index + 1}: 空响应\n${'-'.repeat(40)}\n`;
                logger.error(err);
                onProgress?.(err);
                continue;
            }

            const parsed = parseTranslateProcessOutput(raw, targetText);
            const delivery = cleanTranslateDelivery(parsed);
            outputParagraphs[index] = delivery;
            processParagraphs[index] = raw;
            fs.writeFileSync(jsonOutPath, JSON.stringify(outputParagraphs, null, 2), 'utf8');
            fs.writeFileSync(processOutPath, JSON.stringify(processParagraphs, null, 2), 'utf8');
            writeMarkdownFromDeliveries(mdOutPath, outputParagraphs);

            try {
                mergeTranslationMemoryFromParsed({
                    documentUri: anchor,
                    finalTranslation: delivery,
                    parsed,
                    approve: false,
                    sourceUnit: targetText,
                    historyOrigin: 'serial_segment',
                });
            } catch (e) {
                logger.error('翻译记忆合并失败（已保留译文）', e);
            }

            progressTracker.updateProgress(index, 'completed');
            const doneInfo =
                `完成 No. ${index + 1}/${totalCount} (${elapsed.toFixed(1)}s)` +
                `${parsed.warnings.length ? ` 警告:${parsed.warnings.length}` : ''}` +
                `\n${'-'.repeat(40)}\n`;
            logger.info(doneInfo);
            onProgress?.(doneInfo);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            progressTracker.updateProgress(index, 'failed', errorMessage);
            const errorInfo = `段落 ${index + 1}/${totalCount}: ${errorMessage}\n${'-'.repeat(40)}\n`;
            logger.error(errorInfo);
            onProgress?.(errorInfo);
        }
    }

    let processedCount = 0;
    let processedLength = 0;
    const unprocessed: ProcessStats['unprocessedParagraphs'] = [];
    for (let i = 0; i < totalCount; i++) {
        if (outputParagraphs[i] !== null) {
            processedCount++;
            processedLength += String(outputParagraphs[i] ?? '').length;
        } else {
            const preview = String(inputParagraphs[i]?.target ?? '').slice(0, 40);
            unprocessed.push({ index: i + 1, preview });
        }
    }

    return {
        totalCount,
        processedCount,
        totalLength: inputParagraphs.reduce((s, p) => s + String(p?.target ?? '').length, 0),
        processedLength,
        unprocessedParagraphs: unprocessed,
        progressTracker,
    };
}
