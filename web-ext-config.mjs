export default {
  verbose: true,
  ignoreFiles: [
    "screenshots/",
    // Ignore the GitHub Pages site but keep docs/whatsnew/, which the
    // extension opens via runtime.getURL after an update.
    "docs/index.html",
    "docs/*.png",
    "docs/*.jpg",
    "README.md",
    "AGENT.md",
    "CHANGELOG.md",
    "REVIEW.md",
    // Backend sync service — deployed to Cloudflare separately, not shipped
    // inside the extension package.
    "worker/",
    "scripts/",
    "tests/",
    ".github/",
    ".idea/",
    "web-ext-config.mjs",
    "eslint.config.mjs",
    "package.json",
    "package-lock.json",
    // Repo-level notes and tooling, not extension resources. README.md is
    // listed above; docs/whatsnew/ is deliberately kept.
    "*.md",
    "cliff.toml",
  ],
};
