import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DivergenceEntry, DivergenceRegister, PrunedEntry, ArchiveChapter, ChatMessage, ArchiveIndexEntry } from '../../types';

vi.mock('../../components/Toast', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('../callLLM', () => ({ callLLM: vi.fn() }));
vi.mock('../tokenizer', () => ({ countTokens: vi.fn(() => 100) }));

import { toast } from '../../components/Toast';
import { callLLM } from '../callLLM';
import {
    getEntriesForSceneRange,
    mergeEntries,
    buildSceneMap,
    renderRegisterForPayload,
    pruneChapterEntries,
    confirmReviewEntry,
    deleteReviewedEntry,
    restorePrunedEntry,
    backfillParseErrors,
    compressRegister,
    parseBulletDivergences,
    stripReasoning,
    EMPTY_REGISTER,
} from '../divergenceRegister';

const mockCallLLM = vi.mocked(callLLM);
const mockToast = vi.mocked(toast);

function makeEntry(overrides: Partial<DivergenceEntry> = {}): DivergenceEntry {
    return {
        id: `div_${Math.random().toString(36).slice(2, 8)}`,
        category: 'entity_state',
        subject: 'Test Subject',
        divergence: 'Test divergence description',
        sceneRef: '005',
        linkedSceneIds: ['005'],
        importance: 5,
        source: 'auto',
        ...overrides,
    };
}

function makeRegister(entries: DivergenceEntry[] = [], pruned: PrunedEntry[] = []): DivergenceRegister {
    return {
        entries,
        prunedLog: pruned,
        lastUpdatedSceneId: entries.length > 0 ? entries[entries.length - 1].sceneRef : '',
        lastUpdatedAt: Date.now(),
        version: 1,
    };
}

function makeChapter(overrides: Partial<ArchiveChapter> = {}): ArchiveChapter {
    return {
        chapterId: 'CH01',
        title: 'Test Chapter',
        sceneRange: ['001', '010'],
        summary: 'A test chapter about adventures',
        keywords: ['goblin', 'forest'],
        npcs: ['Grak', 'Elara'],
        majorEvents: ['Arrived at the forest', 'Defeated goblins'],
        unresolvedThreads: ['The goblin king escaped', 'Mysterious artifact found'],
        tone: 'adventurous',
        themes: ['exploration', 'combat'],
        sceneCount: 10,
        ...overrides,
    };
}

describe('getEntriesForSceneRange', () => {
    it('returns entries within the scene range', () => {
        const entries = [
            makeEntry({ sceneRef: '003' }),
            makeEntry({ sceneRef: '005' }),
            makeEntry({ sceneRef: '007' }),
            makeEntry({ sceneRef: '012' }),
            makeEntry({ sceneRef: '015' }),
        ];
        const reg = makeRegister(entries);
        const result = getEntriesForSceneRange(reg, ['003', '010']);
        expect(result).toHaveLength(3);
        expect(result.map(e => e.sceneRef)).toEqual(['003', '005', '007']);
    });

    it('returns empty array when no entries in range', () => {
        const entries = [
            makeEntry({ sceneRef: '001' }),
            makeEntry({ sceneRef: '002' }),
        ];
        const reg = makeRegister(entries);
        const result = getEntriesForSceneRange(reg, ['010', '020']);
        expect(result).toHaveLength(0);
    });

    it('returns empty array for empty register', () => {
        const reg = makeRegister();
        const result = getEntriesForSceneRange(reg, ['001', '010']);
        expect(result).toHaveLength(0);
    });

    it('handles single-scene range', () => {
        const entries = [
            makeEntry({ sceneRef: '005' }),
            makeEntry({ sceneRef: '005', subject: 'Another' }),
            makeEntry({ sceneRef: '006' }),
        ];
        const reg = makeRegister(entries);
        const result = getEntriesForSceneRange(reg, ['005', '005']);
        expect(result).toHaveLength(2);
    });

    it('handles entry exactly at range boundaries', () => {
        const entries = [
            makeEntry({ sceneRef: '003' }),
            makeEntry({ sceneRef: '010' }),
            makeEntry({ sceneRef: '011' }),
        ];
        const reg = makeRegister(entries);
        const result = getEntriesForSceneRange(reg, ['003', '010']);
        expect(result).toHaveLength(2);
    });
});

describe('mergeEntries', () => {
    it('adds new entries to empty register', () => {
        const reg = makeRegister();
        const newEntries = [
            makeEntry({ id: 'div_1', sceneRef: '001' }),
            makeEntry({ id: 'div_2', sceneRef: '002' }),
        ];
        const result = mergeEntries(reg, newEntries, '002');
        expect(result.entries).toHaveLength(2);
        expect(result.lastUpdatedSceneId).toBe('002');
    });

    it('supersedes existing entry with new one', () => {
        const existing = makeEntry({ id: 'div_old', sceneRef: '001', subject: 'Old', importance: 3 });
        const reg = makeRegister([existing]);
        const newEntries = [
            makeEntry({ id: 'div_new', sceneRef: '001', subject: 'New', importance: 8, supersedes: 'div_old' }),
        ];
        const result = mergeEntries(reg, newEntries, '001');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].id).toBe('div_new');
        expect(result.entries[0].importance).toBe(8);
    });

    it('merges linkedSceneIds when superseding', () => {
        const existing = makeEntry({ id: 'div_old', sceneRef: '001', linkedSceneIds: ['001', '002'] });
        const reg = makeRegister([existing]);
        const newEntries = [
            makeEntry({ id: 'div_new', sceneRef: '003', linkedSceneIds: ['003'], supersedes: 'div_old' }),
        ];
        const result = mergeEntries(reg, newEntries, '003');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].linkedSceneIds).toContain('001');
        expect(result.entries[0].linkedSceneIds).toContain('002');
        expect(result.entries[0].linkedSceneIds).toContain('003');
    });

    it('sorts entries by sceneRef', () => {
        const reg = makeRegister([makeEntry({ sceneRef: '005' })]);
        const newEntries = [
            makeEntry({ sceneRef: '001' }),
            makeEntry({ sceneRef: '010' }),
            makeEntry({ sceneRef: '003' }),
        ];
        const result = mergeEntries(reg, newEntries, '010');
        const refs = result.entries.map(e => e.sceneRef);
        expect(refs).toEqual(['001', '003', '005', '010']);
    });

    it('preserves prunedLog', () => {
        const pruned: PrunedEntry = {
            originalEntry: makeEntry({ id: 'div_pruned' }),
            prunedAt: Date.now(),
            chapterId: 'CH01',
            verdict: 'auto_pruned',
            reason: 'Test',
        };
        const reg = makeRegister([], [pruned]);
        const result = mergeEntries(reg, [makeEntry()], '001');
        expect(result.prunedLog).toHaveLength(1);
    });
});

