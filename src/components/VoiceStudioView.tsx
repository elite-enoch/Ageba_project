import React from "react";
import { Volume2, Check, Loader2 } from "lucide-react";
import {
  ASSISTANT_PRESETS,
  RecognitionEngine,
  VOICE_OPTIONS,
  VoiceName,
} from "../types/voice";

interface VoiceStudioViewProps {
  selectedVoice: VoiceName;
  onSelectVoice: (voice: VoiceName) => void;
  previewingVoice: VoiceName | null;
  onPreviewVoice: (voice: VoiceName) => void;
  selectedPresetId: string;
  onSelectPreset: (presetId: string) => void;
  customSystemInstruction: string;
  onChangeSystemInstruction: (value: string) => void;
  autoSpeakReplies: boolean;
  onToggleAutoSpeak: (val: boolean) => void;
  recognitionEngine: RecognitionEngine;
  onChangeRecognitionEngine: (engine: RecognitionEngine) => void;
}

export const VoiceStudioView: React.FC<VoiceStudioViewProps> = ({
  selectedVoice,
  onSelectVoice,
  previewingVoice,
  onPreviewVoice,
  selectedPresetId,
  onSelectPreset,
  customSystemInstruction,
  onChangeSystemInstruction,
  autoSpeakReplies,
  onToggleAutoSpeak,
  recognitionEngine,
  onChangeRecognitionEngine,
}) => {
  return (
    <div className="max-w-5xl mx-auto w-full px-6 py-8 space-y-10 overflow-y-auto">
      {/* Page Header */}
      <div className="border-b border-slate-200 pb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Voice Studio
        </h1>
        <p className="mt-1.5 text-sm text-slate-600 max-w-2xl">
          Configure the assistant voice timbre, conversational persona, and
          speech recognition pipeline used across live and turn-based sessions.
        </p>
      </div>

      {/* Section 1: Voice Profiles */}
      <section className="space-y-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Voice Selection
          </h2>
          <p className="text-sm text-slate-500">
            Select a synthesized voice profile or preview a spoken sample.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {VOICE_OPTIONS.map((voice) => {
            const isSelected = selectedVoice === voice.id;
            const isPreviewing = previewingVoice === voice.id;

            return (
              <div
                key={voice.id}
                className={`p-4 rounded-xl border transition-colors flex flex-col justify-between gap-4 ${
                  isSelected
                    ? "bg-white border-blue-600 ring-1 ring-blue-600"
                    : "bg-white border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-display font-semibold text-slate-900">
                      {voice.label}
                    </span>
                    {isSelected && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-600">
                        <Check className="w-3.5 h-3.5" />
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-600">{voice.tone}</p>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-slate-100 gap-2">
                  <button
                    type="button"
                    onClick={() => onSelectVoice(voice.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      isSelected
                        ? "bg-blue-600 text-white"
                        : "bg-slate-100 text-slate-800 hover:bg-slate-200"
                    }`}
                  >
                    {isSelected ? "Selected" : "Use Voice"}
                  </button>

                  <button
                    type="button"
                    onClick={() => onPreviewVoice(voice.id)}
                    disabled={isPreviewing}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
                  >
                    {isPreviewing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5" />
                    )}
                    <span>{isPreviewing ? "Synthesizing" : "Preview"}</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Section 2: Conversational Persona */}
      <section className="space-y-4 pt-6 border-t border-slate-200">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Conversational Persona
          </h2>
          <p className="text-sm text-slate-500">
            Choose a response style or edit the underlying system instructions.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ASSISTANT_PRESETS.map((preset) => {
            const active = selectedPresetId === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                onClick={() => onSelectPreset(preset.id)}
                className={`text-left p-4 rounded-xl border transition-colors cursor-pointer ${
                  active
                    ? "bg-white border-blue-600 ring-1 ring-blue-600"
                    : "bg-white border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-display font-semibold text-sm text-slate-900">
                    {preset.name}
                  </span>
                  {active && (
                    <span className="text-xs font-medium text-blue-600">
                      Active
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-slate-600">{preset.summary}</p>
              </button>
            );
          })}
        </div>

        <div className="pt-2">
          <label
            htmlFor="system-instruction-input"
            className="block text-sm font-medium text-slate-800 mb-2"
          >
            System Instructions
          </label>
          <textarea
            id="system-instruction-input"
            rows={4}
            value={customSystemInstruction}
            onChange={(e) => onChangeSystemInstruction(e.target.value)}
            placeholder="Describe how elite should listen, reason, and respond..."
            className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
          />
        </div>
      </section>

      {/* Section 3: Speech Recognition & Playback */}
      <section className="space-y-4 pt-6 border-t border-slate-200 pb-8">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Speech Recognition and Playback
          </h2>
          <p className="text-sm text-slate-500">
            Control how spoken input is transcribed and when audio replies play
            automatically.
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-200">
          <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-900">
                Auto-speak responses in text & dictation mode
              </p>
              <p className="text-sm text-slate-500">
                Automatically synthesize and play audio with waveform
                visualization after each turn.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={autoSpeakReplies}
              onClick={() => onToggleAutoSpeak(!autoSpeakReplies)}
              className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                autoSpeakReplies
                  ? "bg-blue-600 text-white"
                  : "bg-slate-100 text-slate-700 hover:bg-slate-200"
              }`}
            >
              {autoSpeakReplies ? "Enabled" : "Disabled"}
            </button>
          </div>

          <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-slate-900">
                Dictation speech recognition engine
              </p>
              <p className="text-sm text-slate-500">
                Choose between Gemini audio transcription, live browser Speech
                Recognition, or automatic hybrid mode.
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0">
              {(
                [
                  { id: "auto", label: "Hybrid Auto" },
                  { id: "gemini", label: "Gemini Transcribe" },
                  { id: "browser", label: "Browser Live" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onChangeRecognitionEngine(opt.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    recognitionEngine === opt.id
                      ? "bg-white text-slate-900 shadow-sm"
                      : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
};
