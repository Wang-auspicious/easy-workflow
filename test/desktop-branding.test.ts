import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const { PRODUCT_NAME, userDataDirectory, projectLocations, activeProjectDirectory, recentProjectDirectories } = createRequire(import.meta.url)("../app/branding.cjs");

test("canonical and legacy workflow tools render the same Chinese labels", async () => {
  const { renderTool } = await import(new URL("../ui/src/vendor/pi-web-ui/tools/index.js", import.meta.url).href);
  for (const name of ["easy_workflow_call", "h2_call"]) {
    assert.ok(renderTool(name, { name: "status" }, undefined, true).content.values.includes("查看运行状态"), name);
    assert.ok(renderTool(name, { name: "read_report" }, undefined, true).content.values.includes("读取报告"), name);
    assert.ok(renderTool(name, {}, undefined, true).content.values.includes("调用 Easy Workflow"), name);
    assert.ok(renderTool(name, { name: "custom_capability" }, undefined, true).content.values.includes("调用 Easy Workflow · custom_capability"), name);
  }
  for (const name of ["easy_workflow_help", "h2_help"]) {
    assert.ok(renderTool(name, { name: "status" }, undefined, true).content.values.includes("了解能力 · 查看运行状态"), name);
    assert.ok(renderTool(name, {}, undefined, true).content.values.includes("了解能力"), name);
  }
});

test("Easy Workflow uses its new defaults while preserving legacy profiles and project entry points", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easy-workflow-branding-"));
  const appData = path.join(root, "appData"), documents = path.join(root, "Documents");
  const currentProfile = path.join(appData, "Easy Workflow"), legacyProfile = path.join(appData, "Pi Factory");
  const currentProject = path.join(documents, "Easy Workflow", "Projects", "vislexicon-curation");
  const legacyProject = path.join(documents, "Pi Factory", "Projects", "vislexicon-curation");
  const saved = { activeProject: legacyProject, recentProjects: [path.join(root, "other-project")] };
  try {
    assert.equal(PRODUCT_NAME, "Easy Workflow");
    assert.equal(userDataDirectory({ appData }), currentProfile, "a fresh installation uses the new product name");
    const locations = projectLocations({ documents, userData: currentProfile });
    assert.equal(locations.defaultProject, currentProject);
    assert.equal(locations.newProjectBase, path.join(documents, "Easy Workflow", "Projects"));
    assert.equal(activeProjectDirectory(locations), currentProject);

    fs.mkdirSync(legacyProfile, { recursive: true });
    const preferences = JSON.stringify(saved), bookmarks = '{"bookmarks":[{"title":"kept","url":"https://example.test"}]}';
    fs.writeFileSync(path.join(legacyProfile, "desktop.json"), preferences);
    fs.writeFileSync(path.join(legacyProfile, "browser.json"), bookmarks);
    fs.mkdirSync(path.join(legacyProfile, "Partitions", "h2-browser"), { recursive: true });
    fs.writeFileSync(path.join(legacyProfile, "Partitions", "h2-browser", "Cookies"), "encrypted-session-fixture");
    fs.mkdirSync(currentProfile, { recursive: true });
    assert.equal(userDataDirectory({ appData }), legacyProfile, "an empty new profile does not hide an existing browser session");

    fs.mkdirSync(path.join(legacyProject, "published"), { recursive: true });
    fs.writeFileSync(path.join(legacyProject, "journal.db"), "legacy-journal-fixture");
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(legacyProject, "published", `${i}.json`), JSON.stringify({ entryId: `legacy-${i}` }));
    assert.equal(activeProjectDirectory(locations), legacyProject, "the migrated five-entry project remains the initial entry point");
    assert.equal(activeProjectDirectory(locations, saved), legacyProject, "saved project paths remain unchanged");
    assert.equal(recentProjectDirectories(locations, saved, legacyProject)[0], legacyProject);
    assert.equal(fs.readdirSync(path.join(legacyProject, "published")).length, 5);
    assert.equal(fs.readFileSync(path.join(legacyProfile, "desktop.json"), "utf8"), preferences);
    assert.equal(fs.readFileSync(path.join(legacyProfile, "browser.json"), "utf8"), bookmarks);
    assert.equal(fs.readFileSync(path.join(legacyProfile, "Partitions", "h2-browser", "Cookies"), "utf8"), "encrypted-session-fixture");
    assert.equal(fs.existsSync(currentProject), false, "path discovery never copies, moves or replaces a project");

    fs.writeFileSync(path.join(currentProfile, "desktop.json"), JSON.stringify({ activeProject: currentProject }));
    assert.equal(userDataDirectory({ appData }), currentProfile, "a configured new profile remains authoritative");
    fs.mkdirSync(currentProject, { recursive: true }); fs.writeFileSync(path.join(currentProject, "journal.db"), "new-journal");
    assert.equal(activeProjectDirectory(locations), currentProject);
    const recents = recentProjectDirectories(locations, { recentProjects: Array.from({ length: 10 }, (_, i) => path.join(root, `recent-${i}`)) }, currentProject);
    assert.equal(recents.length, 8); assert.ok(recents.includes(legacyProject), "the old project remains discoverable after opening new projects");

    const testProfile = path.join(root, "isolated-profile");
    assert.equal(userDataDirectory({ appData, explicitProfile: testProfile }), testProfile);
    const isolated = projectLocations({ documents, userData: testProfile, explicitProfile: testProfile });
    assert.equal(activeProjectDirectory(isolated), path.join(testProfile, "projects", "vislexicon-curation"));
    assert.equal(isolated.legacyProject, null, "test profiles never silently open the user's project");
    assert.equal(activeProjectDirectory(locations, saved, path.join(root, "explicit-project")), path.join(root, "explicit-project"));
  } finally { assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()), "easy-workflow-branding-"))); fs.rmSync(root, { recursive: true, force: true }); }
});