describe('buildSceneMap', () => {
    it('maps user messages to scene IDs from archive index', () => {
        const archiveIndex: ArchiveIndexEntry[] = [
            { sceneId: '001', timestamp: 1, keywords: [], keywordStrengths: {}, npcsMentioned: [], witnesses: [], npcStrengths: {}, importance: 3, userSnippet: '' },
            { sceneId: '002', timestamp: 2, keywords: [], keywordStrengths: {}, npcsMentioned: [], witnesses: [], npcStrengths: {}, importance: 5, userSnippet: '' },
        ];
        const messages: ChatMessage[] = [
            { id: 'msg_1', role: 'user', content: 'Hello' },
            { id: 'msg_2', role: 'assistant', content: 'Hi' },
            { id: 'msg_3', role: 'user', content: 'Let us go' },
            { id: 'msg_4', role: 'assistant', content: 'Yes' },
        ];
        const result = buildSceneMap(archiveIndex, messages);
        expect(result.sceneIdsByMessageId['msg_1']).toBe('001');
        expect(result.sceneIdsByMessageId['msg_2']).toBe('001');
        expect(result.sceneIdsByMessageId['msg_3']).toBe('002');
        expect(result.sceneIdsByMessageId['msg_4']).toBe('002');
    });

    it('maps assistant messages to preceding user scene', () => {
        const archiveIndex: ArchiveIndexEntry[] = [
            { sceneId: '001', timestamp: 1, keywords: [], keywordStrengths: {}, npcsMentioned: [], witnesses: [], npcStrengths: {}, importance: 3, userSnippet: '' },
        ];
        const messages: ChatMessage[] = [
            { id: 'msg_1', role: 'assistant', content: 'Intro' },
            { id: 'msg_2', role: 'user', content: 'Hello' },
            { id: 'msg_3', role: 'assistant', content: 'Reply' },
        ];
        const result = buildSceneMap(archiveIndex, messages);
        expect(result.sceneIdsByMessageId['msg_1']).toBe('000');
        expect(result.sceneIdsByMessageId['msg_2']).toBe('001');
        expect(result.sceneIdsByMessageId['msg_3']).toBe('001');
    });

    it('returns empty map when no messages', () => {
        const result = buildSceneMap([], []);
        expect(Object.keys(result.sceneIdsByMessageId)).toHaveLength(0);
    });
});

