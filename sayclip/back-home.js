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

  // Same Tahoe Vimeo as the homepage hero. Sayclip keeps a still on top of the
  // iframe (z-index 1 / opacity 0); homepage paints the iframe on top and
  // fades the poster on play.
  function showHomeVideo(hidePoster) {
    var s = document.getElementById("sayclip-home-bg");
    if (!s) {
      s = document.createElement("style");
      s.id = "sayclip-home-bg";
      document.head.appendChild(s);
    }
    s.textContent =
      ".mac-wallpaper img{z-index:0!important" +
      (hidePoster ? ";opacity:0!important" : "") +
      "}" +
      ".mac-wallpaper iframe{opacity:1!important;z-index:0!important}";
  }

  function wireHomeVideo() {
    var iframe = document.querySelector(".mac-wallpaper iframe");
    if (!iframe || window.__sayclipBgWired) return;
    window.__sayclipBgWired = true;
    showHomeVideo(false);

    window.addEventListener("message", function (event) {
      if (!String(event.origin).includes("vimeo.com")) return;
      var data = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!data) return;
      if (data.event === "ready" && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          JSON.stringify({ method: "addEventListener", value: "play" }),
          "*"
        );
        iframe.contentWindow.postMessage(JSON.stringify({ method: "play" }), "*");
      }
      if (data.event === "play") showHomeVideo(true);
    });

    setTimeout(function () {
      showHomeVideo(true);
    }, 2500);
  }

  function onDom() {
    addHome();
    wireHomeVideo();
  }
  onDom();
  new MutationObserver(onDom).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
