import {
  base64ToInt16Array,
  base64ToUint8Array,
  float32ToPcm16Base64,
} from "./audioUtils";

export interface AnalysisSnapshot {
  timeDomain: Uint8Array;
  frequency: Uint8Array;
  rmsDb: number;
  hasSignal: boolean;
}

export interface PlaybackProgress {
  messageId: string | null;
  currentTime: number;
  duration: number;
  isPlaying: boolean;
}

function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const low = Math.floor(srcIdx);
    const high = Math.min(low + 1, input.length - 1);
    const frac = srcIdx - low;
    output[i] = input[low] * (1 - frac) + input[high] * frac;
  }
  return output;
}

export class VoiceAudioEngine {
  private inputCtx: AudioContext | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private muteGain: GainNode | null = null;
  private isMuted = false;

  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordStartedAt = 0;

  private outputCtx: AudioContext | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private liveSources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;

  // Replay WAV state
  private wavBuffer: AudioBuffer | null = null;
  private wavSource: AudioBufferSourceNode | null = null;
  private wavMessageId: string | null = null;
  private wavOffset = 0;
  private wavStartedAt = 0;
  private wavPlaying = false;
  private progressRaf: number | null = null;
  private onProgressCb: ((p: PlaybackProgress) => void) | null = null;
  private onLiveEndedCb: (() => void) | null = null;
  private liveIdleTimer: number | null = null;

  // Browser speechSynthesis fallback state (when Gemini TTS quota is reached)
  private browserSpeechId: string | null = null;
  private browserSpeechPlaying = false;
  private browserSpeechTimer: number | null = null;
  private browserSpeechStartMs = 0;
  private browserSpeechEstDur = 0;

  private emptyTimeDomain = new Uint8Array(512).fill(128);
  private emptyFrequency = new Uint8Array(512).fill(0);

  private ensureOutputContext(): { ctx: AudioContext; analyser: AnalyserNode } {
    if (!this.outputCtx) {
      this.outputCtx = new AudioContext({ sampleRate: 24000 });
      this.outputAnalyser = this.outputCtx.createAnalyser();
      this.outputAnalyser.fftSize = 1024;
      this.outputAnalyser.smoothingTimeConstant = 0.78;
      this.outputAnalyser.connect(this.outputCtx.destination);
    }
    if (this.outputCtx.state === "suspended") {
      void this.outputCtx.resume();
    }
    return { ctx: this.outputCtx, analyser: this.outputAnalyser! };
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public async startMicStreaming(
    onPcm16Base64: (base64: string) => void
  ): Promise<void> {
    await this.stopMicStreaming();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    this.micStream = stream;

    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      ctx = new AudioContext();
    }
    this.inputCtx = ctx;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;

    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const zeroGain = ctx.createGain();
    zeroGain.gain.value = 0;

    source.connect(analyser);
    analyser.connect(processor);
    processor.connect(zeroGain);
    zeroGain.connect(ctx.destination);

    processor.onaudioprocess = (event) => {
      if (this.isMuted) return;
      const raw = event.inputBuffer.getChannelData(0);
      const resampled = resampleLinear(raw, ctx.sampleRate, 16000);
      const b64 = float32ToPcm16Base64(resampled);
      onPcm16Base64(b64);
    };

    this.micSource = source;
    this.inputAnalyser = analyser;
    this.scriptProcessor = processor;
    this.muteGain = zeroGain;
  }

  public async stopMicStreaming(): Promise<void> {
    if (this.scriptProcessor) {
      this.scriptProcessor.onaudioprocess = null;
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    if (this.muteGain) {
      this.muteGain.disconnect();
      this.muteGain = null;
    }
    if (this.micSource) {
      this.micSource.disconnect();
      this.micSource = null;
    }
    if (this.inputAnalyser) {
      this.inputAnalyser.disconnect();
      this.inputAnalyser = null;
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        track.stop();
      }
      this.micStream = null;
    }
    if (this.inputCtx) {
      try {
        await this.inputCtx.close();
      } catch {
        // ignore close errors
      }
      this.inputCtx = null;
    }
  }