describe('renderRegisterForPayload', () => {
    it('returns empty string for empty register', () => {
        expect(renderRegisterForPayload(EMPTY_REGISTER)).toBe('');
    });

    it('renders entries grouped by category', () => {
        const entries = [
            makeEntry({ sceneRef: '001', category: 'canon_override', subject: 'Orcs', divergence: 'Orcs are peaceful' }),
            makeEntry({ sceneRef: '002', category: 'entity_state', subject: 'Grak', divergence: 'Grak is ally' }),
        ];
        const reg = makeRegister(entries);
        const output = renderRegisterForPayload(reg);
        expect(output).toContain('CANON OVERRIDES');
        expect(output).toContain('NPC & ENTITY FATES');
        expect(output).toContain('Orcs are peaceful');
        expect(output).toContain('Grak is ally');
    });

    it('excludes resolved obligations', () => {
        const entries = [
            makeEntry({ sceneRef: '001', category: 'obligation', subject: 'Oath', divergence: 'Must save', resolved: true }),
            makeEntry({ sceneRef: '002', category: 'obligation', subject: 'Debt', divergence: 'Must pay', resolved: false }),
        ];
        const reg = makeRegister(entries);
        const output = renderRegisterForPayload(reg);
        expect(output).toContain('Must pay');
        expect(output).not.toContain('Must save');
    });

    it('marks manual entries with a marker', () => {
        const entries = [
            makeEntry({ sceneRef: '001', subject: 'Manual', divergence: 'Test', source: 'manual' }),
        ];
        const reg = makeRegister(entries);
        const output = renderRegisterForPayload(reg);
        expect(output).toContain('⚡');
    });
});

