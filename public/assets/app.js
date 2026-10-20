(function () {
  "use strict";

  document.documentElement.classList.add("js");

  var STORAGE_KEY = "understory:bookmarks:v1";

  function readBookmarks() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
    } catch (error) {
      return [];
    }
  }

  function isRecord(value) {
    return (
      value &&
      typeof value === "object" &&
      typeof value.slug === "string" &&
      typeof value.headline === "string"
    );
  }

  function writeBookmarks(records) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
      return true;
    } catch (error) {
      return false;
    }
  }

  function isSaved(slug) {
    return readBookmarks().some(function (record) {
      return record.slug === slug;
    });
  }

  function addBookmark(record) {
    var records = readBookmarks().filter(function (item) {
      return item.slug !== record.slug;
    });
    records.unshift(Object.assign({}, record, { savedAt: Date.now() }));
    return writeBookmarks(records);
  }

  function removeBookmark(slug) {
    return writeBookmarks(
      readBookmarks().filter(function (record) {
        return record.slug !== slug;
      }),
    );
  }

  function setButtonState(button, saved) {
    button.setAttribute("aria-pressed", saved ? "true" : "false");
    button.classList.toggle("is-saved", saved);
    var label = button.querySelector(".save-button__label");
    if (label) label.textContent = saved ? "Saved" : "Save";
  }

  function reportBookmarkWrite(success, action) {
    var status = document.getElementById("bookmark-status");
    if (status) {
      status.textContent = success
        ? ""
        : "Could not " + action + " in this browser. Storage may be full or blocked.";
    }
    return success;
  }

  function refreshButtons() {
    var buttons = document.querySelectorAll(".save-button[data-bookmark]");
    Array.prototype.forEach.call(buttons, function (button) {
      var record;
      try {
        record = JSON.parse(button.getAttribute("data-bookmark") || "");
      } catch (error) {
        return;
      }
      setButtonState(button, isSaved(record.slug));
    });
  }

  function bindSaveButtons() {
    var buttons = document.querySelectorAll(".save-button[data-bookmark]");
    Array.prototype.forEach.call(buttons, function (button) {
      if (button.getAttribute("data-bound") === "true") return;
      button.setAttribute("data-bound", "true");
      button.addEventListener("click", function () {
        var record;
        try {
          record = JSON.parse(button.getAttribute("data-bookmark") || "");
        } catch (error) {
          return;
        }
        var saved = isSaved(record.slug);
        var success = saved ? removeBookmark(record.slug) : addBookmark(record);
        reportBookmarkWrite(success, saved ? "remove this bookmark" : "save this sheet");
        refreshButtons();
        if (success) renderBookmarksPage();
      });
    });
  }

  function formatDate(value) {
    if (!value) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(value));
    } catch (error) {
      return "";
    }
  }

  function renderBookmarksPage() {
    var root = document.querySelector("[data-bookmarks-page]");
    if (!root) return;

    var list = root.querySelector("[data-bookmarks-list]");
    var empty = root.querySelector("[data-bookmarks-empty]");
    var count = root.querySelector("[data-bookmarks-count]");
    var template = document.getElementById("bookmark-template");
    if (!list || !template) return;

    var records = readBookmarks().sort(function (a, b) {
      return (b.savedAt || 0) - (a.savedAt || 0);
    });

    list.replaceChildren();
    if (records.length === 0) {
      if (empty) empty.hidden = false;
      if (count) count.hidden = true;
      return;
    }

    if (empty) empty.hidden = true;
    if (count) {
      count.hidden = false;
      count.textContent =
        String(records.length) + (records.length === 1 ? " saved sheet" : " saved sheets");
    }

    records.forEach(function (record, index) {
      var node = template.content.firstElementChild.cloneNode(true);
      var rank = node.querySelector("[data-rank]");
      var topic = node.querySelector("[data-topic]");
      var source = node.querySelector("[data-source]");
      var link = node.querySelector("[data-link]");
      var original = node.querySelector("[data-original]");
      var date = node.querySelector("[data-date]");
      var reading = node.querySelector("[data-reading]");
      var remove = node.querySelector("[data-remove]");

      if (rank) rank.textContent = String(index + 1).padStart(2, "0");
      if (topic) topic.textContent = record.topicLabel || "Engineering";
      if (source) source.textContent = record.sourceName || "Source";
      if (link) {
        link.textContent = record.headline;
        link.setAttribute("href", "/articles/" + encodeURIComponent(record.slug));
      }
      if (original) original.textContent = record.originalTitle || "";
      if (date) date.textContent = formatDate(record.publishedAt);
      if (reading) {
        reading.textContent = record.readingMinutes
          ? String(record.readingMinutes) + " min read"
          : "Explainer";
      }
      if (remove) {
        remove.setAttribute("aria-label", "Remove bookmark for " + record.headline);
        remove.addEventListener("click", function () {
          if (!reportBookmarkWrite(removeBookmark(record.slug), "remove this bookmark")) return;
          renderBookmarksPage();
          refreshButtons();
        });
      }

      list.appendChild(node);
    });
  }

  function bindCopyButtons() {
    var buttons = document.querySelectorAll("[data-copy-link]");
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener("click", function () {
        var original = button.innerHTML;
        var url = window.location.href;
        var done = function () {
          button.textContent = "Copied";
          window.setTimeout(function () {
            button.innerHTML = original;
          }, 1800);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(done).catch(function () {
            fallbackCopy(url, done);
          });
        } else {
          fallbackCopy(url, done);
        }
      });
    });
  }

  function fallbackCopy(text, done) {
    var input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand("copy");
      done();
    } catch (error) {
      /* clipboard access is optional */
    }
    document.body.removeChild(input);
  }

  function readingProgress() {
    var article = document.querySelector(".article-main");
    if (!article) return;

    var bar = document.createElement("div");
    bar.className = "reading-progress";
    bar.setAttribute("aria-hidden", "true");
    document.body.appendChild(bar);

    var frame = 0;
    function update() {
      frame = 0;
      var rect = article.getBoundingClientRect();
      var scrollable = article.offsetHeight - window.innerHeight;
      var travelled = Math.max(0, -rect.top);
      var ratio = scrollable > 0 ? Math.min(1, travelled / scrollable) : 0;
      bar.style.transform = "scaleX(" + ratio + ")";
    }
    function schedule() {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    }

    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    update();
  }

  function init() {
    bindSaveButtons();
    refreshButtons();
    bindCopyButtons();
    renderBookmarksPage();
    readingProgress();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
