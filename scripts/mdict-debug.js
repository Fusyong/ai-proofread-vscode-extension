/* eslint-disable no-console */
/**
 * 用于调试 mdict-js 对“同名多条词条”的返回行为。
 *
 * 用法（PowerShell）：
 *   node .\scripts\mdict-debug.js "D:\path\to\辞海7.mdx" 李白
 *
 * 输出：
 * - lookup(term) 返回类型/数组长度
 * - 若返回数组：逐条打印 keyText 的“可见形式 + Unicode 码点”，便于发现不可见差异
 * - prefix(term) 的候选数与精确匹配数（用于辅助判断词典内部是否确有多条）
 */

const mdictMod = require('mdict-js');
const Mdict = mdictMod && mdictMod.default ? mdictMod.default : mdictMod;
const util = require('util');

function normalizeForCompare(s) {
  const raw = String(s ?? '');
  const noSpace = raw
    .replace(/\s+/g, '')
    .replace(/\u00A0/g, '') // NBSP
    .replace(/\u200B/g, '') // zero-width space
    .replace(/\u200C/g, '') // zero-width non-joiner
    .replace(/\u200D/g, '') // zero-width joiner
    .replace(/\uFEFF/g, ''); // zero-width no-break space (BOM)
  try {
    return noSpace.normalize('NFKC');
  } catch {
    return noSpace;
  }
}

function toCodePoints(s) {
  return Array.from(String(s ?? '')).map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
}

function asOneLine(s) {
  return String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\\n');
}

function findDuplicateKeyRecords(mdict, term) {
  const termCmp = normalizeForCompare(term);
  const matches = [];

  const props = Object.getOwnPropertyNames(mdict);
  for (const p of props) {
    let v;
    try {
      v = mdict[p];
    } catch {
      continue;
    }
    // Array of records?
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') {
      const head = v[0];
      const hasKeyField = head && (typeof head.keyText === 'string' || typeof head.key === 'string');
      const hasOffsetField = head && (typeof head.rofset === 'number' || typeof head.recordStartOffset === 'number');
      if (hasKeyField && hasOffsetField) {
        for (const item of v) {
          const key = item?.keyText ?? item?.key;
          if (normalizeForCompare(key) === termCmp) {
            matches.push({ source: `prop:${p}`, key, rofset: item?.rofset ?? item?.recordStartOffset, raw: item });
          }
        }
      }
    }
    // Map-like?
    if (v && typeof v === 'object' && typeof v.forEach === 'function' && typeof v.get === 'function' && typeof v.size === 'number') {
      try {
        v.forEach((val, key) => {
          if (normalizeForCompare(key) === termCmp) {
            matches.push({ source: `map:${p}`, key, rofset: val?.rofset ?? val?.recordStartOffset, raw: val });
          }
        });
      } catch {
        // ignore
      }
    }
  }

  return matches;
}