describe('pruneChapterEntries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns register unchanged when no chapter entries match', async () => {
        const entries = [
            makeEntry({ sceneRef: '050' }),
            makeEntry({ sceneRef: '051' }),
        ];
        const reg = makeRegister(entries);
        const chapter = makeChapter({ sceneRange: ['001', '010'] });
        const result = await pruneChapterEntries({ endpoint: '', apiKey: '', modelName: '' }, chapter, reg, [chapter]);
        expect(result).toBe(reg);
    });

    it('classifies entries as keep/prune/review and returns updated register', async () => {
        const entries = [
            makeEntry({ id: 'div_1', sceneRef: '003', subject: 'Grak', divergence: 'Grak attacked' }),
            makeEntry({ id: 'div_2', sceneRef: '005', subject: 'Forest', divergence: 'Party left forest' }),
            makeEntry({ id: 'div_3', sceneRef: '007', subject: 'Artifact', divergence: 'Found artifact' }),
        ];
        const reg = makeRegister(entries);
        const chapter = makeChapter({ sceneRange: ['001', '010'] });

        mockCallLLM.mockResolvedValueOnce(JSON.stringify([
            { id: 'div_1', verdict: 'keep', reason: 'Recurring NPC' },
            { id: 'div_2', verdict: 'prune', reason: 'Left permanently' },
            { id: 'div_3', verdict: 'review', reason: 'Uncertain significance' },
        ]));

        const result = await pruneChapterEntries({ endpoint: '', apiKey: '', modelName: '' }, chapter, reg, [chapter]);

        expect(result.entries).toHaveLength(2);
        const kept = result.entries.filter(e => !e.reviewFlag);
        const flagged = result.entries.filter(e => e.reviewFlag);
        expect(flagged).toHaveLength(1);
        expect(flagged[0].id).toBe('div_3');
        expect(kept).toHaveLength(1);
        expect(kept[0].id).toBe('div_1');
        expect(result.prunedLog).toHaveLength(1);
        expect(result.prunedLog[0].originalEntry.id).toBe('div_2');
        expect(result.prunedLog[0].verdict).toBe('auto_pruned');
    });

    it('defaults to keep when LLM does not mention an entry', async () => {
        const entries = [
            makeEntry({ id: 'div_1', sceneRef: '003', subject: 'A', divergence: 'A' }),
            makeEntry({ id: 'div_2', sceneRef: '005', subject: 'B', divergence: 'B' }),
        ];
        const reg = makeRegister(entries);
        const chapter = makeChapter({ sceneRange: ['001', '010'] });

        mockCallLLM.mockResolvedValueOnce(JSON.stringify([
            { id: 'div_1', verdict: 'prune', reason: 'Not needed' },
        ]));

        const result = await pruneChapterEntries({ endpoint: '', apiKey: '', modelName: '' }, chapter, reg, [chapter]);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].id).toBe('div_2');
        expect(result.prunedLog).toHaveLength(1);
    });

    it('returns unchanged register and shows toast on LLM failure', async () => {
        const entries = [makeEntry({ id: 'div_1', sceneRef: '003', subject: 'Test', divergence: 'Test' })];
        const reg = makeRegister(entries);
        const chapter = makeChapter({ sceneRange: ['001', '010'] });

        mockCallLLM.mockRejectedValueOnce(new Error('API error'));

        const result = await pruneChapterEntries({ endpoint: '', apiKey: '', modelName: '' }, chapter, reg, [chapter]);
        expect(result).toBe(reg);
        expect(mockToast.error).toHaveBeenCalledWith(expect.stringContaining('API error'));
    });

    it('falls back to free-text parsing when LLM returns non-JSON', async () => {
        const entries = [
            makeEntry({ id: 'div_keep', sceneRef: '003', subject: 'NPC', divergence: 'Alive' }),
            makeEntry({ id: 'div_prune', sceneRef: '005', subject: 'Location', divergence: 'Left' }),
        ];
        const reg = makeRegister(entries);
        const chapter = makeChapter({ sceneRange: ['001', '010'] });

        mockCallLLM.mockResolvedValueOnce(
            'div_keep should be kept because NPC is important\n' +
            'div_prune should be pruned since party left forever\n' +
            'some random text without verdicts here'
        );

        const result = await pruneChapterEntries({ endpoint: '', apiKey: '', modelName: '' }, chapter, reg, [chapter]);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].id).toBe('div_keep');
        expect(result.prunedLog).toHaveLength(1);
        expect(result.prunedLog[0].originalEntry.id).toBe('div_prune');
        expect(result.prunedLog[0].verdict).toBe('auto_pruned');
    });

    it('preserves entries outside chapter range', async () => {
        const entries = [
            makeEntry({ id: 'div_1', sceneRef: '003', subject: 'Inside', divergence: 'Inside' }),
            makeEntry({ id: 'div_2', sceneRef: '015', subject: 'Outside', divergence: 'Outside' }),
        ];
        const reg = makeRegister(entries);
        const chapter = makeChapter({ sceneRange: ['001', '010'] });

        mockCallLLM.mockResolvedValueOnce(JSON.stringify([
            { id: 'div_1', verdict: 'prune', reason: 'Done' },
        ]));

        const result = await pruneChapterEntries({ endpoint: '', apiKey: '', modelName: '' }, chapter, reg, [chapter]);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].id).toBe('div_2');
        expect(result.prunedLog).toHaveLength(1);
        expect(result.prunedLog[0].originalEntry.id).toBe('div_1');
    });

    it('includes chapter summary and threads in the prompt', async () => {
        const entries = [makeEntry({ id: 'div_1', sceneRef: '003', subject: 'Test', divergence: 'Test' })];
        const reg = makeRegister(entries);
        const chapter = makeChapter({
            sceneRange: ['001', '010'],
            summary: 'The party explored the dark forest and fought goblins.',
            unresolvedThreads: ['Goblin king escaped', 'Mysterious artifact glows'],
            npcs: ['Grak', 'Elara'],
        });

        mockCallLLM.mockResolvedValueOnce(JSON.stringify([
            { id: 'div_1', verdict: 'keep', reason: 'Important' },
        ]));

        await pruneChapterEntries({ endpoint: '', apiKey: '', modelName: '' }, chapter, reg, [chapter]);

        const promptArg = mockCallLLM.mock.calls[0][1] as string;
        expect(promptArg).toContain('The party explored the dark forest and fought goblins.');
        expect(promptArg).toContain('Goblin king escaped');
        expect(promptArg).toContain('Mysterious artifact glows');
        expect(promptArg).toContain('grak, elara');
    });
});

