# Future ideas

These are ideas grounded in how Buddy works now: Ada as host, project agents, background relays, and voice. Within each group they're ordered by how much I think each would add.

## 1. Knowing who is who, by ear
- **Real stereo voices.** Speech from the browser's built-in voice can't be panned, but the server runs on your Mac, so it can make each sentence as audio with macOS `say -v Daniel -o …`. It would then stream that to the page and place it with the browser's audio engine. Juno would always talk from your left and Rex from your right. You'd lose exact word-highlighting, but it could be estimated from timing. This is the biggest gain for remembering who is doing what.
- **Sound "where" a project is.** A project waiting on you could sit slightly closer and louder, and one that's idle further back.
- **Per-agent working pulse.** As discussed: a quiet rhythm from each busy agent's side that ducks the instant anyone speaks.

## 2. Ada as a real chief of staff
- **"While you were away" briefing.** When you start a call, Ada summarises what changed since last time from saved transcripts: "Juno finished the login page yesterday; Rex's tests are still failing on two cases."
- **Standing instructions.** "Ada, whenever Rex finishes, have Juno review it." Ada keeps simple trigger→action rules.
- **Scheduled check-ins.** "Remind me in 20 minutes to look at the deploy," or "check on Rex every 10 minutes."
- **Pipelines.** "Build it, then test it, then tell me." Ada runs the chain across agents and only interrupts you at the end or on failure.
- **Ranked interruptions.** Ada judges urgency: a security warning or a failed build can break in sooner, and "done" waits. Wording could also adapt to context, like "quick one" versus "this needs a decision."
- **Daily wrap-up.** When the call ends, Ada saves a markdown summary of what each project did, what's pending, and the questions left open.

## 3. Projects working together
- **Agents asking each other.** Rex could ask Juno through Ada: "what's the API shape for /users?" Ada passes questions between agents without bothering you unless needed.
- **Review handoffs.** "Juno, review Rex's last change." The reviewer gets Rex's changes and a short summary automatically.
- **Shared notes board.** A file in the home folder that every agent reads: decisions, conventions, "we chose SQLite." This prevents agents contradicting each other.

## 4. Safer permissions by voice
- **Spoken risk summaries.** Instead of "Rex needs permission to run a command," Ada says "Rex wants to run `rm -rf build`, which deletes the build folder. Low risk." The full command shows on screen.
- **Approval levels.** "Allow Rex for the next ten minutes," "allow edits but not shell commands," or "always allow running tests."
- **Confirmation for risky things.** Destructive actions like deleting, force-pushing or deploying need "allow Rex, confirm." That fits given the phantom-grant scare: misheard speech should never approve something risky.
- **Undo.** Take a git checkpoint before each project turn, so "Ada, undo what Juno just did" rolls back that turn's changes.

## 5. Better conversation
- **Barge-in tuned to intent.** "Hmm" or "yeah" said over Buddy would be treated as listening noises and wouldn't stop speech. Only content words would cut in.
- **Learned voice profile.** A 10-second enrolment of your voice, so others in the room, the TV and coughs are filtered more reliably.
- **"Show me" by voice.** "Show me the diff" or "put the error on screen" pins that item big in the middle of the screen, which suits glancing at a laptop while pacing.
- **Speech that follows your attention.** In visual mode Buddy talks less when the tab has focus, since you can see the screen, and more when you've switched away. Audio-only mode does this already, but it could happen automatically.
- **Push-to-talk on a hardware key or headphone button.** Media Session API can capture play/pause from AirPods, so tap to pause Buddy and double-tap for updates.

## 6. Away from the desk
- **Phone as remote.** HTTPS for your local network already exists. Add a small mobile layout that's mostly the orb, a "waiting for you" list and big Allow/Deny buttons, so you can approve things from the kitchen.
- **Lock-screen notifications.** Browser notifications for permission requests and questions when the tab is in the background or Buddy is asleep.
- **Agents keep working while Buddy sleeps.** Today the call ending stops everything. Instead, background projects could keep running and Ada greets you with the results.

## 7. Visibility and trust
- **Timeline lanes.** One horizontal lane per agent showing working, waiting and speaking over the last N minutes. You'd see at a glance what ran in parallel and where time went.
- **Cost and time meter per agent.** Turns, tokens and minutes busy, plus a soft budget: "Rex has been on this for 25 minutes, keep going?"
- **Searchable call history.** "What did Juno say about the database last Tuesday?" Ada searches the saved transcripts.

## If I had to pick five
1. **Real stereo voices** via macOS `say` and the browser's audio engine. It's the headline feature and makes the multi-agent idea easy to follow by ear.
2. **Spoken risk summaries plus confirmation for risky actions.** Safety first, and especially important given the phantom grant.
3. **Git checkpoint and undo per turn.** It makes delegating to background agents feel safe.
4. **"While you were away" briefing**, with agents continuing while Buddy sleeps.
5. **Phone remote** for approvals.

Any of these can be scoped and built from the main conversation.
