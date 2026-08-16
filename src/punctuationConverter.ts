/**
 * 常见半角/全角标点互转
 *
 * 对应关系：
 * ,;:!?  ↔  ，；：！？
 */

const HALF_TO_FULL: ReadonlyMap<string, string> = new Map([
    [',', '，'],
    [';', '；'],
    [':', '：'],
    ['!', '！'],
    ['?', '？']
]);

const FULL_TO_HALF: ReadonlyMap<string, string> = new Map([
    ['，', ','],
    ['；', ';'],
    ['：', ':'],
    ['！', '!'],
    ['？', '?']
]);

function replaceByMap(text: string, map: ReadonlyMap<string, string>): string {
    let result = '';
    for (const char of text) {
        result += map.get(char) ?? char;
    }
    return result;
}

/** 半角标点转全角标点（仅限 ,;:!?） */
export function halfToFullPunctuation(text: string): string {
    return replaceByMap(text, HALF_TO_FULL);
}

/** 全角标点转半角标点（仅限 ，；：！？） */
export function fullToHalfPunctuation(text: string): string {
    return replaceByMap(text, FULL_TO_HALF);
}
