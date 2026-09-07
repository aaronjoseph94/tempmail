// Runs before first paint so the page never flashes the wrong theme.
(function () {
  try {
    var saved = localStorage.getItem("theme");
    var theme = saved === "light" || saved === "dark"
      ? saved
      : (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.dataset.theme = theme;

    // The accent preset, applied here for the same reason as the theme: set
    // after first paint it would flash the default colour first.
    var scheme = localStorage.getItem("scheme");
    if (scheme && /^[a-z]{3,10}$/.test(scheme) && scheme !== "mono") {
      document.documentElement.dataset.scheme = scheme;
    }
  } catch (e) {
    /* storage blocked: the default (dark, mono) styles apply */
  }
})();
