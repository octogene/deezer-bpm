(function () {
  "use strict";

  const runtime =
    typeof browser !== "undefined" ? browser.runtime : chrome.runtime;
  const tabs = typeof browser !== "undefined" ? browser.tabs : chrome.tabs;

  runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    if (reason !== "update") return;

    const current = runtime.getManifest().version;

    // Only open the page if the major or minor version changed
    const prev = (previousVersion ?? "").split(".");
    const curr = current.split(".");
    if (prev[0] === curr[0] && prev[1] === curr[1]) return;

    tabs.create({ url: runtime.getURL("docs/whatsnew/index.html") });
  });
})();
