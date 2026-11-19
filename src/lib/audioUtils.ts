export function float32ToPcm16Base64(float32: Float32Array): string {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function base64ToInt16Array(base64: string): Int16Array {
  const bytes = base64ToUint8Array(base64);
  return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
}

export function pcm16Base64ChunksToWavBase64(
  chunks: string[],
  sampleRate = 24000
): string {
  const decoded = chunks.map(base64ToUint8Array);
  const totalPcmBytes = decoded.reduce((sum, arr) => sum + arr.byteLength, 0);
  const wavBuffer = new ArrayBuffer(44 + totalPcmBytes);
  const view = new DataView(wavBuffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  // RIFF header
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + totalPcmBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // Audio format = PCM
  view.setUint16(22, 1, true); // Channels = 1 (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate = sampleRate * 2 bytes
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeStr(36, "data");
  view.setUint32(40, totalPcmBytes, true);

  const outBytes = new Uint8Array(wavBuffer);
  let offset = 44;
  for (const chunk of decoded) {
    outBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < outBytes.length; i += step) {
    binary += String.fromCharCode(...outBytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export function estimateWavDurationSec(base64: string, sampleRate = 24000): number {
  const byteLen = Math.floor((base64.length * 3) / 4);
  const pcmBytes = Math.max(0, byteLen - 44);
  return pcmBytes / (sampleRate * 2);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.floor(seconds);
  const mins = Math.floor(rounded / 60);
  const secs = rounded % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativeDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return "Today";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
