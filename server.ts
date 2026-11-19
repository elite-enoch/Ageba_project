import "dotenv/config";
import express, { Request, Response } from "express";
import { createServer as createHttpServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, LiveServerMessage, Modality } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Please check Settings > Secrets."
    );
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: "v1beta",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function formatApiError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || "Unexpected server error";
    if (msg.includes("403") || msg.includes("PERMISSION_DENIED") || msg.includes("API_KEY_INVALID")) {
      return "API key permission error. Please verify your Gemini API key in Settings > Secrets.";
    }
    if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
      return "Rate limit or quota reached. Please wait a moment and try again.";
    }
    return msg;
  }
  return "Unexpected server error";
}

interface ChatTurn {
  role: "user" | "model";
  text: string;
}

const VALID_VOICES = new Set(["Zephyr", "Kore", "Puck", "Charon", "Fenrir"]);

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "25mb" }));

  // Health check
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY) });
  });

  // Speech-to-text transcription for recorded audio clips
  app.post("/api/transcribe", async (req: Request, res: Response) => {
    try {
      const { audioBase64, mimeType } = req.body as {
        audioBase64?: string;
        mimeType?: string;
      };

      if (!audioBase64 || !mimeType) {
        res.status(400).json({ error: "audioBase64 and mimeType are required." });
        return;
      }

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: "gemini-3.5-transcribe",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType,
                data: audioBase64,
              },
            },
            {
              text: "Transcribe the spoken audio verbatim. Return only the spoken text without timestamps or commentary.",
            },
          ],
        },
      });

      res.json({ transcript: (response.text ?? "").trim() });
    } catch (err) {
      console.error("Transcription error:", err);
      res.status(500).json({ error: formatApiError(err) });
    }
  });

  // Real-time streaming NLP conversation turn (SSE)
  app.post("/api/chat/stream", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      const { history = [], message, systemInstruction } = req.body as {
        history?: ChatTurn[];
        message?: string;
        systemInstruction?: string;
      };

      if (!message || !message.trim()) {
        res.write(`data: ${JSON.stringify({ error: "Message is required." })}\n\n`);
        res.end();
        return;
      }

      const ai = getGeminiClient();
      const contents = [
        ...history
          .filter((t) => t.text && t.text.trim())
          .map((t) => ({
            role: t.role,
            parts: [{ text: t.text }],
          })),
        {
          role: "user" as const,
          parts: [{ text: message.trim() }],
        },
      ];

      const stream = await ai.models.generateContentStream({
        model: "gemini-4-hydrogen",
        contents,
        config: {
          systemInstruction:
            systemInstruction ||
            "You are Sonance, a warm, articulate, and concise conversational voice assistant. Speak naturally in clear sentences suited for spoken audio playback, avoiding markdown tables or dense formatting unless requested.",
        },
      });

      for await (const chunk of stream) {
        if (chunk.text) {
          res.write(`data: ${JSON.stringify({ chunk: chunk.text })}\n\n`);
        }
      }

      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    } catch (err) {
      console.error("Chat stream error:", err);
      res.write(`data: ${JSON.stringify({ error: formatApiError(err) })}\n\n`);
      res.end();
    }
  });

  // Text-to-Speech generation returning 24kHz WAV
  app.post("/api/tts", async (req: Request, res: Response) => {
    try {
      const { text, voiceName = "Zephyr", style } = req.body as {
        text?: string;
        voiceName?: string;
        style?: string;
      };

      if (!text || !text.trim()) {
        res.status(400).json({ error: "Text is required for speech synthesis." });
        return;
      }

      const safeVoice = VALID_VOICES.has(voiceName) ? voiceName : "Zephyr";
      const ai = getGeminiClient();

      const part: { text: string; speechMetadata?: { style: string } } = {
        text: text.trim(),
      };
      if (style && style.trim()) {
        part.speechMetadata = { style: style.trim() };
      }

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash-lite-tts",
        contents: [
          {
            role: "user",
            parts: [part],
          },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: safeVoice },
            },
          },
        },
      });

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!base64Audio) {
        res.status(502).json({ error: "No audio data returned by speech synthesis." });
        return;
      }

      res.json({
        audioBase64: base64Audio,
        mimeType: "audio/wav",
      });
    } catch (err) {
      console.error("TTS error:", err);
      res.status(500).json({ error: formatApiError(err) });
    }
  });

  const server = createHttpServer(app);

  // WebSocket bridge for Gemini Live API real-time duplex voice conversation
  const wss = new WebSocketServer({ server, path: "/ws/live" });

  wss.on("connection", (clientWs: WebSocket) => {
    let session: Awaited<ReturnType<GoogleGenAI["live"]["connect"]>> | null = null;
    let isClosing = false;

    const sendToClient = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const cleanup = () => {
      if (isClosing) return;
      isClosing = true;
      if (session) {
        try {
          session.close();
        } catch {
          // ignore close errors
        }
        session = null;
      }
    };

    clientWs.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          voiceName?: string;
          systemInstruction?: string;
          data?: string;
          text?: string;
        };

        if (msg.type === "start") {
          if (session) return;
          const ai = getGeminiClient();
          const safeVoice =
            msg.voiceName && VALID_VOICES.has(msg.voiceName)
              ? msg.voiceName
              : "Zephyr";

          session = await ai.live.connect({
            model: "gemini-3.8-live",
            config: {
              responseModalities: [Modality.AUDIO],
              inputAudioTranscription: {},
              outputAudioTranscription: {},
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: safeVoice },
                },
              },
              systemInstruction:
                msg.systemInstruction ||
                "You are Sonance, an attentive, conversational AI voice assistant. Keep spoken replies crisp, natural, and directly helpful.",
            },
            callbacks: {
              onmessage: (message: LiveServerMessage) => {
                const content = message.serverContent;
                if (!content) return;

                if (content.interimInputTranscription?.text) {
                  sendToClient({
                    type: "interimInputTranscript",
                    text: content.interimInputTranscription.text,
                  });
                }

                if (content.inputTranscription?.text) {
                  sendToClient({
                    type: "inputTranscript",
                    text: content.inputTranscription.text,
                  });
                }

                if (content.outputTranscription?.text) {
                  sendToClient({
                    type: "outputTranscript",
                    text: content.outputTranscription.text,
                  });
                }

                for (const part of content.modelTurn?.parts ?? []) {
                  if (part.inlineData?.data) {
                    sendToClient({
                      type: "audio",
                      data: part.inlineData.data,
                    });
                  }
                }

                if (content.interrupted) {
                  sendToClient({ type: "interrupted" });
                }

                if (content.turnComplete) {
                  sendToClient({ type: "turnComplete" });
                }
              },
              onerror: (err) => {
                console.error("Gemini Live error:", err);
                if (session) {
                  sendToClient({
                    type: "error",
                    message: formatApiError(err),
                  });
                }
              },
              onclose: () => {
                if (!isClosing && session) {
                  sendToClient({ type: "closed" });
                }
              },
            },
          });

          if (isClosing) {
            try {
              session.close();
            } catch {
              // ignore
            }
            session = null;
            return;
          }

          sendToClient({ type: "ready" });
        } else if (msg.type === "audio" && msg.data && session) {
          session.sendRealtimeInput({
            audio: {
              data: msg.data,
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } else if (msg.type === "text" && msg.text && session) {
          session.sendRealtimeInput({
            text: msg.text,
          });
        } else if (msg.type === "stop") {
          cleanup();
          sendToClient({ type: "closed" });
        }
      } catch (err) {
        console.error("WebSocket message error:", err);
        sendToClient({
          type: "error",
          message: formatApiError(err),
        });
      }
    });

    clientWs.on("close", () => {
      cleanup();
    });

    clientWs.on("error", () => {
      cleanup();
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Sonance server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
