export type OpenccLocale = 'cn' | 'tw' | 'twp' | 'hk' | 'jp' | 't';

type OpenccConverter = (text: string) => string;

const converterCache = new Map<string, OpenccConverter>();

function cacheKey(from: OpenccLocale, to: OpenccLocale): string {
    return `${from}→${to}`;
}

/**
 * 获取 opencc-js 转换函数（带缓存）。
 * opencc-js 文档见：https://github.com/nk2028/opencc-js
 */
export function getOpenccConverter(from: OpenccLocale, to: OpenccLocale): OpenccConverter {
    const key = cacheKey(from, to);
    const cached = converterCache.get(key);
    if (cached) return cached;

    // opencc-js 是 CommonJS；parcel + outputFormat=commonjs 下用 require 最稳妥。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const OpenCC = require('opencc-js') as {
        Converter: (opts: { from: OpenccLocale; to: OpenccLocale }) => OpenccConverter;
    };
    const converter = OpenCC.Converter({ from, to });
    converterCache.set(key, converter);
    return converter;
}

export function convertOpencc(text: string, from: OpenccLocale, to: OpenccLocale): string {
    if (!text) return text;
    if (from === to) return text;
    const converter = getOpenccConverter(from, to);
    return converter(text);
}

