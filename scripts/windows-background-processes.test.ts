import { expect, it, vi } from "vitest";
import { installHiddenWindowsDefaults } from "./windows-background-processes.mjs";

function fakeApi() {
  return Object.fromEntries(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"].map(name => [name, vi.fn()]));
}
it("hides Windows probes without changing argv, stdio, environment or callbacks", () => {
  const api = fakeApi(); const originals = { ...api };
  const callback = vi.fn(); const options = { stdio: "pipe", env: { FIXTURE: "test" } };
  installHiddenWindowsDefaults(api, "win32");
  api.spawn!("where.exe", ["node"], options);
  expect(originals.spawn).toHaveBeenCalledWith("where.exe", ["node"], { ...options, windowsHide: true });
  api.execFile!("git", ["--version"], callback);
  expect(originals.execFile).toHaveBeenCalledWith("git", ["--version"], { windowsHide: true }, callback);
  api.exec!("echo fixture", callback);
  expect(originals.exec).toHaveBeenCalledWith("echo fixture", { windowsHide: true }, callback);
  api.spawnSync!("node");
  expect(originals.spawnSync).toHaveBeenCalledWith("node", { windowsHide: true });
  api.execFileSync!("git", ["--version"]);
  expect(originals.execFileSync).toHaveBeenCalledWith("git", ["--version"], { windowsHide: true });
  api.execSync!("echo fixture", options);
  expect(originals.execSync).toHaveBeenCalledWith("echo fixture", { ...options, windowsHide: true });
  expect(options).not.toHaveProperty("windowsHide");
});
it("preserves explicit visible tools, does not stack wrappers, and leaves other OSes alone", () => {
  const api = fakeApi(); const original = api.spawn;
  installHiddenWindowsDefaults(api, "linux"); expect(api.spawn).toBe(original);
  installHiddenWindowsDefaults(api, "win32"); const wrapped = api.spawn;
  installHiddenWindowsDefaults(api, "win32"); expect(api.spawn).toBe(wrapped);
  api.spawn!("interactive.exe", [], { windowsHide: false });
  expect(original).toHaveBeenCalledWith("interactive.exe", [], { windowsHide: false });
});
