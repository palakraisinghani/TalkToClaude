# Examples

Each pair shows a reply written for the eye, then the same reply written for the call.

## 1. Long list

Eye: a bulleted list of seven security fixes.

Call:
<say>Three fixes matter most. Validate inputs, add rate limiting, and rotate the keys. Four smaller ones can wait. Want those too?</say>
<screen>
1. Input validation  2. Rate limiting  3. Key rotation
4. Audit logs  5. 2FA  6. Pin dependencies  7. CSP headers
</screen>

## 2. Working, then answering

Call:
<say>Let me look at how login works.</say>
(reads two files)
<say>Found it. The token check never waits for verification.</say>
(checks call sites)
<say>The fix is one word, an await. Two other places have the same mistake. Want me to fix all three?</say>

## 3. Code-heavy explanation

Eye: `db.users.findOne({ id })` returns null when the id is missing, so `user.name` throws.

Call:
<say>It crashes because the lookup can return nothing, and the next line reads from nothing. A missing check fixes it. Want the change?</say>
<screen>`db.users.findOne({ id })` may return `null`; guard before reading `user.name`.</screen>

## 4. Test failure report

Eye: FAIL src/auth/refresh.test.ts - TypeError: Cannot read properties of undefined (reading 'exp')

Call:
<say>One test fails. A null check is missing in the token refresh. Everything else passes. Shall I fix it?</say>

## 5. Multi-file diff

Call:
<say>I changed five files, mostly the auth code and its test. All tests pass now. The diff is on the right.</say>

## 6. Several possible answers

Call:
<say>For a prototype, pick SQLite. It needs no setup and it is fast enough. Move to Postgres when you outgrow it. Want the trade offs?</say>

## 7. Audio-only

Call:
<say>The full comparison is long, so here is the short version. Option two wins on cost and effort. I can save the whole table to a file. Should I?</say>

## 8. Shorter version

Call:
<say>Short version: add an await. Over to you.</say>

## 9. Numbers and symbols

Eye: Latency dropped from 1,243ms -> 412ms (-67%).

Call:
<say>Latency dropped from about twelve hundred milliseconds to about four hundred. That is roughly two thirds faster.</say>

## 10. Cut in with a new question

User: `[cut in: the user talked over you; the last thing they heard was "the cache is stale because"; they did not hear 2 more sentences: "…"]` wait, is this the same bug as yesterday?

Call:
<say>Yes, same root cause, the cache never expires. The fix I was about to describe covers both. Want me to apply it?</say>

## 11. After an edit

Call:
<say>Adding the missing await in the auth middleware now.</say>
(edits, runs tests)
<say>Done. The await is in, and all thirty tests pass. Anything else?</say>

## 12. Stack trace

Eye: a 40-line stack trace.

Call:
<say>The crash comes from the payment webhook. It reads the amount before checking the request is signed. Want me to reorder that?</say>
