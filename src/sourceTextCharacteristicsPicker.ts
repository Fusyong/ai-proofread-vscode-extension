/**
 * 在校对流程中选择是否注入「源文本特性提示词」（仅当前为系统默认 full/item 提示词时）
 */

import * as vscode from 'vscode';
import { SYSTEM_PROMPT_NAME_FULL, SYSTEM_PROMPT_NAME_ITEM } from './promptManager';
import { BUILTIN_SOURCE_TEXT_CHARACTERISTICS } from './sourceTextCharacteristics';
import type { UserSourceTextCharacteristicPrompt } from './sourceTextCharacteristics';
import { SourceTextCharacteristicManager } from './sourceTextCharacteristicManager';

type PickKind = 'none' | 'builtin' | 'user' | 'custom';

interface CharacteristicPickItem extends vscode.QuickPickItem {
    kind: PickKind;
    injectText?: string;
    /** 用于通知/日志，与 label 一致，不展示正文 */
    displayTitle?: string;
}

/** 用户选择结果：injectText 供 API 使用；displayTitle 仅用于界面与日志标题 */
export interface SourceTextCharacteristicsPickResult {
    injectText: string;
    displayTitle: string;
}

export function isUsingSystemDefaultPrompt(context: vscode.ExtensionContext): boolean {
    const n = context.globalState.get<string>('currentPrompt', SYSTEM_PROMPT_NAME_FULL) ?? SYSTEM_PROMPT_NAME_FULL;
    return n === SYSTEM_PROMPT_NAME_FULL || n === SYSTEM_PROMPT_NAME_ITEM;
}

function buildQuickPickItems(userPrompts: UserSourceTextCharacteristicPrompt[]): CharacteristicPickItem[] {
    const items: CharacteristicPickItem[] = [
        {
            label: '不注入',
            description: '默认',
            kind: 'none',
            injectText: '',
            displayTitle: '无',
        },
    ];
    for (const b of BUILTIN_SOURCE_TEXT_CHARACTERISTICS) {
        items.push({
            label: b.name,
            description: '内置',
            kind: 'builtin',
            injectText: b.content,
            displayTitle: b.name,
        });
    }
    for (const u of userPrompts) {
        items.push({
            label: u.name,
            description: '自定义',
            kind: 'user',
            injectText: u.content,
            displayTitle: u.name,
        });
    }
    items.push({
        label: '本次临时输入…',
        description: '仅本次校对有效，不保存到列表',
        kind: 'custom',
    });
    return items;
}

/**
 * @returns 注入正文与展示用标题；undefined 表示用户取消
 */
export async function pickSourceTextCharacteristicsInjection(
    context: vscode.ExtensionContext
): Promise<SourceTextCharacteristicsPickResult | undefined> {
    const manager = SourceTextCharacteristicManager.getInstance(context);
    const userPrompts = manager.getUserPrompts();
    const picked = await vscode.window.showQuickPick(buildQuickPickItems(userPrompts), {
        placeHolder: '是否注入源文本特性提示词？（仅作用于系统默认提示词）',
        ignoreFocusOut: true,
    });
    if (picked === undefined) {
        return undefined;
    }
    if (picked.kind === 'none') {
        return { injectText: '', displayTitle: picked.displayTitle ?? '无' };
    }
    if (picked.kind === 'custom') {
        const text = await vscode.window.showInputBox({
            title: '本次临时注入',
            prompt: '“目标文本（target）是一个更大的源文本的一部分。对这个源文本的整体说明如下：”这句话会自动放在你填写的内容之前，请接着这句话往下写。',
            placeHolder: '多行说明可粘贴；留空等同不注入',
        });
        if (text === undefined) {
            return undefined;
        }
        const injectText = text.trim();
        return {
            injectText,
            displayTitle: injectText ? '本次临时输入' : '无',
        };
    }
    return {
        injectText: picked.injectText ?? '',
        displayTitle: picked.displayTitle ?? picked.label,
    };
}
