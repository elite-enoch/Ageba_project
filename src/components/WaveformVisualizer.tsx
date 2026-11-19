import React, { useEffect, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import { AudioState } from "../types/voice";
import { PlaybackProgress, VoiceAudioEngine } from "../lib/audioEngine";
import { formatDuration } from "../lib/audioUtils";

interface WaveformVisualizerProps {
  engine: VoiceAudioEngine;
  audioState: AudioState;
  playback: PlaybackProgress;
  liveTranscript: string;
  isMuted: boolean;
  onPausePlayback: () => void;
  onResumePlayback: () => void;
  onStopPlayback: () => void;
}

const STATE_LABELS: Record<AudioState, string> = {
  idle: "Ready",
  connecting: "Connecting",
  listening: "Listening",
  processing: "Processing",
  speaking: "Speaking",
};

export const WaveformVisualizer: React.FC<WaveformVisualizerProps> = ({
  engine,
  audioState,
  playback,
  liveTranscript,
  isMuted,
  onPausePlayback,
  onResumePlayback,
  onStopPlayback,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [rmsDbDisplay, setRmsDbDisplay] = useState<string>("-60.0 dB");
  const lastDbUpdateRef = useRef<number>(0);

  const effectiveState: AudioState = playback.isPlaying
    ? "speaking"
    : audioState;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    let rafId = 0;
    let phase = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const targetW = Math.max(1, Math.floor(rect.width * dpr));
      const targetH = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
    };

    const draw = (now: number) => {
      resize();
      const w = canvas.width;
      const h = canvas.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const midY = h / 2;

      ctx.clearRect(0, 0, w, h);

      // Subtle precision acoustic grid
      ctx.strokeStyle = "rgba(148, 163, 184, 0.08)";
      ctx.lineWidth = 1;
      const gridRows = [0.25, 0.5, 0.75];
      for (const frac of gridRows) {
        ctx.beginPath();
        ctx.moveTo(0, h * frac);
        ctx.lineTo(w, h * frac);
        ctx.stroke();
      }

      const preferSource =
        effectiveState === "speaking"
          ? "playback"
          : effectiveState === "listening"
          ? "mic"
          : "auto";
      const snap = engine.getSnapshot(preferSource);

      if (now - lastDbUpdateRef.current > 90) {
        lastDbUpdateRef.current = now;
        const db =
          snap.hasSignal || effectiveState === "speaking" ? snap.rmsDb : -60;
        setRmsDbDisplay(`${db.toFixed(1)} dB`);
      }

      // Color selection by acoustic state
      let strokeColor = "#64748B";
      let barColor = "rgba(100, 116, 139, 0.22)";
      if (effectiveState === "speaking") {
        strokeColor = "#38BDF8";
        barColor = "rgba(56, 189, 248, 0.18)";
      } else if (effectiveState === "listening") {
        strokeColor = isMuted ? "#94A3B8" : "#10B981";
        barColor = isMuted
          ? "rgba(148, 163, 184, 0.14)"
          : "rgba(16, 185, 129, 0.18)";
      } else if (effectiveState === "processing" || effectiveState === "connecting") {
        strokeColor = "#60A5FA";
        barColor = "rgba(96, 165, 250, 0.16)";
      }

      // 1. Harmonic Frequency Spectrum Bars (subtle symmetrical background layer)
      const barCount = 56;
      const barGap = 4 * dpr;
      const totalBarArea = w * 0.92;
      const startX = (w - totalBarArea) / 2;
      const barWidth = Math.max(
        2 * dpr,
        (totalBarArea - barGap * (barCount - 1)) / barCount
      );

      ctx.fillStyle = barColor;
      const freqLen = snap.frequency.length;

      for (let i = 0; i < barCount; i++) {
        let magnitude = 0;
        if (snap.hasSignal && (effectiveState === "speaking" || (effectiveState === "listening" && !isMuted))) {
          const binIndex = Math.min(
            freqLen - 1,
            Math.floor((i / barCount) * (freqLen * 0.45))
          );
          magnitude = snap.frequency[binIndex] / 255;
        } else if (effectiveState === "speaking" && !prefersReducedMotion) {
          const centerEnv = Math.sin((i / barCount) * Math.PI);
          magnitude =
            (0.22 +
              0.25 * Math.abs(Math.sin(phase * 2.4 + i * 0.35)) *
                Math.abs(Math.cos(phase * 1.1 + i * 0.15))) *
            (0.35 + 0.65 * centerEnv);
        } else if (
          (effectiveState === "processing" || effectiveState === "connecting") &&
          !prefersReducedMotion
        ) {
          magnitude =
            0.14 + 0.12 * Math.sin(phase * 1.4 + i * 0.28) * Math.cos(phase * 0.6 + i * 0.1);
        } else {
          magnitude = 0.03;
        }

        const barH = Math.max(3 * dpr, magnitude * h * 0.68);
        const x = startX + i * (barWidth + barGap);
        const y = midY - barH / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barH, barWidth / 2);
        ctx.fill();
      }

      // 2. Smooth Oscilloscope Time-Domain Waveform Trace
      ctx.save();
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.2 * dpr;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      const samples = snap.timeDomain;
      const sampleCount = Math.min(samples.length, 256);
      const stepX = w / (sampleCount - 1);

      for (let i = 0; i < sampleCount; i++) {
        const x = i * stepX;
        let yOffset = 0;

        if (
          snap.hasSignal &&
          (effectiveState === "speaking" ||
            (effectiveState === "listening" && !isMuted))
        ) {
          const norm = (samples[i] - 128) / 128;
          yOffset = norm * (h * 0.42);
        } else if (effectiveState === "speaking" && !prefersReducedMotion) {
          const t = i / sampleCount;
          const envelope = Math.sin(t * Math.PI);
          yOffset =
            (Math.sin(t * Math.PI * 10 + phase * 3.4) * 0.65 +
              Math.sin(t * Math.PI * 17 - phase * 2.1) * 0.35) *
            (h * 0.24) *
            envelope;
        } else if (
          (effectiveState === "processing" || effectiveState === "connecting") &&
          !prefersReducedMotion
        ) {
          const t = i / sampleCount;
          const envelope = Math.sin(t * Math.PI);
          yOffset =
            Math.sin(t * Math.PI * 6 + phase * 2.2) *
            (h * 0.16) *
            envelope;
        } else if (!prefersReducedMotion) {
          const t = i / sampleCount;
          yOffset = Math.sin(t * Math.PI * 2 + phase * 0.5) * (h * 0.025);
        }

        const y = midY + yOffset;
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          const prevX = (i - 1) * stepX;
          const midPtX = (prevX + x) / 2;
          ctx.lineTo(midPtX, y);
        }
      }
      ctx.stroke();
      ctx.restore();

      phase += 0.045;
      rafId = requestAnimationFrame(draw);
    };

    rafId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafId);
  }, [engine, effectiveState, isMuted]);

  const progressPct =
    playback.duration > 0
      ? Math.min(100, (playback.currentTime / playback.duration) * 100)
      : 0;

  return (
    <div className="bg-[#0E131B] text-slate-100 rounded-xl border border-slate-800 overflow-hidden">
      {/* Top acoustic status strip — real audio telemetry only */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800/80 text-xs text-slate-400">
        <div className="flex items-center gap-2.5">
          <span className="font-medium text-slate-200">
            {STATE_LABELS[effectiveState]}
          </span>
          {effectiveState === "listening" && isMuted && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-amber-400">Microphone muted</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span className="font-mono tabular-nums text-slate-400">
            {effectiveState === "speaking" ? "24 kHz Out" : "16 kHz In"}
          </span>
        </div>

        <div className="flex items-center gap-4">
          {playback.messageId && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={playback.isPlaying ? onPausePlayback : onResumePlayback}
                aria-label={playback.isPlaying ? "Pause audio" : "Resume audio"}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-100 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {playback.isPlaying ? (
                  <Pause className="w-3 h-3" />
                ) : (
                  <Play className="w-3 h-3" />
                )}
                <span>{playback.isPlaying ? "Pause" : "Resume"}</span>
              </button>
              <button
                type="button"
                onClick={onStopPlayback}
                aria-label="Stop playback"
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Square className="w-3 h-3" />
                <span>Stop</span>
              </button>
              <span className="font-mono tabular-nums text-slate-300 ml-1">
                {formatDuration(playback.currentTime)} /{" "}
                {formatDuration(playback.duration)}
              </span>
            </div>
          )}
          <span className="font-mono tabular-nums text-slate-400">
            {rmsDbDisplay}
          </span>
        </div>
      </div>

      {/* Main real-time waveform canvas */}
      <div className="relative h-36 sm:h-40 w-full">
        <canvas
          ref={canvasRef}
          className="w-full h-full block"
          aria-label="Real-time audio waveform visualizer"
        />
        {playback.messageId && playback.duration > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-slate-800">
            <div
              className="h-full bg-sky-400 transition-[width] duration-75"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>

      {/* Live Speech Recognition Caption Strip */}
      {(liveTranscript || effectiveState === "listening") && (
        <div className="px-4 py-2.5 bg-[#0A0E14] border-t border-slate-800/80 flex items-baseline gap-3 min-h-[40px]">
          <span className="text-xs font-medium text-emerald-400 whitespace-nowrap shrink-0">
            Speech Recognition
          </span>
          <p className="text-sm text-slate-200 leading-snug truncate">
            {liveTranscript || "Speak now — live transcription active..."}
          </p>
        </div>
      )}
    </div>
  );
};
