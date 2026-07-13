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
    ".github/",
    ".idea/",
    "web-ext-config.mjs",
    "eslint.config.mjs",
    "package.json",
    "package-lock.json",
  ],
};
