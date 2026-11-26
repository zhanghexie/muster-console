import { guiChatMessageEqual, type GuiChatMessage, type GuiWorkerHistoryPage } from '../../../shared/guiWorker';
import type { SessionMeta } from '../../../shared/types';
import { ChatTranscript, type TranscriptModelBinding } from '../chatSurface/ChatTranscript';
import { toDisplayMessage } from '../chatSurface/guiMessageView';

const readOnlyBinding: TranscriptModelBinding<GuiChatMessage> = {
  toDisplay(message) {
    const display = toDisplayMessage(message);
    // Archived UI widgets can contain write actions. Render the historical transcript without them.
    delete display.displayItems;
    return display;
  },
  messagesEqual: guiChatMessageEqual,
  waitStateOf: () => null
};

export default function ArchivedGuiTranscript({ session, history, onLoadEarlier }: {
  session: SessionMeta; history: GuiWorkerHistoryPage; onLoadEarlier: () => void;
}) {
  return <ChatTranscript sessionId={session.id} workspaceId={session.workspaceId} cwd={session.cwd}
    model={readOnlyBinding} messages={history.messages} busy={false} hasEarlier={history.hasEarlier}
    onLoadEarlier={onLoadEarlier} className="archived-gui-transcript" />;
}
