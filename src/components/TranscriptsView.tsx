import React, { useMemo, useState } from "react";
import { Download, Search, Trash2, ArrowUpRight } from "lucide-react";
import { ConversationSession } from "../types/voice";
import { formatRelativeDate, formatTime } from "../lib/audioUtils";

interface TranscriptsViewProps {
  sessions: ConversationSession[];
  activeSessionId: string;
  onOpenSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onNewSession: () => void;
}

export const TranscriptsView: React.FC<TranscriptsViewProps> = ({
  sessions,
  activeSessionId,
  onOpenSession,
  onDeleteSession,
  onNewSession,
}) => {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.text.toLowerCase().includes(q))
    );
  }, [sessions, query]);

  const exportMarkdown = (session: ConversationSession) => {
    const lines = [
      `# ${session.title}`,
      `Voice: ${session.voiceName} · Updated: ${new Date(session.updatedAt).toLocaleString()}`,
      "",
      ...session.messages.map((m) => {
        const speaker = m.role === "user" ? "You" : "elite";
        return `**${speaker}** (${formatTime(m.timestamp)}):\n${m.text}\n`;
      }),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${session.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "transcript"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-5xl mx-auto w-full px-6 py-8 space-y-6 overflow-y-auto">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Saved Transcripts
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Review past spoken and text conversations, reopen a session, or
            export a transcript.
          </p>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transcripts..."
            className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
          <p className="text-sm font-medium text-slate-900">
            {query
              ? "No conversations match your search."
              : "No conversation transcripts yet."}
          </p>
          <p className="text-sm text-slate-500">
            Start a voice or text session to record your first dialogue.
          </p>
          {!query && (
            <button
              type="button"
              onClick={onNewSession}
              className="mt-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
            >
              Start Conversation
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-xs font-medium text-slate-500 bg-slate-50/70">
                <th className="py-3 px-4">Conversation</th>
                <th className="py-3 px-4 hidden sm:table-cell">Voice</th>
                <th className="py-3 px-4 text-right">Turns</th>
                <th className="py-3 px-4 text-right hidden md:table-cell">
                  Updated
                </th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-sm">
              {filtered.map((session) => {
                const isCurrent = session.id === activeSessionId;
                const previewText =
                  session.messages[session.messages.length - 1]?.text ||
                  "Empty session";

                return (
                  <tr
                    key={session.id}
                    className="hover:bg-slate-50/80 transition-colors"
                  >
                    <td className="py-3.5 px-4 max-w-md">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-900 truncate">
                          {session.title}
                        </span>
                        {isCurrent && (
                          <span className="text-xs font-medium text-blue-600 shrink-0">
                            · Current
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 truncate mt-0.5">
                        {previewText}
                      </p>
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 hidden sm:table-cell whitespace-nowrap">
                      {session.voiceName}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-700 whitespace-nowrap">
                      {session.messages.length}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono tabular-nums text-slate-500 hidden md:table-cell whitespace-nowrap">
                      {formatRelativeDate(session.updatedAt)} ·{" "}
                      {formatTime(session.updatedAt)}
                    </td>
                    <td className="py-3.5 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => onOpenSession(session.id)}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                        >
                          <span>Open</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => exportMarkdown(session)}
                          aria-label={`Export ${session.title} as Markdown`}
                          className="p-1.5 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDeleteSession(session.id)}
                          aria-label={`Delete ${session.title}`}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
