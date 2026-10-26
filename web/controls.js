// Claude Code's controls, as the lead gives them on a call: said out loud ("plan mode", "Juno,
// think harder", "new conversation") or typed as Claude Code's own slash commands ("/plan",
// "/effort high", "/compact"). Both come out the same: { what, value } for the server's control(),
// or another action the page already has (model, undo, stop, btw).
//
// Spoken phrases must be the whole utterance, so "let's plan mode switching for the app" said to
// an agent is still a message to that agent, not a command.

/** The modes offered, as Claude Code names them and as the lead hears them. */
export const MODES = [
  ["auto", "Auto"],
  ["plan", "Plan"],
  ["acceptEdits", "Accept edits"],
  ["manual", "Ask every time"],
];
export const modeName = (m) => MODES.find(([v]) => v === m)?.[1] ?? m;

/** Effort levels, Claude Code's --effort. "" is its own default. */
export const EFFORTS = [["", "Default effort"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]];

const SPOKEN = [
  [/^(?:(?:switch|go|change|put (?:it|yourself)) (?:in)?to |use |enter |turn on )?(?:the )?plan(?:ning)? mode$/, { what: "mode", value: "plan" }],
  [/^(?:plan (?:it )?first|make a plan first)$/, { what: "mode", value: "plan" }],
  [/^(?:exit|leave|stop|out of) plan(?:ning)? mode$|^stop planning$/, { what: "mode", value: "auto" }],
  [/^(?:(?:switch|go|change) (?:in)?to |use |turn on )?(?:the )?auto(?:matic)? mode$/, { what: "mode", value: "auto" }],
  [/^(?:(?:switch|go|change) (?:in)?to |use |turn on )?(?:the )?accept(?:ing)? edits(?: mode)?$/, { what: "mode", value: "acceptEdits" }],
  [/^(?:(?:switch|go|change) (?:in)?to |use )?(?:the )?(?:manual|ask) mode$|^ask (?:me )?(?:first|every time|before (?:any )?(?:changes|anything))$/, { what: "mode", value: "manual" }],
  [/^think (?:really|very|extra) hard(?:er)?$|^(?:max|maximum) effort$/, { what: "effort", value: "max" }],
  [/^think harder$|^think hard$|^(?:more|high) effort$/, { what: "effort", value: "high" }],
  [/^(?:normal|medium|usual|default) effort$/, { what: "effort", value: "medium" }],
  [/^(?:think less|go quick(?:er)?|be quick(?:er)?|less effort|low effort)$/, { what: "effort", value: "low" }],
  [/^(?:set )?effort (?:to )?(low|medium|high|extra high|xhigh|max(?:imum)?)$/, null],
  [/^(?:start (?:a )?(?:new|fresh) conversation|new conversation|start fresh|fresh start|start over|clear (?:the |your )?(?:conversation|context|chat|history))$/, { what: "clear" }],
  [/^(?:compact|compact (?:the |your )?(?:conversation|context|history|it))$/, { what: "compact" }],
];

/** A spoken control, or null. `text` is the utterance, lower case, without the agent's name. */
export function controlOf(text) {
  const t = String(text ?? "").toLowerCase().replace(/[.!?,]+$/g, "").replace(/^(?:please|now|okay|ok)[ ,]+/, "").replace(/[ ,]+please$/, "").trim();
  for (const [re, out] of SPOKEN) {
    const m = re.exec(t);
    if (!m) continue;
    if (out) return out;
    const level = m[1].replace("extra high", "xhigh").replace(/^max.*/, "max");
    return { what: "effort", value: level };
  }
  return null;
}

/** Typed slash commands, Claude Code style. */
export const SLASH_HELP = [
  ["/plan", "plan mode: plans first, you approve"],
  ["/auto", "auto mode: works, asks only for risky steps"],
  ["/edits", "accept edits: edits files without asking"],
  ["/ask", "ask every time"],
  ["/effort low|medium|high|xhigh|max", "how hard it thinks"],
  ["/model fable|opus|sonnet|haiku", "the model it runs on"],
  ["/clear", "start a new conversation"],
  ["/compact", "summarise the conversation to make room"],
  ["/undo", "undo its last change"],
  ["/stop", "stop what it is doing"],
  ["/btw <question>", "a side question while it works"],
  ["/help", "this list"],
];

/**
 * A typed line starting with "/": { what, value } for a control, { action, value } for the page's
 * own (model, undo, stop, btw, help), or { error } for an unknown command. Not a command: null.
 */
export function slashOf(line) {
  const m = /^\/(\w+)\s*(.*)$/.exec(String(line ?? "").trim());
  if (!m) return null;
  const [cmd, arg] = [m[1].toLowerCase(), m[2].trim()];
  switch (cmd) {
    case "plan": return { what: "mode", value: "plan" };
    case "auto": return { what: "mode", value: "auto" };
    case "edits": case "acceptedits": return { what: "mode", value: "acceptEdits" };
    case "ask": case "manual": return { what: "mode", value: "manual" };
    case "mode": return arg ? { what: "mode", value: arg } : { error: "Which mode? /plan, /auto, /edits or /ask." };
    case "effort": case "think": return { what: "effort", value: arg || "default" };
    case "clear": case "new": case "reset": return { what: "clear" };
    case "compact": return { what: "compact" };
    case "model": return arg ? { action: "model", value: arg.toLowerCase() } : { error: "Which model? /model fable, opus, sonnet or haiku." };
    case "undo": case "rewind": return { action: "undo" };
    case "stop": case "cancel": return { action: "stop" };
    case "btw": return arg ? { action: "btw", value: arg } : { error: "Ask something after /btw." };
    case "help": case "commands": return { action: "help" };
  }
  return { error: `/${cmd} isn't a command here. Type /help for the list.` };
}
