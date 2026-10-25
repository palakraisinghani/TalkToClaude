import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Let the lead choose a folder in their own file manager.
 *
 * A web page cannot learn a folder's real path — the browser's pickers hand over contents, never
 * locations — but the server runs on the lead's own machine, so it can open the system's folder
 * chooser itself: Finder's on macOS, zenity's on Linux. Returns the chosen path, or null if the
 * lead cancelled.
 */
export async function pickFolder(start: string, prompt = "Choose the folder for this agent to work in"): Promise<string | null> {
  const quote = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    if (process.platform === "darwin") {
      // System Events is brought forward first, so the chooser opens in front of the browser
      const { stdout } = await run("osascript", [
        "-e", 'tell application "System Events"',
        "-e", "activate",
        "-e", `set f to choose folder with prompt "${quote(prompt)}" default location (POSIX file "${quote(start)}")`,
        "-e", "end tell",
        "-e", "POSIX path of f",
      ], { timeout: 5 * 60_000 });
      return stdout.trim().replace(/\/$/, "") || null;
    }
    const { stdout } = await run("zenity", ["--file-selection", "--directory", `--title=${prompt}`, `--filename=${start}/`], { timeout: 5 * 60_000 });
    return stdout.trim() || null;
  } catch (e: any) {
    // osascript reports a cancel as error -128, zenity as exit status 1: both just mean no folder
    if (/-128|User canceled/i.test(String(e.stderr ?? e.message)) || e.code === 1) return null;
    if (e.code === "ENOENT") throw new Error("There is no folder chooser on this machine; type the path instead.");
    throw new Error(`The folder chooser failed: ${String(e.stderr || e.message).trim().split("\n").pop()}`);
  }
}