describe('confirmReviewEntry', () => {
    it('clears reviewFlag on the specified entry', () => {
        const entries = [
            makeEntry({ id: 'div_1', reviewFlag: true }),
            makeEntry({ id: 'div_2', reviewFlag: false }),
        ];
        const reg = makeRegister(entries);
        const result = confirmReviewEntry(reg, 'div_1');
        expect(result.entries.find(e => e.id === 'div_1')?.reviewFlag).toBe(false);
        expect(result.entries.find(e => e.id === 'div_2')?.reviewFlag).toBe(false);
    });

    it('no-ops when entry not found', () => {
        const reg = makeRegister([makeEntry({ id: 'div_1' })]);
        const result = confirmReviewEntry(reg, 'nonexistent');
        expect(result.entries).toEqual(reg.entries);
    });
});

describe('deleteReviewedEntry', () => {
    it('moves entry to prunedLog with user_deleted_review verdict', () => {
        const entry = makeEntry({ id: 'div_1', reviewFlag: true });
        const reg = makeRegister([entry]);
        const result = deleteReviewedEntry(reg, 'div_1');
        expect(result.entries).toHaveLength(0);
        expect(result.prunedLog).toHaveLength(1);
        expect(result.prunedLog[0].verdict).toBe('user_deleted_review');
        expect(result.prunedLog[0].originalEntry.id).toBe('div_1');
    });

    it('no-ops when entry not found', () => {
        const reg = makeRegister([makeEntry({ id: 'div_1' })]);
        const result = deleteReviewedEntry(reg, 'nonexistent');
        expect(result.entries).toHaveLength(1);
    });
});

describe('restorePrunedEntry', () => {
    it('moves entry from prunedLog back to entries', () => {
        const original = makeEntry({ id: 'div_pruned', reviewFlag: true });
        const pruned: PrunedEntry = {
            originalEntry: original,
            prunedAt: Date.now(),
            chapterId: 'CH01',
            verdict: 'auto_pruned',
            reason: 'Test',
        };
        const reg = makeRegister([], [pruned]);
        const result = restorePrunedEntry(reg, 0);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].id).toBe('div_pruned');
        expect(result.entries[0].reviewFlag).toBe(false);
        expect(result.prunedLog).toHaveLength(0);
    });

    it('no-ops when index out of bounds', () => {
        const reg = makeRegister([], []);
        const result = restorePrunedEntry(reg, -1);
        expect(result).toBe(reg);
    });
});

describe('backfillParseErrors', () => {
    it('clears parseError when entry can be reparsed', () => {
        const entries = [
            {
                ...makeEntry({ sceneRef: '001' }),
                category: 'entity_state' as const,
                subject: 'Grak',
                divergence: 'Grak is now an ally',
                parseError: true,
            },
        ];
        const reg = makeRegister(entries);
        const result = backfillParseErrors(reg);
        expect(result.entries[0].parseError).toBe(false);
    });
});
