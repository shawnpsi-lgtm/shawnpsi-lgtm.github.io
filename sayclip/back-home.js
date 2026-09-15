// Pages-only. Lives in this repo; `npm run export:pages` in the Sayclip app preserves it.
(function () {
  var localApi = "http://127.0.0.1:43147";
  var onStaticLocal =
    (location.hostname === "localhost" || location.hostname === "127.0.0.1") &&
    location.port !== "43147";

  function rewriteClipUrl(value) {
    try {
      var url = new URL(value, location.origin);
      if (!url.pathname.includes("/api/clip")) return value;
      if (!onStaticLocal) return value;
      return localApi + url.pathname + url.search;
    } catch {
      return value;
    }
  }

  if (onStaticLocal && !window.fetch.__sayclipClip) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (typeof input === "string") {
        input = rewriteClipUrl(input);
      } else if (input && typeof input.url === "string") {
        var next = rewriteClipUrl(input.url);
        if (next !== input.url) input = new Request(next, input);
      }
      return origFetch(input, init);
    };
    window.fetch.__sayclipClip = true;

    document.addEventListener("dragstart", function (event) {
      var raw = event.dataTransfer.getData("DownloadURL");
      if (!raw || !raw.startsWith("audio/wav:")) return;
      var rest = raw.slice("audio/wav:".length);
      var split = rest.indexOf(":http");
      if (split < 0) return;
      var name = rest.slice(0, split);
      var href = rewriteClipUrl(rest.slice(split + 1));
      event.dataTransfer.setData("DownloadURL", "audio/wav:" + name + ":" + href);
    });
  }

  function addHome() {
    var nav = document.querySelector(".mac-menubar-links");
    if (!nav || nav.querySelector("[data-home]")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("data-home", "");
    b.textContent = "Home";
    b.onclick = function () {
      location.assign("/");
    };
    nav.insertBefore(b, nav.firstChild);
  }
  addHome();
  new MutationObserver(addHome).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
