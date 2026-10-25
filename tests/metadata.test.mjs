import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { pluginVersion } from "../shared/version.ts";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const manifest = readJson("../paseo-plugin.json");
const packageJson = readJson("../package.json");
const lockfile = readJson("../package-lock.json");

test("plugin manifest provides a non-empty description for Settings", () => {
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.trim().length > 0);
});

test("settings and lockfile versions match the package version", () => {
  assert.equal(pluginVersion, packageJson.version);
  assert.equal(lockfile.version, packageJson.version);
  assert.equal(lockfile.packages[""].version, packageJson.version);
});
