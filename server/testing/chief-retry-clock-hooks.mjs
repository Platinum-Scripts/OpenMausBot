import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.OMB_DATA_DIR;
if (!dir || dir !== process.env.HOME || !dir.includes("omb-restartable-")) {
  throw new Error("Chief retry clock requires an isolated restartable fixture");
}
const notices = new URL("../host/chief-notices.ts", import.meta.url).href;
const incidents = new URL("../incidents.ts", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== notices && url !== incidents) return result;
    const baseline = join(dir, "chief-baseline.ts");
    let source = url === notices && existsSync(baseline) ? readFileSync(baseline, "utf8") : String(result.source);
    source = source.replaceAll("Date.now()", "chiefFixtureNow()");
    return { ...result, source: `import { readFileSync as readChiefClock } from "node:fs";
      function chiefFixtureNow() { try { return Date.now() + Number(readChiefClock(${JSON.stringify(join(dir, "chief-clock"))}, "utf8")); } catch { return Date.now(); } }
      ${source}` };
  },
});
