export type VoiceName = "Zephyr" | "Kore" | "Puck" | "Charon" | "Fenrir";

export type AudioState =
  | "idle"
  | "connecting"
  | "listening"
  | "processing"
  | "speaking";

export type RecognitionEngine = "auto" | "gemini" | "browser";

export interface VoiceOption {
  id: VoiceName;
  label: string;
  tone: string;
  sampleLine: string;
}

export interface AssistantPreset {
  id: string;
  name: string;
  summary: string;
  systemInstruction: string;
  ttsStyle: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  inputMode: "voice" | "text";
  voiceName?: VoiceName;
  audioBase64?: string;
  audioMimeType?: string;
  durationSec?: number;
}

export interface ConversationSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  voiceName: VoiceName;
  presetId: string;
  customSystemInstruction: string;
  messages: ConversationMessage[];
}

export const VOICE_OPTIONS: VoiceOption[] = [
  {
    id: "Zephyr",
    label: "Zephyr",
    tone: "Warm, balanced, and conversational",
    sampleLine:
      "Hello, I am Zephyr. Ready whenever you want to talk through an idea.",
  },
  {
    id: "Kore",
    label: "Kore",
    tone: "Crisp, clear, and articulate",
    sampleLine:
      "Hi there, I am Kore. Let me know what you would like to explore today.",
  },
  {
    id: "Puck",
    label: "Puck",
    tone: "Bright, expressive, and energetic",
    sampleLine:
      "Hey! Puck here. Tell me what is on your mind and let us dive right in.",
  },
  {
    id: "Charon",
    label: "Charon",
    tone: "Measured, calm, and thoughtful",
    sampleLine:
      "Greetings, I am Charon. Take your time and we will work through this step by step.",
  },
  {
    id: "Fenrir",
    label: "Fenrir",
    tone: "Direct, resonant, and focused",
    sampleLine:
      "Fenrir online. Give me the context and I will help you get straight to the answer.",
  },
];

export const ASSISTANT_PRESETS: AssistantPreset[] = [
  {
    id: "conversational",
    name: "Everyday Partner",
    summary: "Natural, warm dialogue suited for spoken back-and-forth",
    systemInstruction:
      "You are Sonance, an attentive and articulate voice assistant. Respond in natural spoken sentences that sound effortless when read aloud. Avoid markdown tables, bullet lists, or dense formatting unless specifically asked. Keep answers focused and invite natural follow-up.",
    ttsStyle: "Natural, warm, conversational speaking pace",
  },
  {
    id: "briefing",
    name: "Executive Briefing",
    summary: "Structured, concise answers focused on key decisions",
    systemInstruction:
      "You are an executive voice briefing assistant. Deliver clear, structured spoken summaries that lead with the core conclusion followed by essential context. Keep responses tight and easy to follow by ear.",
    ttsStyle: "Clear, composed, authoritative briefing tone",
  },
  {
    id: "coach",
    name: "Language & Speaking Coach",
    summary: "Patient feedback on phrasing, clarity, and pronunciation",
    systemInstruction:
      "You are a supportive speaking and language coach. Listen carefully to what the user says, respond naturally to their topic, and gently offer one helpful tip on phrasing or expression when useful.",
    ttsStyle: "Encouraging, clear, well-paced coaching voice",
  },
  {
    id: "architect",
    name: "Technical Sounding Board",
    summary: "Brainstorm architecture, debugging, and engineering trade-offs",
    systemInstruction:
      "You are a senior systems architect acting as a spoken sounding board. Think aloud clearly, highlight key trade-offs concisely, and ask sharp clarifying questions without reciting raw code syntax unless requested.",
    ttsStyle: "Focused, analytical, steady conversational cadence",
  },
];
