import '../../.agents/skills/ui-verification/assets/fixture-api';
// Capture with --styles base,float,board,memory: CanvasHelp depends on board.css.
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/renderer/src/i18n';
import { MemoryOverview } from '../../src/renderer/src/components/MemoryOverview';
import { applyTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
applyTheme(builtinTheme(new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark')!);
// A deterministic IPC boundary; the SVG and controls are the production component.
(window as any).api = { memoryCenter: {
  intents: async () => ({ items: [] }), recycle: async () => ({ preimages: [] }),
  log: async () => ({ items: [] }),
  events: async () => ({ items: [], kindCounts24h: {}, kindCounts7d: {} }),
  stagingList: async () => ({ pendingCount: 16 })
} };
createRoot(document.getElementById('root')!).render(
  <main style={{ display: 'flex', height: '100vh', background: 'var(--surface-canvas)' }}>
    <MemoryOverview center={null} pending={6} onSelectTab={tab => { document.documentElement.dataset.selectedMemoryTab = tab; }} live={{
      stats:{curated:9,profileChars:0,profileMax:800,pending:6,intents:1,recycle:102,lastConsolAt:null},
      backlog:7,processing:{failed:2,suspended:1,running:true,paused:false},
      feed:{todayActivations:6,items:[
        {id:1,kind:'auto_admitted',ts:Date.now(),summary:'已自动保存一条有依据的经验',namespace:'worker',stagingId:null,approvalId:null,chunkId:null,entryRef:'fixture-entry',summaryArgs:null}
      ],kindCounts24h:{auto_admitted:6,staged:7,evidence_linked:2,conflict_suspended:1,intent_fired:1},kindCounts7d:{auto_admitted:25,staged:40,evidence_linked:8,conflict_suspended:2,intent_fired:3}}
    }} />
  </main>
);
