import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  Check,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Plus,
  Radio,
  Search,
  Send,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  AlertCircle,
  X,
} from "lucide-react";
import {
  ASSISTANT_PRESETS,
  AudioState,
  ConversationMessage,
  ConversationSession,
  RecognitionEngine,
  VOICE_OPTIONS,
  VoiceName,
} from "./types/voice";
import { PlaybackProgress, VoiceAudioEngine } from "./lib/audioEngine";
import {
  estimateWavDurationSec,
  formatDuration,
  formatRelativeDate,
  formatTime,
  pcm16Base64ChunksToWavBase64,
} from "./lib/audioUtils";
import { WaveformVisualizer } from "./components/WaveformVisualizer";
import { VoiceStudioView } from "./components/VoiceStudioView";
import { TranscriptsView } from "./components/TranscriptsView";

type AppTab = "conversation" | "studio" | "transcripts";

const STORAGE_KEY = "sonance_sessions_v1";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

function createNewSession(
  voiceName: VoiceName = "Zephyr",
  presetId = "conversational"
): ConversationSession {
  const preset =
    ASSISTANT_PRESETS.find((p) => p.id === presetId) ?? ASSISTANT_PRESETS[0];
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "New Conversation",
    createdAt: now,
    updatedAt: now,
    voiceName,
    presetId: preset.id,
    customSystemInstruction: preset.systemInstruction,
    messages: [],
  };
}

function loadInitialSessions(): ConversationSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ConversationSession[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {
    // ignore storage errors
  }
  return [createNewSession()];
}

