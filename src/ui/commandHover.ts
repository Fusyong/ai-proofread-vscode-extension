/**
 * UI 按钮悬停：说明之外附上对应命令短名（省略统一前缀 ai-proofread.）。
 * TreeView 标题栏按钮由 package.json 的 title（悬停）+ shortTitle（按钮文字）承担。
 */

const COMMAND_PREFIX = 'ai-proofread.';

/** 省略统一前缀后的命令短名，供悬停展示 */
export function shortCommandId(commandId: string): string {
    return commandId.startsWith(COMMAND_PREFIX) ? commandId.slice(COMMAND_PREFIX.length) : commandId;
}

/** 按钮悬停文案：说明 + 命令短名 */
export function commandHoverTitle(description: string, commandId: string): string {
    const short = shortCommandId(commandId);
    const desc = description.trim();
    if (!desc) {
        return short;
    }
    if (desc.includes(`(${short})`) || desc.endsWith(short)) {
        return desc;
    }
    return `${desc} (${short})`;
}
