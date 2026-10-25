export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; summary: string; detail: string; images?: string[] }
  | { kind: "permission"; tool: string; toolUseId: string; input: unknown; message: string }
  /** The agent is paused on an action that needs a person's yes or no. */
  | { kind: "ask"; requestId: string; tool: string; input: any; reason: string; title: string; suggestions: unknown[] }
  | { kind: "compacted" }
  | { kind: "done"; sessionId: string; interrupted: boolean; costUsd?: number; ms?: number }
  /** A queued message that was let go before it ever ran. */
  | { kind: "dropped" }
  | { kind: "error"; message: string };

/** A long-lived agent conversation: one warm process per call, one message per turn. */
export interface Agent {
  start(): void;
  /** Queue a user message; returns its turn number. Interrupts the running turn first unless told not to. */
  send(text: string, opts?: { interrupt?: boolean; replaceQueued?: boolean }): number;
  interrupt(): void;
  /** Raise or lower what this session may do, without losing its context. */
  setPermissionMode(mode: string): void;
  close(): void;
  on(listener: (turn: number, event: AgentEvent) => void): void;
}

export interface TranscribeOptions {
  /** Names likely to be said — the team's — so a recogniser that takes a prompt reads them right. */
  names?: string[];
}

/** Speech to text for one finished utterance (16 kHz mono samples in -1..1). */
export interface STT {
  ready(): Promise<void>;
  transcribe(audio: Float32Array, opts?: TranscribeOptions): Promise<string>;
}

export interface TTS {
  speak(sentence: string): Promise<void>;
  stop(): void;
}

export interface Rewriter {
  toSpeech(text: string): Promise<string>;
}

export type Mode = "visual" | "audio";
