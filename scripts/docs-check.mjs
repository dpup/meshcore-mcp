// Fail if docs/api.md isn't regenerated & committed. Run after `typedoc` +
// postdocs (see the "docs:check" script). Uses `git status --porcelain` for
// portability (some sandboxed gits reject `git diff --exit-status`).
import { execSync } from "node:child_process";

const status = execSync("git status --porcelain -- docs/api.md", {
  encoding: "utf8",
}).trim();

if (status) {
  console.error(
    "docs/api.md is out of date or uncommitted — run `bun run docs` and commit it.\n" +
      status,
  );
  process.exit(1);
}
console.log("docs/api.md is up to date.");
