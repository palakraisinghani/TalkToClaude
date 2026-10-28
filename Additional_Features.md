# Additional features

Three features around one idea: when the lead steps away (hangs up, talks to someone else, or goes
audio-only), they should come back to a clear picture of what happened, without having to ask each
agent in turn.

---

## 1. The team keeps working after the lead hangs up

**Status: mostly built.** This section records how it works now and what is still missing.

### How it works now

- Hanging up while any agent is busy does not end the call. `leaveRunning()` in `server/index.ts`
  keeps the `Call` running with nobody on it. It sets the floor to nobody (`c.focus(null)`), so
  every agent now counts as being in the background, and keeps every `notify` message (finished,
  failed, permission, question) in `away.news`.
- An agent that hits a permission or a question pauses and waits, as usual. Its request sits in
  `away.news` until the lead is back.
- On the next call, the server rejoins the call left running instead of starting a new one and
  sends a `briefing`. Ada opens with "Welcome back. In the 40 minutes you were away, Juno finished,
  Rex is waiting on you. Say next to go through it." (`briefing()` in `web/app.js`).
- The call left running ends after 20 minutes with the whole team idle, or after 3 hours either
  way (`AWAY_IDLE_MS`, `AWAY_MAX_MS`).

### Gaps worth closing

- **It doesn't survive a restart.** `away` only exists in memory. If the server restarts while the
  lead is away (an update, a reboot), the news is lost, and so is the running work. Fix: write
  `away.news` to disk as it arrives and replay it at the start of the next call. Workers already
  resume their sessions.
- **The briefing names who, not what.** "Juno finished" makes the lead ask Juno what it did. Use
  each agent's one-line `report` in the briefing: "Juno finished: the login page works and the
  tests pass."
- **A paused agent keeps the call alive for 3 hours.** `busy()` counts pending asks, so one
  unanswered permission keeps an otherwise idle team running until the cap. Consider a shorter
  timeout once every agent is idle or paused, with the pending requests saved to the notebook.
- **No word while away.** Lock-screen notifications (`notifyAway()`) only reach a page that's still
  open. A push to the phone, through the PWA or the Android app, would let the lead approve things
  without rejoining the call.

---

## 2. "Milo is ready": telling the lead when something they asked for is done

### The problem

The lead asks Milo for "a detailed, well-crafted summary of the codebase", then switches to Juno
while Milo works. When Milo finishes, it's neither a permission nor a question, so it's
`needsReply: false`. The page only puts it on Milo's card and in the feed (`enqueue()` in
`web/app.js`). Ada never says anything, even though the lead is waiting for exactly that.

Today's rule ("only what needs a reply is announced") is right for background work: Iris finishing
a refactor that Ada handed out isn't worth interrupting for. But a result the lead **asked for in
person and is waiting on** is different, and should be announced.

### The behaviour

1. The lead asks the agent on the line for something, then moves away before it's done.
2. When that agent finishes, Ada mentions it at the next quiet moment, in the same heads-up as
   people waiting: "Milo's summary is ready, and Rex is waiting on you. Want to hear them?"
3. "Yes" or "next" puts the lead through to Milo, who gives the answer **in its own voice**, with
   anything it wrote in `<screen>` on the canvas. Ada doesn't read Milo's work out for it; she
   never reads agents' work.
4. "Later" leaves it in the queue. Switching to Milo by name clears it, because the lead is now
   there to hear it.

### When does a result count as "asked for"?

- **Automatically:** a turn started while the agent was **on the line** (an `ask()` that wasn't
  `assigned` by Ada), where the floor moved away before the turn ended. That's the Milo case: the
  lead asked, then left.
- **Explicitly:** the lead says "tell me when it's ready" or "let me know when Rex is done". Ada
  marks it with an attribute on her tag, such as `<delegate to="rex" notify="true">…</delegate>`.
- **Not:** work Ada handed out without that request, and follow-up turns the agent queued for
  itself. These stay on the card, as now.

### Where it goes in the code

- `server/call.ts`
  - `Project`: add `awaited: number | null`, the turn the lead is waiting on.
  - `ask()`: when the agent is on the line and the message isn't `assigned`, set
    `p.awaited = turn`.
  - `handle()` on `done`: if `turn === p.awaited`, the agent isn't on the line, and the turn wasn't
    interrupted, queue a new notification kind `ready` (with `needsReply`) instead of `finished`.
    Then clear `p.awaited`.
  - `focus()`: switching back to the agent before it finishes clears `p.awaited`, since the lead
    hears it live.
- `server/notify.ts`: phrase `ready` as "Milo's summary is ready", using the first few words of
  the request ("the summary", "the test results") when they fit.
- `web/attention.js`
  - Add `ready` to `RANK`, after `question` and before `blocked`.
  - In `headsUpLine()`, say "X is ready" separately from "is waiting on you".
  - In `present()`, focus the agent and ask it to give its answer, rather than having Ada read
    `item.text`.
