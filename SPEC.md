# Buddy — Claude Call: 3-day prototype plan and spec

Oct 24, 2026 · @palak

## Overview

Buddy is a local app that puts you on a voice call with Claude Code. You start a call, talk normally, and Buddy talks back while Claude works: a short line before it digs in, quick updates between steps, then a crisp spoken answer. A "behind the scenes" panel shows Claude's thinking, tool calls and detail as they happen. Everything runs on the existing Claude subscription, with no API keys.

The prototype proves the call loop end to end: natural turn-taking with no cut-offs, speech that starts while Claude is still working, "pause" and "go on", and cutting in with a new question, where Claude is told what you heard and what you missed. Success is a two-minute live demo where a non-technical observer can follow the conversation.

## Scope

In scope for v0:

- A call started from a local web page (Chrome, Edge, Safari, Firefox). The mic stays open for the call, with no wake word and no key.
- Voice activity detection in the browser (Silero VAD) to find where you start and stop. Speech-to-text on the server (Moonshine, running on CPU), with no key and no cloud.
- One warm `claude -p` process per call, fed by stream-json, in `auto` permission mode, so Claude works as a normal agent.
- Speech through the browser's `speechSynthesis`, sentence by sentence as Claude writes.
- Pause, resume, cut-in with context, the local commands, and the sleep timer.
- A live behind-the-scenes panel, hidden in audio-only mode.

Out of scope for v0:

- A VS Code extension
- Neural or cloud voices (the `TTS` interface allows them later)
- Voice-driven approvals: `auto` mode decides, and anything it blocks is reported, not asked
- Memory across calls, packaging, auth, multi-user

## Architecture

&#91;embedded content: Buddy pipeline · 9 components, one Claude Code session\]

- **Page:** the VAD cuts your speech into utterances and sends each one as 16 kHz audio over the WebSocket. The page owns the call state (listening, hearing, working, speaking, paused) and the speech queue.
- **Server:** a thin Node process. It transcribes each utterance with Moonshine (about 0.2 to 0.5 s) and keeps one warm `claude -p --input-format stream-json` per call. The server streams Claude's output back as typed events: `say`, `screen`, `aside`, `thinking`, `tool` and `tool_result`.
- **Warm process:** it removes the cold start from every turn after the first. Interrupts use the stream-json `interrupt` control request, so the session and its context survive.
- **Working directory:** `BUDDY_CWD`, default `session/`.

## Interaction model

One person, one mic, one conversation. The orb and its label always show the state: `asleep`, `listening`, `hearing you`, `working`, `speaking`, `paused`.

The call:

- **Start and sleep.** Press call to start. The call sleeps after `sleepMinutes` with no speech from you (default 15, adjustable 2 to 60). Buddy says so out loud; "go to sleep" or the end button ends it at once. The mic is off outside a call.
- **Turn-taking.** The VAD ends your utterance after about 0.9 s of silence and sends it at once. If you keep talking within 1.5 s, before Buddy has spoken, that turn is replaced by one with your whole sentence. A pause mid-thought never cuts you off, and quick questions still get quick answers.
- **Talking while working.** Claude speaks a short `<say>` line before its first tool call and between steps. If nothing has been said after 3.5 s, Buddy says "one sec"; long silent stretches get a short narration such as "reading auth dot ts".
- **Pause.** "Pause", "wait", "hold on" or the space bar stops the voice mid-word. Claude keeps working, and its output queues up. "Go on" resumes from the same word.
- **Cut in.** Anything else said over Buddy stops the voice and the running turn. Your words go to Claude with a note: what you last heard, what you did not hear, how long ago you paused, and whether work was stopped.
- **Barge-in speed.** With the headphones toggle on, Buddy stops the instant you start talking. On speakers it waits for the transcript, and anything that just echoes Buddy's own words is ignored.

Local commands, handled on the page: `pause`, `go on`, `stop`, `repeat`, `shorter`, `switch to audio mode` / `visual mode`, `go to sleep`. Everything else goes to Claude. A text box lets you type instead.

Modes: **Visual+Audio** shows the behind-the-scenes panel, and Buddy may point at it ("the diff is on the right"). **Audio-only** hides it, and Buddy never mentions a screen.

The name Buddy: a common, friendly word, used on the page and in replies; there is no wake word. The voice is fixed per OS (Samantha on macOS, Google UK English Female on Chrome Windows).

## The voice prompt

`skill/claude-call/` holds three files that the server appends to Claude's system prompt with `--append-system-prompt`. No marker or skill trigger is needed.

- `VOICE.md`: how to work and talk on a call. Work as a normal agent. Speak only inside `<say>`, early and often while working. The answer leads with the verdict, then two to four crisp points of 15 to 20 words each, then a hand-back. No code, paths or symbols in speech. It also covers how to handle a `[cut in: …]` note.
- `examples.md`: 12 before/after pairs (lists, code, test failures, diffs, cut-ins, edits).
- `condensation.md`: patterns for shrinking lists, diffs, stack traces and tables into speech.

## Output format

A turn can interleave any number of these:

```
<say>Let me look at the auth middleware.</say>
(tool calls)
<say>Found it. The token check never waits for verification.
The fix is one word, an await. Want me to apply it?</say>
<screen>
`src/middleware/auth.ts:42`: `verifyToken()` does not await `jwt.verify`.
</screen>
```

- **`<say>`:** split into sentences and spoken as each one closes.
- **`<screen>`:** streamed into the panel as markdown. Code keeps its exact indentation, and long lines scroll inside the block.
- **Text outside tags:** Claude's working notes. They go to the panel and are never spoken.
- **No `<say>` all turn:** the first two cleaned sentences are spoken and the rest is shown.
- **Cleaner:** anything headed to speech goes through a deterministic cleaner. It strips markdown, replaces code with "a snippet on screen", reduces paths to file names and URLs to "a link", splits camelCase, spells out symbols and expands contractions.

## Provider interfaces

```ts
interface Agent {            // one warm conversation per call
  start(): void;
  send(text: string): number; // returns the turn; interrupts a running turn first
  interrupt(): void;
  close(): void;
  on(listener: (turn: number, event: AgentEvent) => void): void;
}

interface STT {              // one finished utterance, 16 kHz mono
  ready(): Promise<void>;
  transcribe(audio: Float32Array): Promise<string>;
}

interface TTS { speak(sentence: string): Promise<void>; stop(): void; }
interface Rewriter { toSpeech(text: string): Promise<string>; }

type AgentEvent =
  | { kind: "text" | "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; ok: boolean; summary: string; detail: string }
  | { kind: "done"; sessionId: string; interrupted: boolean }
  | { kind: "error"; message: string };
```

Defaults:

- **`Agent`:** `ClaudeSession`, a warm `claude -p` with stream-json in and out, `--permission-mode auto` (override with `BUDDY_PERMISSION_MODE`).
- **`STT`:** `MoonshineSTT`, `onnx-community/moonshine-base-ONNX` through transformers.js on the server CPU (override with `BUDDY_STT_MODEL`).
- **`TTS`:** the browser's `speechSynthesis`.
- **`Rewriter`:** a no-op.

Swap-in notes:

- **Cloud STT or TTS:** Gemini or Deepgram can replace them behind the same interfaces when a key is acceptable.
- **`Agent`:** it always runs Claude. Only the auth (subscription or `ANTHROPIC_API_KEY`) is swappable.

## Three-day plan

## Risks and mitigations

## Demo script

## Post-prototype roadmap
