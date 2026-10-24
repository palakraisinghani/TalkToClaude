import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * One shared access code, checked on the WebSocket handshake.
 *
 * Buddy runs Claude with permission to edit files and run commands, so reaching it is as good as
 * a shell on this machine. Everything that can act sits behind the socket, which makes the
 * handshake the only boundary that has to hold: the page and its scripts are not secrets.
 *
 * The code is never put in a URL. It travels as a WebSocket subprotocol, so it stays out of
 * browser history, out of referrers, and out of any proxy's access log.
 */
/** Wrong tries allowed before a source has to wait. */
const ATTEMPTS = 10;

export class Auth {
  readonly code: string;
  readonly generated: boolean;
  private expected: Buffer;
  private failures = new Map<string, { n: number; until: number }>();

  constructor(code = process.env.BUDDY_TOKEN) {
    this.generated = !code;
    // short enough to read out, long enough that guessing is hopeless
    this.code = code || randomBytes(5).toString("hex");
    // compared without case, so a code typed on a phone keyboard still matches one set in caps
    this.expected = Buffer.from(this.code.toLowerCase());
  }

  /** Constant-time comparison, so a wrong code gives nothing away by how long it took. */
  check(offered: string | undefined): boolean {
    if (!offered) return false;
    const got = Buffer.from(offered.toLowerCase());
    return got.length === this.expected.length && timingSafeEqual(got, this.expected);
  }

  /**
   * Back off a source that keeps guessing. The allowance is deliberately generous: the code is
   * ten hex characters, so guessing it needs on the order of a trillion tries and a slow trickle
   * achieves nothing, while a person mistyping their own code should not be locked out of their
   * own machine. The limit is here to stop a flood, not to punish a typo.
   */
  blocked(from: string): boolean {
    const f = this.failures.get(from);
    return !!f && f.n >= ATTEMPTS && Date.now() < f.until;
  }

  failed(from: string): void {
    const f = this.failures.get(from) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= ATTEMPTS) f.until = Date.now() + Math.min(15_000 * (f.n - ATTEMPTS + 1), 5 * 60_000);
    this.failures.set(from, f);
  }

  /** How long this source must wait, in seconds, or 0 if it may try now. */
  waitSeconds(from: string): number {
    const f = this.failures.get(from);
    if (!f || !this.blocked(from)) return 0;
    return Math.ceil((f.until - Date.now()) / 1000);
  }

  passed(from: string): void {
    this.failures.delete(from);
  }
}