export default function App() {
  const engineRef = useRef<VoiceAudioEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new VoiceAudioEngine();
  }
  const engine = engineRef.current;

  const [activeTab, setActiveTab] = useState<AppTab>("conversation");
  const [sessions, setSessions] = useState<ConversationSession[]>(
    loadInitialSessions
  );
  const [activeSessionId, setActiveSessionId] = useState<string>(
    () => sessions[0]?.id || ""
  );
  const [sidebarQuery, setSidebarQuery] = useState("");

  // Audio & voice state
  const [audioState, setAudioState] = useState<AudioState>("idle");
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [autoSpeakReplies, setAutoSpeakReplies] = useState(true);
  const [recognitionEngine, setRecognitionEngine] =
    useState<RecognitionEngine>("auto");
  const [liveTranscript, setLiveTranscript] = useState("");
  const [textInput, setTextInput] = useState("");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [ttsQuotaExhausted, setTtsQuotaExhausted] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [synthesizingMsgId, setSynthesizingMsgId] = useState<string | null>(
    null
  );
  const [previewingVoice, setPreviewingVoice] = useState<VoiceName | null>(
    null
  );
  const [playback, setPlayback] = useState<PlaybackProgress>({
    messageId: null,
    currentTime: 0,
    duration: 0,
    isPlaying: false,
  });

  // Live session refs (avoid stale closures in WS / audio callbacks)
  const wsRef = useRef<WebSocket | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;

  const ttsCacheRef = useRef<Map<string, string>>(new Map());
  const liveUserTurnIdRef = useRef<string | null>(null);
  const liveAssistantTurnIdRef = useRef<string | null>(null);
  const liveUserTextRef = useRef<string>("");
  const liveAssistantTextRef = useRef<string>("");
  const livePcmChunksRef = useRef<string[]>([]);
  const speechRecRef = useRef<SpeechRecognitionLike | null>(null);
  const browserTranscriptRef = useRef<string>("");
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  const activeSession = useMemo(
    () =>
      sessions.find((s) => s.id === activeSessionId) ??
      sessions[0] ??
      createNewSession(),
    [sessions, activeSessionId]
  );

  // Persist sessions without large base64 audio blobs to stay safely within localStorage quota
  useEffect(() => {
    try {
      const stripped = sessions.map((s) => ({
        ...s,
        messages: s.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          timestamp: m.timestamp,
          inputMode: m.inputMode,
          voiceName: m.voiceName,
          durationSec: m.durationSec,
        })),
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
    } catch {
      // ignore storage quota exceeded
    }
  }, [sessions]);

  // Auto-scroll transcript as messages stream
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeSession.messages.length, activeSession.messages[activeSession.messages.length - 1]?.text]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (speechRecRef.current) {
        try {
          speechRecRef.current.abort();
        } catch {
          // ignore
        }
      }
      void engine.stopMicStreaming();
      engine.stopLivePlayback();
      engine.stopWav();
    };
  }, [engine]);

  const updateSession = useCallback(
    (
      sessionId: string,
      updater: (prev: ConversationSession) => ConversationSession
    ) => {
      setSessions((prevList) =>
        prevList.map((s) => (s.id === sessionId ? updater(s) : s))
      );
    },
    []
  );

  const upsertMessage = useCallback(
    (sessionId: string, message: ConversationMessage) => {
      updateSession(sessionId, (s) => {
        const exists = s.messages.some((m) => m.id === message.id);
        const nextMessages = exists
          ? s.messages.map((m) => (m.id === message.id ? message : m))
          : [...s.messages, message];

        const firstUserMsg = nextMessages.find(
          (m) => m.role === "user" && m.text.trim()
        );
        const nextTitle =
          s.title === "New Conversation" && firstUserMsg
            ? firstUserMsg.text.trim().slice(0, 46) +
              (firstUserMsg.text.trim().length > 46 ? "..." : "")
            : s.title;

        return {
          ...s,
          title: nextTitle,
          updatedAt: Date.now(),
          messages: nextMessages,
        };
      });
    },
    [updateSession]
  );

  const fetchTtsAudio = useCallback(
    async (
      text: string,
      voiceName: VoiceName,
      style?: string
    ): Promise<{ audioBase64?: string; quotaExceeded?: boolean }> => {
      const cleanText = text.trim();
      const cacheKey = `${voiceName}::${style || ""}::${cleanText}`;
      const cached = ttsCacheRef.current.get(cacheKey);
      if (cached) {
        return { audioBase64: cached };
      }

      if (ttsQuotaExhausted) {
        return { quotaExceeded: true };
      }

      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: cleanText,
          voiceName,
          style,
        }),
      });
      const data = (await res.json()) as {
        audioBase64?: string;
        code?: string;
        error?: string;
      };

      if (res.status === 429 || data.code === "QUOTA_EXCEEDED") {
        setTtsQuotaExhausted(true);
        return { quotaExceeded: true };
      }

      if (!res.ok || !data.audioBase64) {
        throw new Error(data.error || "Speech synthesis failed.");
      }

      ttsCacheRef.current.set(cacheKey, data.audioBase64);
      return { audioBase64: data.audioBase64 };
    },
    [ttsQuotaExhausted]
  );

  const handlePlayMessageAudio = useCallback(
    async (msg: ConversationMessage) => {
      setErrorBanner(null);

      // Toggle pause/resume if this exact message is loaded
      if (playback.messageId === msg.id) {
        if (playback.isPlaying) {
          engine.pauseWav();
        } else {
          engine.resumeWav();
        }
        return;
      }

      if (msg.audioBase64) {
        try {
          await engine.playWav(msg.audioBase64, msg.id, setPlayback);
        } catch (err) {
          setErrorBanner(
            err instanceof Error ? err.message : "Unable to play audio clip."
          );
        }
        return;
      }

      // On-demand TTS synthesis for text or reloaded messages
      try {
        setSynthesizingMsgId(msg.id);
        const preset = ASSISTANT_PRESETS.find(
          (p) => p.id === activeSession.presetId
        );
        const result = await fetchTtsAudio(
          msg.text,
          msg.voiceName || activeSession.voiceName,
          preset?.ttsStyle
        );

        if (result.quotaExceeded) {
          const ok = engine.speakBrowserFallback(msg.text, msg.id, setPlayback);
          if (!ok) {
            setErrorBanner(
              "Gemini TTS daily quota reached (10/day) and browser speech is unavailable."
            );
          }
          return;
        }

        if (result.audioBase64) {
          const durationSec = estimateWavDurationSec(result.audioBase64);
          updateSession(activeSession.id, (s) => ({
            ...s,
            messages: s.messages.map((m) =>
              m.id === msg.id
                ? {
                    ...m,
                    audioBase64: result.audioBase64,
                    audioMimeType: "audio/wav",
                    durationSec,
                  }
                : m
            ),
          }));
          await engine.playWav(result.audioBase64, msg.id, setPlayback);
        }
      } catch (err) {
        setErrorBanner(
          err instanceof Error ? err.message : "Speech synthesis failed."
        );
      } finally {
        setSynthesizingMsgId(null);
      }
    },
    [
      activeSession,
      engine,
      fetchTtsAudio,
      playback.isPlaying,
      playback.messageId,
      updateSession,
    ]
  );

  // Send a user turn via streaming NLP (/api/chat/stream) + optional TTS (/api/tts)
  const sendTurnBasedMessage = useCallback(
    async (rawText: string, inputMode: "voice" | "text") => {
      const text = rawText.trim();
      if (!text) return;

      const sessionId = activeSession.id;
      const history = activeSession.messages.map((m) => ({
        role: m.role === "user" ? ("user" as const) : ("model" as const),
        text: m.text,
      }));

      const userMsg: ConversationMessage = {
        id: crypto.randomUUID(),
        role: "user",
        text,
        timestamp: Date.now(),
        inputMode,
      };
      upsertMessage(sessionId, userMsg);

      const assistantMsgId = crypto.randomUUID();
      let accumulatedText = "";
      const voiceName = activeSession.voiceName;

      setAudioState("processing");
      setErrorBanner(null);

      try {
        const res = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            history,
            message: text,
            systemInstruction: activeSession.customSystemInstruction,
          }),
        });

        if (!res.ok || !res.body) {
          throw new Error("Failed to connect to language stream.");
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            const payload = JSON.parse(jsonStr) as {
              chunk?: string;
              done?: boolean;
              error?: string;
            };
            if (payload.error) {
              throw new Error(payload.error);
            }
            if (payload.chunk) {
              accumulatedText += payload.chunk;
              upsertMessage(sessionId, {
                id: assistantMsgId,
                role: "assistant",
                text: accumulatedText,
                timestamp: Date.now(),
                inputMode: "text",
                voiceName,
              });
            }
          }
        }

        if (autoSpeakReplies && accumulatedText.trim()) {
          const preset = ASSISTANT_PRESETS.find(
            (p) => p.id === activeSession.presetId
          );
          const result = await fetchTtsAudio(
            accumulatedText,
            voiceName,
            preset?.ttsStyle
          );

          if (result.quotaExceeded) {
            setAudioState("idle");
            engine.speakBrowserFallback(
              accumulatedText,
              assistantMsgId,
              setPlayback
            );
            return;
          }

          if (result.audioBase64) {
            const durationSec = estimateWavDurationSec(result.audioBase64);
            upsertMessage(sessionId, {
              id: assistantMsgId,
              role: "assistant",
              text: accumulatedText,
              timestamp: Date.now(),
              inputMode: "voice",
              voiceName,
              audioBase64: result.audioBase64,
              audioMimeType: "audio/wav",
              durationSec,
            });
            setAudioState("idle");
            await engine.playWav(result.audioBase64, assistantMsgId, setPlayback);
            return;
          }
        }
      } catch (err) {
        setErrorBanner(
          err instanceof Error ? err.message : "Conversation turn failed."
        );
      } finally {
        setAudioState((prev) => (prev === "processing" ? "idle" : prev));
      }
    },
    [activeSession, autoSpeakReplies, engine, fetchTtsAudio, upsertMessage]
  );

  // Stop Live Duplex Session
  const stopLiveSession = useCallback(async () => {
    if (wsRef.current) {
      try {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: "stop" }));
        }
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
    await engine.stopMicStreaming();
    engine.stopLivePlayback();
    setIsLiveActive(false);
    setIsMuted(false);
    engine.setMuted(false);
    setLiveTranscript("");
    setAudioState("idle");

    liveUserTurnIdRef.current = null;
    liveAssistantTurnIdRef.current = null;
    liveUserTextRef.current = "";
    liveAssistantTextRef.current = "";
    livePcmChunksRef.current = [];
  }, [engine]);

  // Start Live Duplex Voice Conversation (Gemini Live API over WebSocket)
  const startLiveSession = useCallback(async () => {
    setErrorBanner(null);
    engine.stopWav();

    if (isDictating) {
      return;
    }

    setAudioState("connecting");
    setLiveTranscript("");
    liveUserTurnIdRef.current = null;
    liveAssistantTurnIdRef.current = null;
    liveUserTextRef.current = "";
    liveAssistantTextRef.current = "";
    livePcmChunksRef.current = [];

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/live`);
    wsRef.current = ws;

    ws.onopen = async () => {
      try {
        ws.send(
          JSON.stringify({
            type: "start",
            voiceName: activeSession.voiceName,
            systemInstruction: activeSession.customSystemInstruction,
          })
        );
        await engine.startMicStreaming((b64) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "audio", data: b64 }));
          }
        });
        setIsLiveActive(true);
      } catch (err) {
        setErrorBanner(
          err instanceof Error
            ? `Microphone access failed: ${err.message}`
            : "Microphone access was denied."
        );
        await stopLiveSession();
      }
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as {
        type: string;
        text?: string;
        data?: string;
        message?: string;
      };

      const sessionId = activeSessionIdRef.current;

      if (msg.type === "ready") {
        setAudioState("listening");
      } else if (msg.type === "interimInputTranscript" && msg.text) {
        setLiveTranscript(msg.text);
      } else if (msg.type === "inputTranscript" && msg.text) {
        if (!liveUserTurnIdRef.current) {
          liveUserTurnIdRef.current = crypto.randomUUID();
          liveUserTextRef.current = "";
        }
        liveUserTextRef.current = (
          liveUserTextRef.current +
          " " +
          msg.text
        ).trim();
        setLiveTranscript(liveUserTextRef.current);
        upsertMessage(sessionId, {
          id: liveUserTurnIdRef.current,
          role: "user",
          text: liveUserTextRef.current,
          timestamp: Date.now(),
          inputMode: "voice",
        });
      } else if (msg.type === "outputTranscript" && msg.text) {
        if (!liveAssistantTurnIdRef.current) {
          liveAssistantTurnIdRef.current = crypto.randomUUID();
          liveAssistantTextRef.current = "";
        }
        liveAssistantTextRef.current += msg.text;
        upsertMessage(sessionId, {
          id: liveAssistantTurnIdRef.current,
          role: "assistant",
          text: liveAssistantTextRef.current,
          timestamp: Date.now(),
          inputMode: "voice",
          voiceName: activeSession.voiceName,
        });
      } else if (msg.type === "audio" && msg.data) {
        livePcmChunksRef.current.push(msg.data);
        engine.playLivePcmChunk(msg.data, (playing) => {
          setAudioState(playing ? "speaking" : "listening");
        });
      } else if (msg.type === "interrupted") {
        engine.stopLivePlayback();
        livePcmChunksRef.current = [];
        liveAssistantTurnIdRef.current = null;
        liveAssistantTextRef.current = "";
        setAudioState("listening");
      } else if (msg.type === "turnComplete") {
        // Wrap collected 24kHz PCM chunks into WAV so the turn is replayable
        if (
          liveAssistantTurnIdRef.current &&
          livePcmChunksRef.current.length > 0
        ) {
          const wavB64 = pcm16Base64ChunksToWavBase64(
            livePcmChunksRef.current,
            24000
          );
          const dur = estimateWavDurationSec(wavB64, 24000);
          const turnId = liveAssistantTurnIdRef.current;
          const finalText = liveAssistantTextRef.current;
          upsertMessage(sessionId, {
            id: turnId,
            role: "assistant",
            text: finalText || "(Spoken audio response)",
            timestamp: Date.now(),
            inputMode: "voice",
            voiceName: activeSession.voiceName,
            audioBase64: wavB64,
            audioMimeType: "audio/wav",
            durationSec: dur,
          });
        }
        liveUserTurnIdRef.current = null;
        liveAssistantTurnIdRef.current = null;
        liveUserTextRef.current = "";
        liveAssistantTextRef.current = "";
        livePcmChunksRef.current = [];
        setLiveTranscript("");
        if (!engine.isLiveAudioPlaying()) {
          setAudioState("listening");
        }
      } else if (msg.type === "error") {
        setErrorBanner(msg.message || "Live voice connection encountered an error.");
        void stopLiveSession();
      } else if (msg.type === "closed") {
        void stopLiveSession();
      }
    };

    ws.onerror = () => {
      setErrorBanner("WebSocket connection to voice server failed.");
      void stopLiveSession();
    };
  }, [
    activeSession.customSystemInstruction,
    activeSession.voiceName,
    engine,
    isDictating,
    stopLiveSession,
    upsertMessage,
  ]);

  // Toggle Dictation (Push-to-Talk Speech Recognition -> NLP -> TTS)
  const handleToggleDictation = useCallback(async () => {
    if (isLiveActive) return;
    setErrorBanner(null);

    if (!isDictating) {
      engine.stopWav();
      browserTranscriptRef.current = "";
      setLiveTranscript("");

      try {
        await engine.startClipRecording();
        setIsDictating(true);
        setAudioState("listening");

        const RecCtor = getSpeechRecognitionCtor();
        if (RecCtor && recognitionEngine !== "gemini") {
          const rec = new RecCtor();
          rec.continuous = true;
          rec.interimResults = true;
          rec.lang = "en-US";
          rec.onresult = (ev) => {
            let finalText = "";
            let interimText = "";
            for (let i = 0; i < ev.results.length; i++) {
              const res = ev.results[i];
              if (res.isFinal) {
                finalText += res[0].transcript + " ";
              } else {
                interimText += res[0].transcript;
              }
            }
            const combined = (finalText + interimText).trim();
            browserTranscriptRef.current = combined;
            setLiveTranscript(combined);
          };
          rec.onerror = () => {
            // Silently fall back to Gemini audio transcription on stop
          };
          rec.start();
          speechRecRef.current = rec;
        }
      } catch (err) {
        setErrorBanner(
          err instanceof Error
            ? `Microphone access failed: ${err.message}`
            : "Microphone permission is required for speech recognition."
        );
        setAudioState("idle");
      }
    } else {
      setIsDictating(false);
      setAudioState("processing");

      if (speechRecRef.current) {
        try {
          speechRecRef.current.stop();
        } catch {
          // ignore
        }
        speechRecRef.current = null;
      }

      const clip = await engine.stopClipRecording();
      let recognized = browserTranscriptRef.current.trim();

      // Use Gemini 3.5 Transcribe when requested or when browser speech rec has no text
      if (
        clip &&
        (recognitionEngine === "gemini" ||
          (recognitionEngine === "auto" && !recognized))
      ) {
        try {
          const res = await fetch("/api/transcribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              audioBase64: clip.audioBase64,
              mimeType: clip.mimeType,
            }),
          });
          const data = (await res.json()) as {
            transcript?: string;
            error?: string;
          };
          if (!res.ok) {
            throw new Error(data.error || "Audio transcription failed.");
          }
          if (data.transcript) {
            recognized = data.transcript.trim();
          }
        } catch (err) {
          setErrorBanner(
            err instanceof Error ? err.message : "Audio transcription failed."
          );
          setAudioState("idle");
          setLiveTranscript("");
          return;
        }
      }

      setLiveTranscript("");

      if (!recognized) {
        setAudioState("idle");
        setErrorBanner("No speech detected. Please speak clearly and try again.");
        return;
      }

      await sendTurnBasedMessage(recognized, "voice");
    }
  }, [
    engine,
    isDictating,
    isLiveActive,
    recognitionEngine,
    sendTurnBasedMessage,
  ]);

  const handleSendText = useCallback(
    async (e?: React.FormEvent) => {
      if (e) e.preventDefault();
      const text = textInput.trim();
      if (!text) return;
      setTextInput("");

      if (isLiveActive && wsRef.current?.readyState === WebSocket.OPEN) {
        upsertMessage(activeSession.id, {
          id: crypto.randomUUID(),
          role: "user",
          text,
          timestamp: Date.now(),
          inputMode: "text",
        });
        wsRef.current.send(JSON.stringify({ type: "text", text }));
        return;
      }

      await sendTurnBasedMessage(text, "text");
    },
    [
      activeSession.id,
      isLiveActive,
      sendTurnBasedMessage,
      textInput,
      upsertMessage,
    ]
  );

  const handleToggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    engine.setMuted(next);
  };

  const handleNewSession = () => {
    if (isLiveActive) {
      void stopLiveSession();
    }
    engine.stopWav();
    const fresh = createNewSession(
      activeSession.voiceName,
      activeSession.presetId
    );
    setSessions((prev) => [fresh, ...prev]);
    setActiveSessionId(fresh.id);
    setActiveTab("conversation");
  };

  const handleDeleteSession = (id: string) => {
    if (id === activeSession.id && isLiveActive) {
      void stopLiveSession();
    }
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      if (remaining.length === 0) {
        const fresh = createNewSession();
        setActiveSessionId(fresh.id);
        return [fresh];
      }
      if (id === activeSessionId) {
        setActiveSessionId(remaining[0].id);
      }
      return remaining;
    });
  };

  const handlePreviewVoice = async (voice: VoiceName) => {
    const opt = VOICE_OPTIONS.find((v) => v.id === voice);
    if (!opt) return;
    setPreviewingVoice(voice);
    setErrorBanner(null);

    try {
      const result = await fetchTtsAudio(opt.sampleLine, voice);
      if (result.quotaExceeded) {
        engine.speakBrowserFallback(
          opt.sampleLine,
          `preview-${voice}`,
          setPlayback
        );
        return;
      }
      if (result.audioBase64) {
        await engine.playWav(
          result.audioBase64,
          `preview-${voice}`,
          setPlayback
        );
      }
    } catch (err) {
      setErrorBanner(
        err instanceof Error ? err.message : "Unable to preview voice."
      );
    } finally {
      setPreviewingVoice(null);
    }
  };

  const handleCopyText = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 1500);
  };

  const sidebarSessions = useMemo(() => {
    const q = sidebarQuery.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, sidebarQuery]);

  const lastAssistantWithAudio = useMemo(() => {
    for (let i = activeSession.messages.length - 1; i >= 0; i--) {
      if (activeSession.messages[i].role === "assistant") {
        return activeSession.messages[i];
      }
    }
    return null;
  }, [activeSession.messages]);

  return (
    <div className="min-h-screen h-screen flex flex-col bg-[#F6F7F9] text-slate-900 overflow-hidden">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-8 shrink-0">
        {/* Zone 1: Single-element brand wordmark */}
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab("conversation");
          }}
          className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
        >
          elite
        </a>

        {/* Zone 2: Concise single-line navigation links */}
        <nav
          aria-label="Primary"
          className="flex items-center gap-6 h-full text-sm font-medium"
        >
          {(
            [
              { id: "conversation", label: "Conversation" },
              { id: "studio", label: "Voice Studio" },
              { id: "transcripts", label: "Transcripts" },
            ] as const
          ).map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`h-full inline-flex items-center border-b-2 transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                  isActive
                    ? "border-blue-600 text-slate-900"
                    : "border-transparent text-slate-500 hover:text-slate-900"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="shrink-0">
          <button
            type="button"
            onClick={handleNewSession}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Session</span>
          </button>
        </div>
      </header>

      {/* Gemini TTS Free-Tier Quota Notice */}
      {ttsQuotaExhausted && (
        <div
          role="status"
          className="bg-amber-50 border-b border-amber-200 px-6 py-2 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900 shrink-0"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span>
              Gemini TTS free-tier daily quota reached (10 requests/day) — using
              browser speech for text playback. Use{" "}
              <strong>Start Live Voice</strong> or select a billing-enabled API
              key in <strong>Settings &gt; Secrets</strong> for higher limits.
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setTtsQuotaExhausted(false)}
              className="px-2.5 py-1 font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 rounded transition-colors cursor-pointer whitespace-nowrap"
            >
              Retry Gemini TTS
            </button>
            <button
              type="button"
              onClick={() => setTtsQuotaExhausted(false)}
              aria-label="Dismiss notice"
              className="p-1 text-amber-700 hover:text-amber-900 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Non-blocking Error Banner */}
      {errorBanner && (
        <div
          role="alert"
          className="bg-red-50 border-b border-red-200 px-6 py-2.5 flex items-center justify-between gap-4 text-sm text-red-800 shrink-0"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
            <span>{errorBanner}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            aria-label="Dismiss error"
            className="p-1 text-red-600 hover:text-red-800 rounded cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Main Content Area */}
      {activeTab === "studio" ? (
        <main className="flex-1 overflow-y-auto">
          <VoiceStudioView
            selectedVoice={activeSession.voiceName}
            onSelectVoice={(voice) =>
              updateSession(activeSession.id, (s) => ({
                ...s,
                voiceName: voice,
              }))
            }
            previewingVoice={previewingVoice}
            onPreviewVoice={handlePreviewVoice}
            selectedPresetId={activeSession.presetId}
            onSelectPreset={(presetId) => {
              const found = ASSISTANT_PRESETS.find((p) => p.id === presetId);
              if (!found) return;
              updateSession(activeSession.id, (s) => ({
                ...s,
                presetId: found.id,
                customSystemInstruction: found.systemInstruction,
              }));
            }}
            customSystemInstruction={activeSession.customSystemInstruction}
            onChangeSystemInstruction={(val) =>
              updateSession(activeSession.id, (s) => ({
                ...s,
                customSystemInstruction: val,
              }))
            }
            autoSpeakReplies={autoSpeakReplies}
            onToggleAutoSpeak={setAutoSpeakReplies}
            recognitionEngine={recognitionEngine}
            onChangeRecognitionEngine={setRecognitionEngine}
          />
        </main>
      ) : activeTab === "transcripts" ? (
        <main className="flex-1 overflow-y-auto">
          <TranscriptsView
            sessions={sessions}
            activeSessionId={activeSession.id}
            onOpenSession={(id) => {
              setActiveSessionId(id);
              setActiveTab("conversation");
            }}
            onDeleteSession={handleDeleteSession}
            onNewSession={handleNewSession}
          />
        </main>
      ) : (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left Workspace Sidebar (260px) */}
          <aside className="w-[268px] shrink-0 hidden lg:flex flex-col bg-white border-r border-slate-200">
            <div className="p-4 border-b border-slate-200">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={sidebarQuery}
                  onChange={(e) => setSidebarQuery(e.target.value)}
                  placeholder="Filter sessions..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-blue-600"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
              {sidebarSessions.map((session) => {
                const isSelected = session.id === activeSession.id;
                return (
                  <div
                    key={session.id}
                    className={`group flex items-center justify-between gap-2 px-4 py-3 transition-colors ${
                      isSelected ? "bg-slate-100/90" : "hover:bg-slate-50"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveSessionId(session.id)}
                      className="flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <p
                        className={`text-sm truncate ${
                          isSelected
                            ? "font-semibold text-slate-900"
                            : "font-medium text-slate-700"
                        }`}
                      >
                        {session.title}
                      </p>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500">
                        <span className="font-mono tabular-nums">
                          {session.messages.length} turns
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatRelativeDate(session.updatedAt)}</span>
                      </div>
                    </button>
                    {sessions.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleDeleteSession(session.id)}
                        aria-label={`Delete ${session.title}`}
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-600 rounded transition-opacity cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Quick Voice & Persona Selector */}
            <div className="p-4 border-t border-slate-200 space-y-3 bg-slate-50/60">
              <div>
                <label
                  htmlFor="sidebar-voice-select"
                  className="block text-xs font-medium text-slate-500 mb-1"
                >
                  Assistant Voice
                </label>
                <select
                  id="sidebar-voice-select"
                  value={activeSession.voiceName}
                  disabled={isLiveActive}
                  onChange={(e) =>
                    updateSession(activeSession.id, (s) => ({
                      ...s,
                      voiceName: e.target.value as VoiceName,
                    }))
                  }
                  className="w-full px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:border-blue-600 disabled:opacity-60"
                >
                  {VOICE_OPTIONS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} — {v.tone.split(",")[0]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="sidebar-preset-select"
                  className="block text-xs font-medium text-slate-500 mb-1"
                >
                  Conversation Mode
                </label>
                <select
                  id="sidebar-preset-select"
                  value={activeSession.presetId}
                  disabled={isLiveActive}
                  onChange={(e) => {
                    const found = ASSISTANT_PRESETS.find(
                      (p) => p.id === e.target.value
                    );
                    if (!found) return;
                    updateSession(activeSession.id, (s) => ({
                      ...s,
                      presetId: found.id,
                      customSystemInstruction: found.systemInstruction,
                    }));
                  }}
                  className="w-full px-2.5 py-1.5 text-xs font-medium bg-white border border-slate-200 rounded-lg text-slate-800 focus:outline-none focus:border-blue-600 disabled:opacity-60"
                >
                  {ASSISTANT_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </aside>

          {/* Main Conversation Workspace */}
          <main className="flex-1 flex flex-col min-w-0 min-h-0">
            {/* Top Acoustic Stage & Waveform Bay */}
            <div className="bg-white border-b border-slate-200 px-6 py-4 shrink-0">
              <div className="max-w-4xl mx-auto space-y-3">
                <WaveformVisualizer
                  engine={engine}
                  audioState={audioState}
                  playback={playback}
                  liveTranscript={liveTranscript}
                  isMuted={isMuted}
                  onPausePlayback={() => engine.pauseWav()}
                  onResumePlayback={() => engine.resumeWav()}
                  onStopPlayback={() => engine.stopWav()}
                />

                {/* Unified Voice & Playback Control Strip */}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    {!isLiveActive ? (
                      <button
                        type="button"
                        onClick={startLiveSession}
                        disabled={
                          isDictating || audioState === "connecting"
                        }
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
                      >
                        <Radio className="w-3.5 h-3.5" />
                        <span>
                          {audioState === "connecting"
                            ? "Connecting..."
                            : "Start Live Voice"}
                        </span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void stopLiveSession()}
                        className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Square className="w-3.5 h-3.5" />
                        <span>End Live Voice</span>
                      </button>
                    )}

                    {isLiveActive ? (
                      <button
                        type="button"
                        onClick={handleToggleMute}
                        className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                          isMuted
                            ? "bg-amber-50 border-amber-200 text-amber-800"
                            : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        {isMuted ? (
                          <MicOff className="w-3.5 h-3.5" />
                        ) : (
                          <Mic className="w-3.5 h-3.5" />
                        )}
                        <span>{isMuted ? "Unmute Mic" : "Mute Mic"}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleToggleDictation()}
                        disabled={audioState === "processing"}
                        className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 ${
                          isDictating
                            ? "bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700"
                            : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        <Mic className="w-3.5 h-3.5" />
                        <span>
                          {isDictating ? "Finish Dictating" : "Dictate Turn"}
                        </span>
                      </button>
                    )}

                    {lastAssistantWithAudio && !isLiveActive && (
                      <button
                        type="button"
                        onClick={() =>
                          void handlePlayMessageAudio(lastAssistantWithAudio)
                        }
                        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        {playback.messageId === lastAssistantWithAudio.id &&
                        playback.isPlaying ? (
                          <Pause className="w-3.5 h-3.5" />
                        ) : (
                          <Play className="w-3.5 h-3.5" />
                        )}
                        <span>
                          {playback.messageId === lastAssistantWithAudio.id &&
                          playback.isPlaying
                            ? "Pause Reply"
                            : "Replay Last"}
                        </span>
                      </button>
                    )}
                  </div>

                  {/* Unboxed Audio Preferences */}
                  <div className="flex items-center gap-4 text-xs text-slate-500">
                    <span className="hidden sm:inline">
                      Voice: <strong className="font-medium text-slate-700">{activeSession.voiceName}</strong>
                    </span>
                    <button
                      type="button"
                      onClick={() => setAutoSpeakReplies((v) => !v)}
                      className="inline-flex items-center gap-1.5 text-slate-600 hover:text-slate-900 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      {autoSpeakReplies ? (
                        <Volume2 className="w-3.5 h-3.5 text-blue-600" />
                      ) : (
                        <VolumeX className="w-3.5 h-3.5 text-slate-400" />
                      )}
                      <span>
                        {autoSpeakReplies ? "Auto-speak On" : "Auto-speak Off"}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Conversation Transcript Stream */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="max-w-4xl mx-auto">
                {activeSession.messages.length === 0 ? (
                  <div className="py-12 px-6 bg-white border border-slate-200 rounded-xl text-center space-y-4">
                    <h2 className="font-display text-xl font-semibold text-slate-900 text-balance">
                      Start a natural voice or text conversation
                    </h2>
                    <p className="text-sm text-slate-600 max-w-lg mx-auto leading-relaxed">
                      Use <strong>Start Live Voice</strong> for real-time
                      two-way spoken dialogue with interruption support,{" "}
                      <strong>Dictate Turn</strong> for speech-to-text input, or
                      type a prompt below.
                    </p>
                    <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
                      {[
                        "Walk me through the pros and cons of electric vs hybrid cars",
                        "Help me practice answering a product leadership interview question",
                        "Brainstorm three weekend dinner ideas with simple ingredients",
                      ].map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => void sendTurnBasedMessage(suggestion, "text")}
                          className="px-3 py-2 text-xs font-medium text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors cursor-pointer text-left"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200/80 bg-white border border-slate-200 rounded-xl">
                    {activeSession.messages.map((msg) => {
                      const isUser = msg.role === "user";
                      const isThisPlaying =
                        playback.messageId === msg.id && playback.isPlaying;
                      const isThisLoading = synthesizingMsgId === msg.id;

                      return (
                        <article
                          key={msg.id}
                          className="px-5 py-4 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-2 text-xs text-slate-500">
                              <span
                                className={`font-semibold ${
                                  isUser ? "text-slate-900" : "text-blue-700"
                                }`}
                              >
                                {isUser ? "You" : "elite"}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {formatTime(msg.timestamp)}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>
                                {msg.inputMode === "voice"
                                  ? isUser
                                    ? "Speech recognition"
                                    : msg.voiceName || activeSession.voiceName
                                  : "Text"}
                              </span>
                            </div>

                            <div className="flex items-center gap-1.5">
                              {!isUser && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void handlePlayMessageAudio(msg)
                                  }
                                  disabled={isThisLoading}
                                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 ${
                                    isThisPlaying
                                      ? "bg-blue-50 text-blue-700"
                                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                                  }`}
                                >
                                  {isThisLoading ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : isThisPlaying ? (
                                    <Pause className="w-3.5 h-3.5" />
                                  ) : (
                                    <Play className="w-3.5 h-3.5" />
                                  )}
                                  <span>
                                    {isThisLoading
                                      ? "Synthesizing"
                                      : isThisPlaying
                                      ? "Pause"
                                      : "Play Audio"}
                                  </span>
                                  {msg.durationSec && !isThisLoading && (
                                    <span className="font-mono tabular-nums text-slate-400">
                                      {formatDuration(msg.durationSec)}
                                    </span>
                                  )}
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() =>
                                  handleCopyText(msg.id, msg.text)
                                }
                                aria-label="Copy message"
                                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                              >
                                {copiedId === msg.id ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </div>

                          <p className="text-[15px] leading-relaxed text-slate-800 whitespace-pre-wrap max-w-3xl">
                            {msg.text}
                          </p>
                        </article>
                      );
                    })}
                  </div>
                )}
                <div ref={transcriptEndRef} />
              </div>
            </div>

            {/* Bottom Text + Dictate Composer */}
            <div className="bg-white border-t border-slate-200 px-6 py-3.5 shrink-0">
              <form
                onSubmit={(e) => void handleSendText(e)}
                className="max-w-4xl mx-auto flex items-center gap-2.5"
              >
                <input
                  type="text"
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder={
                    isLiveActive
                      ? "Send a typed note into the live voice session..."
                      : "Type a message or use Dictate Turn above..."
                  }
                  className="flex-1 px-4 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-lg text-slate-900 placeholder:text-slate-400 focus:outline-none focus:bg-white focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
                <button
                  type="submit"
                  disabled={!textInput.trim() || audioState === "processing"}
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer disabled:opacity-40 whitespace-nowrap shrink-0"
                >
                  {audioState === "processing" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                  <span>Send</span>
                </button>
              </form>
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
