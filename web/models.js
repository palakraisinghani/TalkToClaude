// The Claude models an agent can run on: one list for the server and the page.
//
// The value given to Claude Code is the alias ("sonnet"), so it follows your provider (Anthropic,
// Vertex, Bedrock) and its own naming; the full name and id are what the lead is shown. What an
// agent is really running is reported back by Claude Code with each reply (`running` in the
// roster) and shown too, since a provider can serve an alias under a longer id.

export const MODELS = [
  { alias: "fable", name: "Fable 5.1", id: "claude-fable-5-1" },
  { alias: "opus", name: "Opus 5.5", id: "claude-opus-5-5" },
  { alias: "sonnet", name: "Sonnet 5.5", id: "claude-sonnet-5-5" },
  { alias: "haiku", name: "Haiku 5.5", id: "claude-haiku-5-5" },
];

/** What an agent runs on when none is chosen. */
export const DEFAULT_MODEL = "sonnet";

const known = (m) => MODELS.find((x) => x.alias === m || x.id === m || (m && m.startsWith(x.id)));

/** "Sonnet 5.5 (claude-sonnet-5-5)" for an alias or id; anything else as it is. */
export function modelLabel(m) {
  const k = known(m);
  return k ? `${k.name} (${k.id})` : m;
}

/** "Sonnet 5.5" for an alias or id; anything else as it is. */
export function modelShort(m) {
  return known(m)?.name ?? m;
}

/** The choices for a picker: the default first, with the model it stands for in brackets. */
export function modelChoices(current = "") {
  const list = [["", `Default (${modelShort(DEFAULT_MODEL)})`], ...MODELS.map((m) => [m.alias, modelLabel(m.alias)])];
  if (current && !list.some(([v]) => v === current)) list.push([current, modelLabel(current)]);
  return list;
}
