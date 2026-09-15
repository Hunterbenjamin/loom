// macOS shows the running bundle's CFBundleName in the menu bar and Dock, so the dev app reads
// "Electron" whatever the app sets at runtime. Rename the dev copy of Electron.app after every
// install. The binary is only linker-signed, so its Info.plist is not sealed by the signature.
import { readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

if (process.platform === "darwin") {
  let executable;
  try {
    executable = createRequire(import.meta.url)("electron");
  } catch {
    process.exit(0); // Electron is not installed yet; the next install renames it.
  }
  const contents = join(executable, "..", "..");
  const plist = join(contents, "Info.plist");
  const before = readFileSync(plist, "utf8");
  const after = before.replace(
    /(<key>(?:CFBundleName|CFBundleDisplayName)<\/key>\s*<string>)Electron(<\/string>)/g,
    "$1Loom$2",
  );
  if (after !== before) {
    // Replace the file rather than editing it in place, so a hard link can never carry the change.
    unlinkSync(plist);
    writeFileSync(plist, after);
    const now = new Date();
    utimesSync(join(contents, ".."), now, now); // Nudge Launch Services to re-read the bundle.
  }
}
