// Runs before first paint so the page never flashes the wrong theme.
(function () {
  try {
    var saved = localStorage.getItem("theme");
    var theme = saved === "light" || saved === "dark"
      ? saved
      : (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    document.documentElement.dataset.theme = theme;
  } catch (e) {
    /* storage blocked: the default (dark) styles apply */
  }
})();
