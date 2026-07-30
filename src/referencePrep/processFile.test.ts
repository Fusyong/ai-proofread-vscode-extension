import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    getReferencePrepProcessPath,
    listProcessRecords,
    loadDocumentFile,
    loadOrCreateProcessFile,
    loadProcessFile,
    saveProcessFile,
} from './processFile';
import type { ReferencePrepProcessFileV020 } from './schema';

describe('processFile multi-record', () => {
    const tmpDirs: string[] = [];

    afterEach(() => {
        for (const dir of tmpDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        tmpDirs.length = 0;
    });

    function tmpDoc(name = 'chapter.md'): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refprep-'));
        tmpDirs.push(dir);
        const doc = path.join(dir, name);
        fs.writeFileSync(doc, '# test\n', 'utf8');
        return doc;
    }

    it('upgrades legacy v0.2 flat file to v0.3 with one record', () => {
        const doc = tmpDoc();
        const processPath = getReferencePrepProcessPath(doc);
        const legacy: ReferencePrepProcessFileV020 = {
            version: '0.2.0',
            targetPreview: '李白',
            userInput: '李白',
            enabledSources: ['grep_md'],
            strength: 'standard',
            rounds: [],
            corpus: [],
        };
        fs.writeFileSync(processPath, JSON.stringify(legacy), 'utf8');

        const loaded = loadDocumentFile(doc);
        expect(loaded?.version).toBe('0.3.0');
        expect(loaded?.records).toHaveLength(1);
        expect(loaded?.records[0].userInput).toBe('李白');
        expect(loadProcessFile(doc)?.userInput).toBe('李白');
    });

    it('keeps independent records for different selections in one JSON', () => {
        const doc = tmpDoc();
        const first = loadOrCreateProcessFile({
            anchorPath: doc,
            enabledSources: ['dict'],
            strength: 'light',
            targetPreview: '第一段选区',
            userInput: '第一段选区',
        });
        first.corpus = [
            {
                hitId: 'h1',
                source: 'dict',
                queryId: 'q1',
                baseValue: 1,
                aggregatedValue: 1,
                snippet: 'a',
                digest: 'd1',
                referenceBlock: 'block-a',
                status: 'active',
            },
        ];
        first.mergedReference = 'block-a';
        saveProcessFile(doc, first);

        const second = loadOrCreateProcessFile({
            anchorPath: doc,
            enabledSources: ['grep_md'],
            strength: 'standard',
            targetPreview: '第二段选区',
            userInput: '第二段选区',
        });
        expect(second.id).not.toBe(first.id);
        expect(second.corpus).toHaveLength(0);
        second.corpus = [
            {
                hitId: 'h2',
                source: 'grep_md',
                queryId: 'q2',
                baseValue: 1,
                aggregatedValue: 1,
                snippet: 'b',
                digest: 'd2',
                referenceBlock: 'block-b',
                status: 'active',
            },
        ];
        second.mergedReference = 'block-b';
        saveProcessFile(doc, second);

        const docFile = loadDocumentFile(doc);
        expect(docFile?.records).toHaveLength(2);
        expect(docFile?.activeRecordId).toBe(second.id);

        const records = listProcessRecords(doc);
        expect(records.map((r) => r.userInput).sort()).toEqual(['第一段选区', '第二段选区']);

        const reopenedFirst = loadOrCreateProcessFile({
            anchorPath: doc,
            enabledSources: ['dict'],
            strength: 'light',
            userInput: '第一段选区',
            targetPreview: '第一段选区',
        });
        expect(reopenedFirst.id).toBe(first.id);
        expect(reopenedFirst.corpus).toHaveLength(1);
        expect(reopenedFirst.mergedReference).toBe('block-a');
        expect(reopenedFirst.targetPreview).toBe('第一段选区');
        expect(reopenedFirst.userInput).toBe('第一段选区');
    });

    it('updates both targetPreview and userInput when revisiting same selection', () => {
        const doc = tmpDoc();
        const a = loadOrCreateProcessFile({
            anchorPath: doc,
            enabledSources: ['dict'],
            strength: 'light',
            targetPreview: '同选区',
            userInput: '同选区',
        });
        saveProcessFile(doc, a);

        const b = loadOrCreateProcessFile({
            anchorPath: doc,
            enabledSources: ['dict'],
            strength: 'light',
            targetPreview: '同选区',
            userInput: '同选区',
        });
        expect(b.id).toBe(a.id);
        b.targetPreview = '同选区';
        b.userInput = '同选区';
        saveProcessFile(doc, b);

        const disk = loadDocumentFile(doc);
        expect(disk?.records).toHaveLength(1);
        expect(disk?.records[0].targetPreview).toBe('同选区');
        expect(disk?.records[0].userInput).toBe('同选区');
    });
});
