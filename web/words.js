// Words too common to ever stand for an agent.
//
// When the lead teaches how they say a name, the recognizer's spelling of each try is kept as an
// extra name the agent answers to. But the recognizer often turns a short name into an everyday
// word — "Juno" into "do", "Wren" into "then", "Ada" into "either" — and an agent answering to
// "do" would take over every "do the tests". So these are never kept as names, from either side.

export const COMMON_WORDS = new Set(`
a about after again all also am an and any are as at be been before being but by can could did do does doing done
down each either even every few for from get go going gone good got had has have he her here hers him his how i
if in into is it its just know let like made make many may me might mine more most much must my neither new next
no nor not now of off ok okay on once one only or other our out over own please put re right said same say see
she should so some still such sure take than thank thanks that the their them then there these they thing think
this those though through to too two under until up us very want was way we well were what when where which while
who why will with would yeah yes yet you your yours
hi hey hello bye oh um uh ah hmm huh wow yo
run stop wait pause next skip later done tell ask allow deny park stand status repeat shorter fine cool great
four five six seven eight nine ten zero first last back over open close new test tests file files fix
`.trim().split(/\s+/));

/** Can this spelling be kept as an extra name for an agent? */
export function usableAlias(word) {
  const w = String(word ?? "").trim().toLowerCase();
  return /^[a-z']{2,20}$/.test(w) && !COMMON_WORDS.has(w);
}
