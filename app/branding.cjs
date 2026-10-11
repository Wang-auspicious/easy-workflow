const fs = require('node:fs');
const path = require('node:path');

const PRODUCT_NAME = 'Easy Workflow';
// These names only locate existing user data. They are never used as product labels.
const LEGACY_PRODUCT_NAME = 'Pi Factory';
const PROJECT_SLUG = 'vislexicon-curation';
const hasJournal = directory => fs.existsSync(path.join(directory, 'journal.db'));
const hasProfile = directory => ['desktop.json', 'browser.json', 'Partitions', 'workspace/journal.db'].some(file => fs.existsSync(path.join(directory, file)));

function userDataDirectory({ appData, explicitProfile }) {
  if (explicitProfile) return path.resolve(explicitProfile);
  const current = path.join(appData, PRODUCT_NAME), legacy = path.join(appData, LEGACY_PRODUCT_NAME);
  // Reusing an existing profile preserves encrypted cookies and live Chromium stores.
  // Fresh installations use the new name; an empty failed-start folder is not a migration.
  if (hasProfile(current)) return current;
  if (hasProfile(legacy)) return legacy;
  return current;
}

function projectLocations({ documents, userData, explicitProfile }) {
  const base = explicitProfile ? path.join(userData, 'projects') : path.join(documents, PRODUCT_NAME, 'Projects');
  return { defaultProject: path.join(base, PROJECT_SLUG), newProjectBase: base, legacyProject: explicitProfile ? null : path.join(documents, LEGACY_PRODUCT_NAME, 'Projects', PROJECT_SLUG) };
}

function activeProjectDirectory(locations, saved = {}, explicitProject) {
  if (explicitProject) return path.resolve(explicitProject);
  if (saved.activeProject) return saved.activeProject;
  if (hasJournal(locations.defaultProject)) return locations.defaultProject;
  if (locations.legacyProject && hasJournal(locations.legacyProject)) return locations.legacyProject;
  return locations.defaultProject;
}

function recentProjectDirectories(locations, saved = {}, active) {
  const legacy = locations.legacyProject && hasJournal(locations.legacyProject) ? [locations.legacyProject] : [];
  return [...new Set([active, ...legacy, ...(saved.recentProjects ?? [])].filter(Boolean))].slice(0, 8);
}

module.exports = { PRODUCT_NAME, userDataDirectory, projectLocations, activeProjectDirectory, recentProjectDirectories };
