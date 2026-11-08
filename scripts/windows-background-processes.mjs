import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

/** Recording-only preload. Keep framework CLI probes from opening console windows.
 * Does not change executable, arguments, environment, stdio or process lifetime.
 * An explicitly requested windowsHide:false is preserved for interactive tools.
 */
export function installHiddenWindowsDefaults(api, platform) {
  if (platform !== "win32") return;
  const marker = Symbol.for("scientific-debate.hidden-child-windows");
  if (api[marker]) return;
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
    const original = api[name];
    api[name] = function (...args) {
      const acceptsArgv = name !== "exec" && name !== "execSync";
      const index = acceptsArgv && Array.isArray(args[1]) ? 2 : 1;
      const options = args[index];
      const hidden = { windowsHide: true, ...(options && typeof options === "object" ? options : {}) };
      if (typeof options === "function") args.splice(index, 0, hidden);
      else args[index] = hidden;
      return Reflect.apply(original, this, args);
    };
  }
  api[marker] = true;
}

installHiddenWindowsDefaults(childProcess, process.platform);
syncBuiltinESMExports();
