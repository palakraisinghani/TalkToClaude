export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; summary: string; detail: string }
  | { kind: "permission"; tool: string; toolUseId: string; message: string }
  | { kind: "done"; sessionId: string; interrupted: boolean }
  | { kind: "error"; message: string };

/** A long-lived agent conversation: one warm process per call, one message per turn. */
export interface Agent {
  start(): void;
  /** Queue a user message; returns its turn number. Interrupts the running turn first. */
  send(text: string): number;
  interrupt(): void;
  /** Raise or lower what this session may do, without losing its context. */
  setPermissionMode(mode: string): void;
  close(): void;
  on(listener: (turn: number, event: AgentEvent) => void): void;
}

/** Speech to text for one finished utterance (16 kHz mono samples in -1..1). */
export interface STT {
  ready(): Promise<void>;
  transcribe(audio: Float32Array): Promise<string>;
}

export interface TTS {
  speak(sentence: string): Promise<void>;
  stop(): void;
}

export interface Rewriter {
  toSpeech(text: string): Promise<string>;
}

export type Mode = "visual" | "audio";
