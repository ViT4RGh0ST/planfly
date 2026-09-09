import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

/**
 * That the plugin manifest still says what openclaw insists on.
 *
 * `configSchema` was removed on the grounds that the plugin reads no
 * configuration any more — which was true and beside the point. openclaw
 * validates the manifest before it loads anything, refuses one without that key,
 * and the gateway went into a restart loop: «plugin manifest requires
 * configSchema», with Telegram down until somebody read the logs.
 *
 * Nothing here could have caught it. The plugin is JSON and JavaScript that this
 * project never runs — it runs inside another program, on another machine — so
 * `tsc`, the lint and 592 tests all stayed green while the manifest was
 * unloadable. This file is the cheapest possible stand-in for that missing
 * feedback: it does not prove the gateway will start, only that the keys it
 * refused to start without are still there.
 */
const MANIFEST = join(process.cwd(), "openclaw/planfly-plugin/openclaw.plugin.json");

describe("the openclaw plugin manifest", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;

  it("carries every key openclaw refuses to load without", () => {
    for (const key of ["id", "name", "description", "configSchema"]) {
      assert.ok(
        manifest[key] !== undefined,
        `openclaw validates the manifest before loading and rejects one with no ${key}. ` +
          "It took the gateway down once; an empty object is a valid answer, absent is not.",
      );
    }
  });

  it("declares the skill it exists to mount, and that skill is there", () => {
    /*
     * The whole reason this directory survived the move to MCP. `contracts.tools`
     * being empty is the other half of the same decision: a tool registered here
     * would be a second way to write the ledger.
     */
    const skills = manifest.skills as string[] | undefined;
    assert.ok(skills?.length, "a plugin with no tools and no skills mounts nothing at all");

    for (const relative of skills) {
      const path = join(dirname(MANIFEST), relative);
      assert.ok(existsSync(path), `the manifest points at ${relative}, which is not there`);
    }

    const tools = (manifest.contracts as { tools?: unknown[] } | undefined)?.tools;
    assert.deepEqual(
      tools,
      [],
      "the tools come from the MCP server now. One registered here would be a second " +
        "write path, and two do not conflict noisily: both succeed, and one purchase " +
        "is recorded twice.",
    );
  });
});