- `web/app.js`, `briefing()`: list `ready` items first, with "Milo has the summary you asked for".

### Edge cases

- **The turn fails or is cut off.** Announce it as "Milo couldn't finish the summary", still as
  something the lead asked for.
- **The agent ends on a question.** The question wins. It's already announced, and the answer
  comes after.
- **Several results ready.** One heads-up names them all, as it does now for people waiting.
- **Hold my calls.** `ready` is held like everything else, and Ada mentions it when the hold ends.

---

## 3. Catching up after audio-only mode

### The problem

The lead spends 40 minutes in audio-only mode, walking around and talking to the team. The canvas
is hidden, so nothing was shown: no diffs, no screens. When they switch back to audio+visual, they
have only a vague idea of what each agent actually changed. (This builds on idea 2 in
`more_features.txt`.)

### The behaviour

1. The server notes when audio-only mode starts: the time, and the latest snapshot of each agent's
   folder.
2. When the lead switches back to audio+visual, Ada offers a recap, if there's anything to recap:
   "While you were on audio, Juno, Rex and Milo did some work. Want a recap?"
3. **"No"** (or saying nothing, or just carrying on): nothing is gathered, the mark is reset, and
   the call goes on.
4. **"Yes":** Ada gathers a summary from each agent that did work since the mark, then gives an
   overview:
   - **spoken**, two or three sentences: "Juno finished the login page, Rex fixed two of the three
     failing tests and plans to tackle the last one next, and Milo's summary is on screen";
   - **on the canvas**, a section per agent: what it did, which files changed, anything still
     open, and the next steps it planned.
5. After the recap, the mark resets to now, so the next one starts from here.

Don't offer it for short stretches, such as under 5 minutes or with no finished turns, so that
toggling the mode doesn't trigger it every time.

### How the summaries are gathered

For each agent with finished turns since the mark, **in parallel**:

- **What it says it did:** a side question (`ClaudeSession.sideQuestion()`, Claude Code's `/btw`).
  It's answered from the agent's own conversation, uses no tools, and doesn't stop work in
  progress, so a busy agent can answer too. The prompt: "Since <time>, what did you do, what's
  still open, and what did you plan to do next? Markdown, short sections."
- **What actually changed:** `changedSince()` from `checkpoint.ts`, compared with the agent's
  first checkpoint after the mark. This gives a file list straight from git, so the recap shows
  real changes even if an agent's account leaves something out or gets it wrong.
- **Parked or not running:** use its notebook `status` line and the git file list, without asking
  it anything.
- **Timeout per agent** (about 20 seconds): an agent that doesn't answer in time is listed with
  its one-line `report` and the file list.

The server then sends everything to Ada as one message:
`[recap since audio-only began at 14:05 — Juno: …; Rex: …; files changed: …]`. She writes the short
spoken overview in `<say>` and the per-agent sections in `<screen>`. Ada still does no project work
here. She's summarising what agents reported, which is within her role.

### Doing it ahead of time (optional)

`more_features.txt` suggests building the recap during quiet moments in audio mode, so it's ready
the instant the lead switches back. That makes it instant but costs model calls for recaps nobody
may want. A middle option: keep the git file list and each agent's `report` up to date as turns
finish (no model needed), and only ask the side questions once the lead says yes.

### Where it goes in the code

- `server/call.ts`
  - `setMode()`: on entering audio mode, store `audioSince` and each agent's latest checkpoint.
    On leaving it, if worthwhile, send `{ type: "recap-offer", since, names }` to the page.
  - A new `recap()`: gathers the side questions and the `changedSince()` file lists with
    `Promise.allSettled`, each with a timeout, then calls `ask(CENTRAL_ID, …)` with the combined
    note.
- `web/attention.js`: a new `recap` item, offered once at the next quiet moment. "Yes" sends
  `{ type: "recap" }`; "no" or "later" sends `{ type: "recap-skip" }`, which resets the mark.
- `web/app.js`, `applyMode()`: send `{ mode }` to the server as soon as the mode changes. Right now
  the mode only reaches the server with the next utterance or `call-start` (`index.ts:389`), so a
  switch made in silence wouldn't be noticed until the lead next spoke.
- `skill/claude-call/CENTRAL.md`: one paragraph on what a `[recap …]` note is and how to give it
  (short spoken overview, details on screen, next steps for each agent).

### Edge cases

- **An agent is in the middle of a turn.** The side question answers from what it knows so far,
  and the recap says it's still working.
- **The lead goes back to audio-only before answering.** Withdraw the offer, keep the mark, and
  offer again later.
- **An agent was cleared or compacted since the mark.** Its side-question answer may miss earlier
  work. The git file list still shows what changed.
- **Cost.** One side question per active agent, plus one turn for Ada. The canvas shows what it
  cost on each agent's meter, as for any turn.
