import { execFile } from "node:child_process";
import { createServer as createRawServer, type Server as NetServer } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Every address this machine can be reached on, for the certificate and the printed URL. */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

/**
 * A self-signed certificate for this machine, made once and reused.
 *
 * The microphone needs a secure context: `getUserMedia` is refused over plain HTTP anywhere but
 * localhost, so serving the page to a phone means serving it over TLS. A self-signed certificate
 * does that, at the cost of a warning to click through once per device. `mkcert` produces one
 * the browser trusts outright, if it is available.
 */
export async function ensureCert(dir: string): Promise<{ key: Buffer; cert: Buffer; path: string }> {
  await mkdir(dir, { recursive: true });
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
    return { key, cert, path: certPath };
  } catch {
    // not made yet, or unreadable: make a new one
  }
  const ips = localAddresses();
  const san = ["DNS:localhost", "IP:127.0.0.1", ...ips.map((a) => `IP:${a}`)].join(",");
  try {
    await run("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", keyPath, "-out", certPath,
      "-days", "365", "-subj", "/CN=Buddy",
      "-addext", `subjectAltName=${san}`,
      "-addext", "basicConstraints=critical,CA:FALSE",
    ]);
  } catch (e: any) {
    throw new Error(`Could not make a certificate with openssl: ${e.message}`);
  }
  await writeFile(join(dir, "README.txt"),
    "Self-signed certificate for serving Buddy over TLS, so the microphone works away from\n" +
    "localhost. Delete these files to have a new one made. For a certificate your browser\n" +
    "trusts without a warning: brew install mkcert && mkcert -install && mkcert localhost " + ips.join(" ") + "\n" +
    "then replace key.pem and cert.pem with what it produces.\n");
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  return { key, cert, path: certPath };
}

/**
 * Serve TLS and plain HTTP on one port.
 *
 * Once Buddy is on https, an http link to the same port fails with nothing a browser can explain
 * — and that stale http link is sitting in everyone's history. So the first byte of each
 * connection is peeked at: 0x16 is the start of a TLS handshake and goes to the secure server,
 * anything else is a plain request and goes to one that redirects it. Nothing is served
 * insecurely; the only answer over http is "use https".
 */
export function multiplex(secure: NetServer, plain: NetServer): NetServer {
  return createRawServer((socket) => {
    socket.once("data", (first: Buffer) => {
      socket.pause();
      socket.unshift(first);
      (first[0] === 0x16 ? secure : plain).emit("connection", socket);
      process.nextTick(() => socket.resume());
    });
    socket.on("error", () => socket.destroy());
  });
}