  public async startClipRecording(): Promise<void> {
    await this.stopMicStreaming();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.micStream = stream;

    const ctx = new AudioContext();
    this.inputCtx = ctx;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    this.micSource = source;
    this.inputAnalyser = analyser;

    const preferredTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/ogg",
    ];
    const mimeType = preferredTypes.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    this.recordedChunks = [];
    this.recordStartedAt = performance.now();
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };
    recorder.start(150);
    this.mediaRecorder = recorder;
  }

  public async stopClipRecording(): Promise<{
    audioBase64: string;
    mimeType: string;
    durationSec: number;
  } | null> {
    const recorder = this.mediaRecorder;
    if (!recorder) {
      await this.stopMicStreaming();
      return null;
    }

    const durationSec = Math.max(
      0.2,
      (performance.now() - this.recordStartedAt) / 1000
    );

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || "audio/webm";
        resolve(new Blob(this.recordedChunks, { type }));
      };
      if (recorder.state !== "inactive") {
        recorder.stop();
      } else {
        resolve(new Blob(this.recordedChunks, { type: recorder.mimeType || "audio/webm" }));
      }
    });

    this.mediaRecorder = null;
    this.recordedChunks = [];
    await this.stopMicStreaming();

    if (blob.size < 200) return null;

    const arrayBuf = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuf);
    let binary = "";
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode(...bytes.subarray(i, i + step));
    }
    const base64 = btoa(binary);
    const cleanMime = (blob.type || "audio/webm").split(";")[0];

    return {
      audioBase64: base64,
      mimeType: cleanMime,
      durationSec,
    };
  }

  public playLivePcmChunk(
    base64Pcm: string,
    onPlaybackActivity?: (active: boolean) => void
  ): void {
    const { ctx, analyser } = this.ensureOutputContext();
    const int16 = base64ToInt16Array(base64Pcm);
    if (int16.length === 0) return;

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
    audioBuffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(analyser);

    const now = ctx.currentTime;
    if (this.nextStartTime < now + 0.02) {
      this.nextStartTime = now + 0.03;
    }
    const startAt = this.nextStartTime;
    this.nextStartTime = startAt + audioBuffer.duration;

    this.liveSources.add(source);
    if (onPlaybackActivity) {
      onPlaybackActivity(true);
    }

    if (this.liveIdleTimer) {
      window.clearTimeout(this.liveIdleTimer);
      this.liveIdleTimer = null;
    }

    source.onended = () => {
      this.liveSources.delete(source);
      if (this.liveSources.size === 0) {
        this.liveIdleTimer = window.setTimeout(() => {
          if (this.liveSources.size === 0 && onPlaybackActivity) {
            onPlaybackActivity(false);
          }
          if (this.onLiveEndedCb) {
            this.onLiveEndedCb();
          }
        }, 180);
      }
    };

    source.start(startAt);
  }

  public stopLivePlayback(): void {
    if (this.liveIdleTimer) {
      window.clearTimeout(this.liveIdleTimer);
      this.liveIdleTimer = null;
    }
    for (const src of this.liveSources) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {
        // ignore already stopped
      }
    }
    this.liveSources.clear();
    this.nextStartTime = 0;
  }

  public isLiveAudioPlaying(): boolean {
    return this.liveSources.size > 0;
  }

  public async playWav(
    base64Audio: string,
    messageId: string,
    onProgress: (p: PlaybackProgress) => void
  ): Promise<void> {
    this.stopWav();
    this.stopLivePlayback();

    const { ctx } = this.ensureOutputContext();
    const bytes = base64ToUint8Array(base64Audio);
    const arrayBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(arrayBuffer).set(bytes);
    const decoded = await ctx.decodeAudioData(arrayBuffer);

    this.wavBuffer = decoded;
    this.wavMessageId = messageId;
    this.wavOffset = 0;
    this.onProgressCb = onProgress;

    this.startWavSourceFromOffset(0);
  }

  private startWavSourceFromOffset(offset: number): void {
    if (!this.wavBuffer) return;
    const { ctx, analyser } = this.ensureOutputContext();

    if (this.wavSource) {
      try {
        this.wavSource.onended = null;
        this.wavSource.stop();
        this.wavSource.disconnect();
      } catch {
        // ignore
      }
    }

    const src = ctx.createBufferSource();
    src.buffer = this.wavBuffer;
    src.connect(analyser);

    const safeOffset = Math.max(0, Math.min(offset, this.wavBuffer.duration));
    this.wavOffset = safeOffset;
    this.wavStartedAt = ctx.currentTime - safeOffset;
    this.wavPlaying = true;
    this.wavSource = src;

    src.onended = () => {
      if (!this.wavPlaying) return;
      this.wavPlaying = false;
      this.wavOffset = 0;
      if (this.progressRaf) {
        cancelAnimationFrame(this.progressRaf);
        this.progressRaf = null;
      }
      if (this.onProgressCb && this.wavBuffer) {
        this.onProgressCb({
          messageId: null,
          currentTime: 0,
          duration: this.wavBuffer.duration,
          isPlaying: false,
        });
      }
    };

    src.start(0, safeOffset);
    this.tickProgress();
  }

  private tickProgress = (): void => {
    if (!this.wavPlaying || !this.wavBuffer || !this.outputCtx) return;
    const current = Math.min(
      this.wavBuffer.duration,
      Math.max(0, this.outputCtx.currentTime - this.wavStartedAt)
    );
    this.wavOffset = current;
    if (this.onProgressCb) {
      this.onProgressCb({
        messageId: this.wavMessageId,
        currentTime: current,
        duration: this.wavBuffer.duration,
        isPlaying: true,
      });
    }
    this.progressRaf = requestAnimationFrame(this.tickProgress);
  };

  public speakBrowserFallback(
    text: string,
    messageId: string,
    onProgress: (p: PlaybackProgress) => void
  ): boolean {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      return false;
    }

    this.stopWav();
    this.stopLivePlayback();

    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const estDuration = Math.max(1.5, words / 2.6);

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => v.lang.startsWith("en") && v.localService) ||
      voices.find((v) => v.lang.startsWith("en"));
    if (preferred) {
      utterance.voice = preferred;
    }

    this.browserSpeechId = messageId;
    this.browserSpeechPlaying = true;
    this.browserSpeechStartMs = performance.now();
    this.browserSpeechEstDur = estDuration;
    this.onProgressCb = onProgress;

    const clearTimer = () => {
      if (this.browserSpeechTimer) {
        window.clearInterval(this.browserSpeechTimer);
        this.browserSpeechTimer = null;
      }
    };

    utterance.onend = () => {
      clearTimer();
      this.browserSpeechPlaying = false;
      this.browserSpeechId = null;
      onProgress({
        messageId: null,
        currentTime: 0,
        duration: estDuration,
        isPlaying: false,
      });
    };

    utterance.onerror = () => {
      clearTimer();
      this.browserSpeechPlaying = false;
      this.browserSpeechId = null;
      onProgress({
        messageId: null,
        currentTime: 0,
        duration: 0,
        isPlaying: false,
      });
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);

    onProgress({
      messageId,
      currentTime: 0,
      duration: estDuration,
      isPlaying: true,
    });

    this.browserSpeechTimer = window.setInterval(() => {
      if (!this.browserSpeechPlaying || this.browserSpeechId !== messageId) {
        clearTimer();
        return;
      }
      const elapsed = Math.min(
        estDuration,
        (performance.now() - this.browserSpeechStartMs) / 1000
      );
      onProgress({
        messageId,
        currentTime: elapsed,
        duration: estDuration,
        isPlaying: true,
      });
    }, 120);

    return true;
  }

  public pauseWav(): void {
    if (this.browserSpeechPlaying && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.pause();
      this.browserSpeechPlaying = false;
      if (this.onProgressCb && this.browserSpeechId) {
        this.onProgressCb({
          messageId: this.browserSpeechId,
          currentTime: (performance.now() - this.browserSpeechStartMs) / 1000,
          duration: this.browserSpeechEstDur,
          isPlaying: false,
        });
      }
      return;
    }

    if (!this.wavPlaying || !this.wavSource || !this.outputCtx) return;
    this.wavOffset = Math.min(
      this.wavBuffer?.duration ?? 0,
      Math.max(0, this.outputCtx.currentTime - this.wavStartedAt)
    );
    this.wavPlaying = false;
    try {
      this.wavSource.onended = null;
      this.wavSource.stop();
      this.wavSource.disconnect();
    } catch {
      // ignore
    }
    this.wavSource = null;
    if (this.progressRaf) {
      cancelAnimationFrame(this.progressRaf);
      this.progressRaf = null;
    }
    if (this.onProgressCb && this.wavBuffer) {
      this.onProgressCb({
        messageId: this.wavMessageId,
        currentTime: this.wavOffset,
        duration: this.wavBuffer.duration,
        isPlaying: false,
      });
    }
  }

  public resumeWav(): void {
    if (this.browserSpeechId && !this.browserSpeechPlaying && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.resume();
      this.browserSpeechPlaying = true;
      if (this.onProgressCb) {
        this.onProgressCb({
          messageId: this.browserSpeechId,
          currentTime: (performance.now() - this.browserSpeechStartMs) / 1000,
          duration: this.browserSpeechEstDur,
          isPlaying: true,
        });
      }
      return;
    }
    if (this.wavPlaying || !this.wavBuffer) return;
    this.startWavSourceFromOffset(this.wavOffset);
  }

  public stopWav(): void {
    if (this.browserSpeechTimer) {
      window.clearInterval(this.browserSpeechTimer);
      this.browserSpeechTimer = null;
    }
    if (this.browserSpeechId && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      this.browserSpeechPlaying = false;
      this.browserSpeechId = null;
      if (this.onProgressCb) {
        this.onProgressCb({
          messageId: null,
          currentTime: 0,
          duration: 0,
          isPlaying: false,
        });
      }
    }

    this.wavPlaying = false;
    if (this.progressRaf) {
      cancelAnimationFrame(this.progressRaf);
      this.progressRaf = null;
    }
    if (this.wavSource) {
      try {
        this.wavSource.onended = null;
        this.wavSource.stop();
        this.wavSource.disconnect();
      } catch {
        // ignore
      }
      this.wavSource = null;
    }
    this.wavOffset = 0;
    const oldId = this.wavMessageId;
    this.wavMessageId = null;
    this.wavBuffer = null;
    if (oldId && this.onProgressCb) {
      this.onProgressCb({
        messageId: null,
        currentTime: 0,
        duration: 0,
        isPlaying: false,
      });
    }
  }

  public getSnapshot(preferSource: "mic" | "playback" | "auto"): AnalysisSnapshot {
    if (this.browserSpeechPlaying) {
      return {
        timeDomain: this.emptyTimeDomain,
        frequency: this.emptyFrequency,
        rmsDb: -22,
        hasSignal: false,
      };
    }

    let analyser: AnalyserNode | null = null;
    if (preferSource === "mic") {
      analyser = this.inputAnalyser;
    } else if (preferSource === "playback") {
      analyser = this.outputAnalyser;
    } else {
      if (this.wavPlaying || this.liveSources.size > 0) {
        analyser = this.outputAnalyser;
      } else if (this.inputAnalyser && !this.isMuted) {
        analyser = this.inputAnalyser;
      }
    }

    if (!analyser) {
      return {
        timeDomain: this.emptyTimeDomain,
        frequency: this.emptyFrequency,
        rmsDb: -60,
        hasSignal: false,
      };
    }

    const timeDomain = new Uint8Array(analyser.fftSize / 2);
    const frequency = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteTimeDomainData(timeDomain);
    analyser.getByteFrequencyData(frequency);

    let sumSq = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const normalized = (timeDomain[i] - 128) / 128;
      sumSq += normalized * normalized;
    }
    const rms = Math.sqrt(sumSq / timeDomain.length);
    const rmsDb = rms > 0.0001 ? Math.max(-60, 20 * Math.log10(rms)) : -60;

    return {
      timeDomain,
      frequency,
      rmsDb,
      hasSignal: true,
    };
  }
}
