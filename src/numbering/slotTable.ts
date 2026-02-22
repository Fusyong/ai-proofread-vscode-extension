/**
 * 标题体系全表：序号类型 × 序号标记，固定预置
 * 规划见 docs/numbering-hierarchy-check-plan.md 2.3
 */

import type { SequenceType } from './types';

export interface SlotDef {
    slotId: number;
    /** 标题级别（1,2,3,…），用于 assignedLevel = baseLevel - 1 + subLevel */
    baseLevel: number;
    sequenceType: SequenceType | null;
    marker: string;
    pattern: RegExp;
    multiLevel: boolean;
}

/** 罗马数字（大写） */
const ROMAN = '[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+';
/** 中文数字 */
const CN_LO = '[一二三四五六七八九十百千]+';
const CN_UP = '[壹贰叁肆伍陆柒捌玖拾佰仟]+';
/** 阿拉伯数字 */
const AR = '\\d+';
/** 拉丁大写 */
const LAT_UP = '[A-Z]+';

/** 第章/第节 通用数字部分（cn-up | cn-lo | rm-up | ar），需捕获以便提取 numberingValue */
const DI_ZHANG_JIE_CAPTURE = `([壹贰叁肆伍陆柒捌玖拾佰仟]+|[一二三四五六七八九十百千]+|${ROMAN}|\\d+)`;

/** 标题体系全表（12 个 slot，按 slotId 顺序匹配） */
export const SLOT_TABLE: SlotDef[] = [
    { slotId: 1, baseLevel: 1, sequenceType: 'chinese-lower', marker: '第章', pattern: new RegExp(`^\\s*(#{1,6}\\s+)?第${DI_ZHANG_JIE_CAPTURE}[章]\\s*(.*)$`), multiLevel: false },
    { slotId: 2, baseLevel: 1, sequenceType: 'arabic', marker: '§', pattern: /^\s*(#{1,6}\s+)?§\s*(\d+)([.．]\d+)*\s*(.*)$/, multiLevel: true },
    { slotId: 3, baseLevel: 2, sequenceType: 'chinese-lower', marker: '第节', pattern: new RegExp(`^\\s*(#{1,6}\\s+)?第${DI_ZHANG_JIE_CAPTURE}[节]\\s*(.*)$`), multiLevel: false },
    { slotId: 4, baseLevel: 3, sequenceType: 'chinese-lower', marker: '顿', pattern: /^\s*(#{1,6}\s+)?([一二三四五六七八九十百千]+)、\s*(.*)$/, multiLevel: false },
    { slotId: 5, baseLevel: 4, sequenceType: 'chinese-lower', marker: '括', pattern: /^\s*(#{1,6}\s+)?[(\（﹙]([一二三四五六七八九十百千]+)[)\）﹚]\s*(.*)$/, multiLevel: false },
    { slotId: 6, baseLevel: 4, sequenceType: null, marker: '括中', pattern: /^\s*(#{1,6}\s+)?([㈠㈡㈢㈣㈤㈥㈦㈧㈨㈩㈪㈫㈬㈭㈮㈯㈰㈱㈲㈳㈴㈵㈶㈷㈸㈹㈺㈻㈼㈽㈾㈿㉀㉁㉂㉃㉄㉅㉆㉇㉈㉉㉊㉋㉌㉍㉎㉏㉐㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟])\s*(.*)$/, multiLevel: false },
    { slotId: 7, baseLevel: 5, sequenceType: 'arabic', marker: '点', pattern: /^\s*(#{1,6}\s+)?(\d+)(?=[.．])([.．]\d+)*[.．]?\s*(.*)$/, multiLevel: true },
    { slotId: 8, baseLevel: 5, sequenceType: null, marker: '点数', pattern: /^\s*(#{1,6}\s+)?([⒈⒉⒊⒋⒌⒍⒎⒏⒐⒑⒒⒓⒔⒕⒖⒗⒘⒙⒚⒛])\s*(.*)$/, multiLevel: false },
    { slotId: 9, baseLevel: 6, sequenceType: 'arabic', marker: '括', pattern: /^\s*(#{1,6}\s+)?[(\（﹙](\d+)[)\）﹚]\s*(.*)$/, multiLevel: false },
    { slotId: 10, baseLevel: 6, sequenceType: null, marker: '括数', pattern: /^\s*(#{1,6}\s+)?([⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇])\s*(.*)$/, multiLevel: false },
    { slotId: 11, baseLevel: 7, sequenceType: null, marker: '圈', pattern: /^\s*(#{1,6}\s+)?([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳㉑㉒㉓㉔㉕㉖㉗㉘㉙㉚㉛㉜㉝㉞㉟㊱㊲㊳㊴㊵㊶㊷㊸㊹㊺㊻㊼㊽㊾㊿])\s*(.*)$/, multiLevel: false },
    { slotId: 12, baseLevel: 8, sequenceType: 'latin-upper', marker: '点', pattern: /^\s*(#{1,6}\s+)?([A-Z]+)[.．]\s*(.*)$/, multiLevel: false },
];

/** 按 slotId 查找 slot 定义 */
export function getSlotById(slotId: number): SlotDef | undefined {
    return SLOT_TABLE.find((s) => s.slotId === slotId);
}