function main() {
  const mdxPath = process.argv[2];
  const term = process.argv[3] ?? '李白';
  if (!mdxPath) {
    console.error('缺少参数：mdxPath\n示例：node .\\scripts\\mdict-debug.js "D:\\\\dicts\\\\辞海7.mdx" 李白');
    process.exitCode = 2;
    return;
  }

  console.log(`[mdict-debug] mdxPath=${mdxPath}`);
  console.log(`[mdict-debug] term=${term}`);
  console.log('');

  const mdict = new Mdict(mdxPath);
  const defMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(mdict)).filter((n) => /def/i.test(n));
  console.log(`[mdict-debug] def-related methods: ${defMethods.join(', ') || '(none)'}`);
  try {
    if (typeof mdict.parse_defination === 'function') {
      console.log(`[mdict-debug] parse_defination source head:`);
      const src = String(mdict.parse_defination);
      console.log(src.split('\n').slice(0, 25).join('\n'));
      console.log('...');
      console.log('');
    }
  } catch {
    // ignore
  }

  // 1) exact lookup
  let res;
  try {
    res = mdict.lookup(term);
  } catch (e) {
    console.error('[mdict-debug] lookup threw:', e);
    process.exitCode = 1;
    return;
  }

  console.log(`[mdict-debug] lookup(term) typeof=${typeof res} isArray=${Array.isArray(res)}`);
  if (Array.isArray(res)) {
    console.log(`[mdict-debug] lookup(term) array length=${res.length}`);
    const termCmp = normalizeForCompare(term);
    const sameKey = res.filter((x) => normalizeForCompare(x?.keyText) === termCmp);
    console.log(`[mdict-debug] entries whose keyText ~= term: ${sameKey.length}`);
    console.log('');

    res.forEach((x, i) => {
      const keyText = x?.keyText;
      const defType = typeof x?.definition;
      const rofset = x?.rofset ?? x?.recordStartOffset;
      console.log(`--- [${i + 1}/${res.length}]`);
      console.log(`keyText(raw)="${asOneLine(keyText)}"`);
      console.log(`keyText(codepoints)=${toCodePoints(keyText).join(' ')}`);
      console.log(`keyText(normalized)="${asOneLine(normalizeForCompare(keyText))}"`);
      console.log(`definition(typeof)=${defType} directLen=${typeof x?.definition === 'string' ? x.definition.length : 0}`);
      console.log(`rofset=${typeof rofset === 'number' ? rofset : 'n/a'}`);
      if (defType !== 'string' && typeof rofset === 'number' && typeof keyText === 'string') {
        try {
          const def = mdict.parse_defination(keyText, rofset);
          console.log(`parse_defination len=${typeof def === 'string' ? def.length : 0}`);
        } catch (e) {
          console.log(`parse_defination threw: ${String(e)}`);
        }
      }
      console.log('');
    });
  } else if (res && typeof res === 'object') {
    console.log(`[mdict-debug] lookup(term) object keys=${Object.keys(res).join(', ')}`);
    console.log(`keyText="${asOneLine(res.keyText)}"`);
    console.log(`keyText(codepoints)=${toCodePoints(res.keyText).join(' ')}`);
    console.log(`definition(typeof)=${typeof res.definition} len=${typeof res.definition === 'string' ? res.definition.length : 0}`);
  } else {
    console.log('[mdict-debug] lookup(term) returned null/empty');
  }

  console.log('\n==== attempt: scan in-memory key records for duplicates ====\n');
  try {
    const dup = findDuplicateKeyRecords(mdict, term);
    console.log(`[mdict-debug] duplicate scan hits=${dup.length}`);
    dup.slice(0, 10).forEach((m, i) => {
      console.log(`--- dup[${i + 1}/${dup.length}] from ${m.source}`);
      console.log(`key="${asOneLine(m.key)}" rofset=${typeof m.rofset === 'number' ? m.rofset : 'n/a'}`);
      console.log(util.inspect(m.raw, { depth: 1, colors: false, maxArrayLength: 20 }));
      if (typeof m.rofset === 'number' && m.key) {
        try {
          const def = mdict.parse_defination(m.key, m.rofset);
          console.log(`parse_defination len=${typeof def === 'string' ? def.length : 0}`);
        } catch (e) {
          console.log(`parse_defination threw: ${String(e)}`);
        }
      }
      console.log('');
    });
  } catch (e) {
    console.log(`[mdict-debug] duplicate scan failed: ${String(e)}`);
  }

  console.log('\n==== attempt: internal decode by offsets (duplicate keys) ====\n');
  try {
    const termCmp = normalizeForCompare(term);
    const keyList = Array.isArray(mdict.keyList) ? mdict.keyList : [];
    const dups = keyList.filter((k) => normalizeForCompare(k?.keyText) === termCmp);
    console.log(`[mdict-debug] keyList dups=${dups.length}`);
    dups.forEach((k, i) => {
      const keyText = k?.keyText;
      const start = k?.recordStartOffset;
      const next = k?.nextRecordStartOffset;
      console.log(`--- keyList[${i + 1}/${dups.length}] keyText="${asOneLine(keyText)}" start=${start} next=${next}`);
      try {
        const rid = typeof mdict._reduceRecordBlock === 'function' ? mdict._reduceRecordBlock(start) : null;
        const data =
          rid != null && typeof mdict._decodeRecordBlockByRBID === 'function'
            ? mdict._decodeRecordBlockByRBID(rid, keyText, start, next)
            : null;
        const len = typeof data === 'string' ? data.length : Buffer.isBuffer(data) ? data.length : data && typeof data.length === 'number' ? data.length : 0;
        console.log(`_decodeRecordBlockByRBID rid=${rid} typeof=${typeof data} isBuffer=${Buffer.isBuffer(data)} len=${len}`);
        if (typeof data === 'string' && data) {
          console.log(`head="${asOneLine(data.slice(0, 120))}"`);
        } else if (Buffer.isBuffer(data) && data.length > 0) {
          console.log(`buffer head hex=${data.subarray(0, 32).toString('hex')}`);
        } else if (data && typeof data === 'object') {
          console.log(util.inspect(data, { depth: 1, colors: false, maxArrayLength: 20 }));
        }
      } catch (e) {
        console.log(`_decodeRecordBlockByRBID threw: ${String(e)}`);
      }
      console.log('');
    });
  } catch (e) {
    console.log(`[mdict-debug] internal decode attempt failed: ${String(e)}`);
  }

  console.log('\n==== inspect _lookupKID(term) (if available) ====\n');
  try {
    if (typeof mdict._lookupKID === 'function') {
      const kid = mdict._lookupKID(term);
      const idx = kid?.idx;
      const list = Array.isArray(kid?.list) ? kid.list : [];
      console.log(`[mdict-debug] _lookupKID idx=${typeof idx === 'number' ? idx : 'n/a'} listLen=${list.length}`);
      const start = typeof idx === 'number' && idx >= 0 ? Math.max(0, idx - 3) : 0;
      const end = typeof idx === 'number' && idx >= 0 ? Math.min(list.length, idx + 4) : Math.min(list.length, 7);
      for (let i = start; i < end; i++) {
        const it = list[i];
        const keyText = it?.keyText ?? it?.key;
        const rofset = it?.recordStartOffset ?? it?.rofset;
        console.log(`- list[${i}] keyText="${asOneLine(keyText)}" rofset=${rofset}`);
      }
      if (typeof idx === 'number' && idx >= 0 && idx < list.length) {
        const it = list[idx];
        const keyText = it?.keyText ?? it?.key;
        const startoffset = it?.recordStartOffset ?? it?.rofset;
        const nextStart =
          idx + 1 >= list.length
            ? null
            : (list[idx + 1]?.recordStartOffset ?? list[idx + 1]?.rofset ?? null);
        console.log(`[mdict-debug] _lookupKID picked keyText="${asOneLine(keyText)}" start=${startoffset} next=${nextStart}`);
        try {
          const rid = typeof mdict._reduceRecordBlock === 'function' ? mdict._reduceRecordBlock(startoffset) : null;
          const data =
            rid != null && typeof mdict._decodeRecordBlockByRBID === 'function' && typeof nextStart === 'number'
              ? mdict._decodeRecordBlockByRBID(rid, keyText, startoffset, nextStart)
              : null;
          const len = typeof data === 'string' ? data.length : Buffer.isBuffer(data) ? data.length : data && typeof data.length === 'number' ? data.length : 0;
          console.log(
            `[mdict-debug] decode(using _lookupKID bounds) rid=${rid} typeof=${typeof data} isBuffer=${Buffer.isBuffer(data)} len=${len}`
          );
        } catch (e) {
          console.log(`[mdict-debug] decode(using _lookupKID bounds) threw: ${String(e)}`);
        }
      }
    } else {
      console.log('[mdict-debug] _lookupKID not available');
    }
  } catch (e) {
    console.log(`[mdict-debug] _lookupKID inspect failed: ${String(e)}`);
  }

  console.log('\n==== lookup(term) with mode:mixed (if supported) ====\n');
  try {
    const mdictMixed = new Mdict(mdxPath, { mode: 'mixed' });
    const resMixed = mdictMixed.lookup(term);
    console.log(`[mdict-debug] lookup(mixed) typeof=${typeof resMixed} isArray=${Array.isArray(resMixed)}`);
    if (Array.isArray(resMixed)) {
      console.log(`[mdict-debug] lookup(mixed) array length=${resMixed.length}`);
      const termCmp = normalizeForCompare(term);
      const sameKey = resMixed.filter((x) => normalizeForCompare(x?.keyText ?? x?.key) === termCmp);
      console.log(`[mdict-debug] lookup(mixed) entries whose keyText ~= term: ${sameKey.length}`);
      // 打印前 5 条摘要
      resMixed.slice(0, 5).forEach((x, i) => {
        const keyText = x?.keyText ?? x?.key;
        console.log(`[${i + 1}] keyText="${asOneLine(keyText)}" defType=${typeof x?.definition} defLen=${typeof x?.definition === 'string' ? x.definition.length : 0}`);
      });
    } else if (resMixed && typeof resMixed === 'object') {
      console.log(`[mdict-debug] lookup(mixed) object keys=${Object.keys(resMixed).join(', ')}`);
    } else {
      console.log('[mdict-debug] lookup(mixed) returned null/empty');
    }
  } catch (e) {
    console.log(`[mdict-debug] mixed mode not supported or failed: ${String(e)}`);
  }

  console.log('\n==== prefix(term) check ====\n');
  try {
    const list = mdict.prefix(term);
    console.log(`[mdict-debug] prefix(term) isArray=${Array.isArray(list)} length=${Array.isArray(list) ? list.length : 0}`);
    if (Array.isArray(list)) {
      const termCmp = normalizeForCompare(term);
      const exactInPrefix = list.filter((x) => normalizeForCompare(x?.keyText) === termCmp);
      console.log(`[mdict-debug] prefix candidates with keyText ~= term: ${exactInPrefix.length}`);
      // 打印前 10 条候选的结构，便于判断字段名/offset
      const head = list.slice(0, 10);
      head.forEach((x, i) => {
        const obj = x && typeof x === 'object' ? x : { value: x };
        const keys = obj && typeof obj === 'object' ? Object.keys(obj) : [];
        console.log(`--- prefix[${i + 1}/${list.length}]`);
        console.log(`keys=${keys.join(', ') || '(none)'}`);
        console.log(`keyText="${asOneLine(obj?.keyText)}"`);
        console.log(`keyText(codepoints)=${toCodePoints(obj?.keyText).join(' ')}`);
        console.log(`recordStartOffset=${obj?.recordStartOffset ?? obj?.rofset ?? 'n/a'}`);
        console.log(util.inspect(obj, { depth: 2, colors: false, maxArrayLength: 20 }));
        console.log('');
      });
    }
  } catch (e) {
    console.error('[mdict-debug] prefix threw:', e);
  }
}

main();

