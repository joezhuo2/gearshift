#!/usr/bin/env node
const { spawnSync } = require("node:child_process");

const REPO = "joezhuo2/gearshift";
const PLUGIN = "gearshift@gearshift";

const cmd = process.argv[2] || "install";
const steps = {
  install: [
    ["plugin", "marketplace", "add", REPO],
    ["plugin", "install", PLUGIN],
  ],
  update: [
    ["plugin", "marketplace", "update", "gearshift"],
    ["plugin", "update", PLUGIN],
  ],
  uninstall: [["plugin", "uninstall", PLUGIN]],
}[cmd];

if (!steps) {
  console.error("Usage: npx github:joezhuo2/gearshift [install|update|uninstall]");
  process.exit(1);
}

for (const args of steps) {
  console.log(`> claude ${args.join(" ")}`);
  const r = spawnSync("claude", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.error || r.status !== 0) {
    console.error(
      r.error && r.error.code === "ENOENT"
        ? "Claude Code CLI not found on PATH. Install it first, or use the manual steps in the README."
        : `Step failed: claude ${args.join(" ")}`
    );
    process.exit(r.status || 1);
  }
}

console.log(cmd === "uninstall" ? "gearshift removed." : "Done. Restart Claude Code (or start a new session) so the mod loads.");
