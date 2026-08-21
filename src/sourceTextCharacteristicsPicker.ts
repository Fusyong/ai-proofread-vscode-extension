/**
 * 在校对流程中选择是否注入「源文本特性提示词」（仅当前为内置全文/条目模板提示词时）
 */

import * as vscode from 'vscode';
import { showQuickPickWithDefault } from './ui/quickPickDefault';
import {
    SYSTEM_PROMPT_NAME_FULL,
    SYSTEM_PROMPT_NAME_ITEM,
    SYSTEM_PROMPT_NAME_NORMALIZATION_FULL,
    SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM,
    SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM,
    SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM,
    SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL,
    SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM,
    SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL,
    SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL,
} from './promptManager';
import {
    BUILTIN_SOURCE_TEXT_CHARACTERISTICS,
    SOURCE_TEXT_CHARACTERISTICS_TEMPORARY_DISPLAY_TITLE,
} from './sourceTextCharacteristics';
import type { UserSourceTextCharacteristicPrompt } from './sourceTextCharacteristics';
import { SourceTextCharacteristicManager } from './sourceTextCharacteristicManager';

type PickKind = 'none' | 'builtin' | 'user' | 'custom';

const KEY_LAST_SOURCE_TEXT_CHARACTERISTICS_PICK = 'ai-proofread.sourceTextCharacteristics.lastPick';

interface LastSourceTextCharacteristicsPick {
    kind: PickKind;
    label: string;
    customText?: string;
}

interface CharacteristicPickItem extends vscode.QuickPickItem {
    pickKind: PickKind;
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
    return (
        n === SYSTEM_PROMPT_NAME_FULL ||
        n === SYSTEM_PROMPT_NAME_ITEM ||
        n === SYSTEM_PROMPT_NAME_NORMALIZATION_FULL ||
        n === SYSTEM_PROMPT_NAME_NORMALIZATION_ITEM ||
        n === SYSTEM_PROMPT_NAME_HARD_ISSUE_ITEM ||
        n === SYSTEM_PROMPT_NAME_CORRESPONDENCE_CHECK_ITEM ||
        n === SYSTEM_PROMPT_NAME_PINYIN_PROOFREAD_FULL ||
        n === SYSTEM_PROMPT_NAME_PINYIN_ANNOTATION_FULL ||
        n === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_ITEM ||
        n === SYSTEM_PROMPT_NAME_KNOWLEDGE_VERIFY_FULL ||
        n === SYSTEM_PROMPT_NAME_PARA_RESTRUCTURE_FULL
    );
}

function buildQuickPickItems(userPrompts: UserSourceTextCharacteristicPrompt[]): CharacteristicPickItem[] {
    const items: CharacteristicPickItem[] = [
        {
            label: '不注入',
            description: '默认',
            pickKind: 'none',
            injectText: '',
            displayTitle: '无',
        },
    ];
    for (const b of BUILTIN_SOURCE_TEXT_CHARACTERISTICS) {
        items.push({
            label: b.name,
            description: '内置',
            pickKind: 'builtin',
            injectText: b.content,
            displayTitle: b.name,
        });
    }
    for (const u of userPrompts) {
        items.push({
            label: u.name,
            description: '自定义',
            pickKind: 'user',
            injectText: u.content,
            displayTitle: u.name,
        });
    }
    items.push({
        label: '本次临时输入…',
        description: '仅本次校对有效，不保存到列表',
        pickKind: 'custom',
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
    const last = parseLastSourceTextCharacteristicsPick(
        context.workspaceState.get<unknown>(KEY_LAST_SOURCE_TEXT_CHARACTERISTICS_PICK)
    );
    const items = buildQuickPickItems(userPrompts);
    const picked = await showQuickPickWithDefault(items, {
        placeHolder: '是否注入源文本特性提示词？（仅作用于内置全文/条目模板：系统默认与表述正常化等）',
        ignoreFocusOut: true,
        lastValue: last?.label,
    });
    if (picked === undefined) {
        return undefined;
    }
    if (picked.pickKind === 'none') {
        await saveLastSourceTextCharacteristicsPick(context, { kind: 'none', label: picked.label });
        return { injectText: '', displayTitle: picked.displayTitle ?? '无' };
    }
    if (picked.pickKind === 'custom') {
        const text = await vscode.window.showInputBox({
            title: '本次临时注入',
            prompt: '“目标文本（target）是一个更大的源文本的一部分。对这个源文本的整体说明如下：”这句话会自动放在你填写的内容之前，请接着这句话往下写。',
            placeHolder: '多行说明可粘贴；留空等同不注入',
            value: last?.kind === 'custom' ? last.customText : undefined,
        });
        if (text === undefined) {
            return undefined;
        }
        const injectText = text.trim();
        await saveLastSourceTextCharacteristicsPick(context, {
            kind: 'custom',
            label: picked.label,
            customText: injectText,
        });
        return {
            injectText,
            displayTitle: injectText ? SOURCE_TEXT_CHARACTERISTICS_TEMPORARY_DISPLAY_TITLE : '无',
        };
    }
    await saveLastSourceTextCharacteristicsPick(context, { kind: picked.pickKind, label: picked.label });
    return {
        injectText: picked.injectText ?? '',
        displayTitle: picked.displayTitle ?? picked.label,
    };
}

function parseLastSourceTextCharacteristicsPick(raw: unknown): LastSourceTextCharacteristicsPick | undefined {
    if (typeof raw !== 'object' || raw === null) {
        return undefined;
    }
    const rec = raw as Record<string, unknown>;
    const kinds: PickKind[] = ['none', 'builtin', 'user', 'custom'];
    const kind = kinds.find((k) => k === rec.kind);
    if (!kind || typeof rec.label !== 'string' || !rec.label) {
        return undefined;
    }
    const customText = typeof rec.customText === 'string' ? rec.customText : undefined;
    return { kind, label: rec.label, customText };
}

async function saveLastSourceTextCharacteristicsPick(
    context: vscode.ExtensionContext,
    pick: LastSourceTextCharacteristicsPick
): Promise<void> {
    await context.workspaceState.update(KEY_LAST_SOURCE_TEXT_CHARACTERISTICS_PICK, pick);
}
