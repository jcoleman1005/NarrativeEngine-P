import { useState, useEffect } from 'react';
import { Settings, PanelLeftOpen, PanelLeftClose, Trash2, LogOut, Users, Archive, Save, ScanSearch, BookCheck } from 'lucide-react';
import { createBackup } from '../store/campaignStore';
import { flushAllPendingSaves } from '../store/slices/campaignSlice';
import { toast } from './Toast';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { saveCampaignState } from '../store/campaignStore';
import { API_BASE as API } from '../lib/apiBase';

type LoreSelectionSnapshot = {
    messageId: string;
    text: string;
    start: number;
    end: number;
    bubbleText: string;
};

export function Header() {
    const {
        toggleSettings,
        toggleDrawer,
        toggleNPCLedger,
        toggleBackupModal,
        drawerOpen,
        clearChat,
        activeCampaignId,
        setActiveCampaign,
        context,
        messages,
        condenser,
        divergenceRegister,
    } = useAppStore();

    const deepArmed = useAppStore(s => s.deepArmed);
    const toggleDeepArmed = useAppStore(s => s.toggleDeepArmed);
    const settings = useAppStore(s => s.settings);
    const openLoreCheck = useAppStore(s => s.openLoreCheck);

    const [loreSel, setLoreSel] = useState<LoreSelectionSnapshot | null>(null);

    const captureSelection = (): LoreSelectionSnapshot | null => {
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
        const range = sel.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const el = (node.nodeType === 1 ? node as Element : node.parentElement);
        const bubble = el?.closest('[data-lore-checkable="true"]') as HTMLElement | null;
        if (!bubble) return null;
        const messageId = bubble.dataset.messageId;
        const text = sel.toString().trim();
        if (!messageId || text.length < 3) return null;
        const bubbleText = bubble.textContent ?? '';
        const start = bubbleText.indexOf(text);
        if (start === -1) return null;
        return { messageId, text, start, end: start + text.length, bubbleText };
    };

    useEffect(() => {
        const handle = () => setLoreSel(captureSelection());
        document.addEventListener('selectionchange', handle);
        return () => document.removeEventListener('selectionchange', handle);
    }, []);

    const handleLoreCheck = (e: React.MouseEvent | React.TouchEvent) => {
        e.preventDefault();
        const snap = captureSelection() ?? loreSel;
        if (!snap) return;
        const before = snap.bubbleText.slice(Math.max(0, snap.start - 200), snap.start);
        const after = snap.bubbleText.slice(snap.end, Math.min(snap.bubbleText.length, snap.end + 200));
        openLoreCheck({
            messageId: snap.messageId, selectedText: snap.text,
            start: snap.start, end: snap.end,
            surroundingContext: `${before}[[HIGHLIGHTED]]${snap.text}[[/HIGHLIGHTED]]${after}`,
        });
        window.getSelection()?.removeAllRanges();
        setLoreSel(null);
    };

    const handleExit = async () => {
        if (activeCampaignId) {
            await saveCampaignState(activeCampaignId, { context, messages, condenser });
            if (divergenceRegister && (divergenceRegister.entries.length > 0 || (divergenceRegister.prunedLog ?? []).length > 0)) {
                try {
                    const { saveDivergenceRegister } = await import('../store/campaignStore');
                    await saveDivergenceRegister(activeCampaignId, divergenceRegister);
                } catch {}
            }
        }
        setActiveCampaign(null);
    };

    return (
        <header className="h-12 bg-surface border-b border-border flex items-center px-2 sm:px-4 gap-1 sm:gap-2 shrink-0">
            <button
                onClick={toggleDrawer}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
                aria-label={drawerOpen ? 'Close context drawer' : 'Open context drawer'}
            >
                {drawerOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
            </button>

            <h1 className="hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                Narrative Engine
            </h1>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <button
                onClick={async () => {
                    if (!activeCampaignId) return;
                    await flushAllPendingSaves();
                    const result = await createBackup(activeCampaignId, { trigger: 'manual', label: 'Manual backup' });
                    if (result?.skipped) {
                        toast.info('No changes since last backup');
                    } else if (result?.timestamp) {
                        toast.success('Backup created');
                    } else {
                        toast.error('Failed to create backup');
                    }
                }}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Create backup"
                aria-label="Create backup"
            >
                <Save size={16} />
            </button>

            <button
                onClick={toggleBackupModal}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Backup manager"
                aria-label="Open backup manager"
            >
                <Archive size={16} />
            </button>

            <button
                onClick={() => {
                    if (activeCampaignId) {
                        fetch(`${API}/campaigns/${activeCampaignId}/backup`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ trigger: 'pre-clear', isAuto: true }),
                        }).catch(() => {});
                    }
                    clearChat();
                }}
                className="text-text-dim hover:text-danger transition-colors p-1"
                title="Clear chat history"
                aria-label="Clear chat history"
            >
                <Trash2 size={16} />
            </button>

            <button
                onClick={toggleNPCLedger}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="NPC Ledger"
                aria-label="Open NPC Ledger"
            >
                <Users size={18} />
            </button>

            {settings.deepContextSearch && (
                <button
                    onClick={toggleDeepArmed}
                    className={`p-1 transition-colors ${deepArmed ? 'text-amber-400 animate-pulse' : 'text-text-dim hover:text-amber-400'}`}
                    title={deepArmed ? 'Deep Search armed — send to activate' : 'Arm Deep Archive Search'}
                    aria-label="Toggle Deep Archive Search"
                >
                    <ScanSearch size={18} />
                </button>
            )}

            <button
                onMouseDown={handleLoreCheck}
                className={`transition-colors p-1 ${loreSel ? 'text-terminal animate-pulse' : 'text-text-dim hover:text-terminal'}`}
                title="Lore Check selection (highlight text in a GM message first)"
                aria-label="Lore Check selection"
            >
                <BookCheck size={16} />
            </button>

            <button
                onClick={toggleSettings}
                className="text-text-dim hover:text-terminal transition-colors p-1"
                title="Settings"
                aria-label="Open settings"
            >
                <Settings size={18} />
            </button>

            <button
                onClick={handleExit}
                className="text-text-dim hover:text-ember transition-colors p-1 ml-1"
                title="Exit campaign"
                aria-label="Exit campaign"
            >
                <LogOut size={16} />
            </button>
        </header>
    );
}

