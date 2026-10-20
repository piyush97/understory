import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createElement } from "hono/jsx";
import { parseHTML } from "linkedom";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Diagram } from "../src/domain/explanation";
import { renderDiagramSvg } from "../src/domain/diagram";
import { DiagramPlate } from "../src/web/components/diagram";
import { Layout } from "../src/web/components/layout";

const css = readFileSync(new URL("../public/assets/styles.css", import.meta.url), "utf8");
const script = readFileSync(new URL("../public/assets/app.js", import.meta.url), "utf8");
const storageKey = "understory:bookmarks:v1";
const record = { slug: "control-plane", headline: "A control plane" };
const diagram: Diagram = {
  kind: "flow", title: "Request path", description: "Requests pass from the client to the worker.",
  conceptual: true,
  nodes: [{ id: "client", label: "Client", cite: "s1" }, { id: "worker", label: "Worker" }],
  edges: [{ from: "client", to: "worker", label: "Request", cite: "s1" }],
};

function renderLayout(content: string) {
  return String(createElement(Layout, {
    title: "Test", description: "Local regression fixture", path: "/about",
    site: { published: 1, sources: 1, topics: 1, inReview: 0, publicationVersion: "1" },
    children: createElement("div", { class: "page", dangerouslySetInnerHTML: { __html: content } }),
  }));
}

function bookmarkApp(saved = false, fails = true) {
  const button = `<button class="save-button" data-bookmark='${JSON.stringify(record)}' aria-pressed="false"><span class="save-button__label">Save</span></button>`;
  const { document, window } = parseHTML(renderLayout(`${button}${button}
    <div data-bookmarks-page><div data-bookmarks-list></div><p data-bookmarks-count></p><div data-bookmarks-empty hidden>Empty</div></div>
    <template id="bookmark-template"><article><a data-link></a><button data-remove>Remove</button></article></template>`));
  const values = new Map<string, string>(saved ? [[storageKey, JSON.stringify([record])]] : []);
  let failWrites = fails;
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("QuotaExceededError");
      values.set(key, value);
    },
  };
  runInNewContext(script, {
    document, window: { localStorage, addEventListener() {} },
    navigator: {}, IntersectionObserver: undefined,
  });
  return { document, window, values, allowWrites: () => { failWrites = false; } };
}

describe("bookmark persistence feedback", () => {
  it.each([false, true])("keeps the persisted pressed state and reports failed save/remove (saved=%s)", (saved) => {
    const { document, window, values } = bookmarkApp(saved);
    document.querySelector(".save-button")!.dispatchEvent(new window.Event("click"));
    for (const button of document.querySelectorAll(".save-button")) {
      expect(button.getAttribute("aria-pressed")).toBe(String(saved));
      expect(button.textContent).toBe(saved ? "Saved" : "Save");
    }
    const status = document.querySelector('[role="status"]');
    expect(status?.textContent).toMatch(saved ? /could not remove/i : /could not save/i);
    expect(status?.textContent).toMatch(/browser/i);
    expect(values.has(storageKey)).toBe(saved);
  });

  it("keeps a failed removal visible on the bookmarks page", () => {
    const { document, window } = bookmarkApp(true);
    document.querySelector("[data-remove]")!.dispatchEvent(new window.Event("click"));
    expect(document.querySelectorAll("[data-bookmarks-list] article")).toHaveLength(1);
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/could not remove/i);
    expect(document.querySelector("[data-bookmarks-count]")?.textContent).toBe("1 saved sheet");
  });

  it("successful retry updates all buttons and clears the error without success announcements", () => {
    const app = bookmarkApp();
    const button = app.document.querySelector(".save-button")!;
    button.dispatchEvent(new app.window.Event("click"));
    expect(app.document.querySelector('[role="status"]')?.textContent).toMatch(/could not save/i);
    app.allowWrites();
    button.dispatchEvent(new app.window.Event("click"));
    expect(app.document.querySelector('[role="status"]')?.textContent).toBe("");
    for (const saved of app.document.querySelectorAll(".save-button")) {
      expect(saved.getAttribute("aria-pressed")).toBe("true");
    }
    button.dispatchEvent(new app.window.Event("click"));
    expect(app.document.querySelector('[role="status"]')?.textContent).toBe("");
    expect(JSON.parse(app.values.get(storageKey)!)).toEqual([]);
    expect(app.document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe.each(["flow", "sequence"] as const)("%s diagram semantics", (kind) => {
  it("exposes its name and description without hiding interactive citations inside an image", () => {
    const { document } = parseHTML(renderDiagramSvg({ ...diagram, kind }));
    const svg = document.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("group");
    expect(document.getElementById(svg.getAttribute("aria-labelledby")!)?.textContent).toBe("Request path");
    expect(document.getElementById(svg.getAttribute("aria-describedby")!)?.textContent).toBe(diagram.description);
    expect(svg.querySelector('a[href="#sources"]')?.getAttribute("aria-label")).toBe("Source s1");
  });
});

describe("rendered keyboard, contrast and motion", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  afterAll(async () => { await browser?.close(); });

  async function pageFor(content: string, colorScheme: "light" | "dark" = "light", reducedMotion: "reduce" | "no-preference" = "reduce") {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme, reducedMotion });
    await page.route("**/*", (route) => route.request().resourceType() === "document"
      ? route.fulfill({ contentType: "text/html", body: renderLayout(content).replace("</head>", `<style>${css}</style></head>`).replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, "") })
      : route.abort());
    await page.goto("http://understory.test/about");
    return page;
  }

  it("skip link moves keyboard focus past the masthead, including without JS", async () => {
    const page = await pageFor('<h1>About</h1><a id="content-link" href="#sources">Sources</a>');
    try {
      await page.keyboard.press("Tab");
      expect(await page.locator(".skip-link").evaluate((node) => node === node.ownerDocument.activeElement)).toBe(true);
      await page.keyboard.press("Enter");
      expect(await page.locator("main").evaluate((node) => node === node.ownerDocument.activeElement)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.locator("#content-link").evaluate((node) => node === node.ownerDocument.activeElement)).toBe(true);
    } finally { await page.close(); }
  });

  it("lets keyboard users reach and horizontally scroll the labelled mobile diagram", async () => {
    const page = await pageFor(String(createElement(DiagramPlate, { diagram })));
    try {
      const canvas = page.locator(".diagram-canvas");
      expect(await canvas.getAttribute("role")).toBe("region");
      expect(await canvas.getAttribute("aria-label")).toContain("Request path");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Tab");
      expect(await canvas.evaluate((node) => node === node.ownerDocument.activeElement)).toBe(true);
      expect(await canvas.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction('document.querySelector(".diagram-canvas").scrollLeft > 0');
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    } finally { await page.close(); }
  });

  it("shows storage failures in a live status without lying about the saved state, then retries quietly", async () => {
    const page = await pageFor(`<button class="save-button js-only" data-bookmark='${JSON.stringify(record)}' aria-pressed="false"><span class="save-button__label">Save</span></button>`);
    try {
      await page.evaluate(`window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new DOMException("Full", "QuotaExceededError"); }`);
      await page.addScriptTag({ content: script });
      const button = page.locator(".save-button");
      await button.click();
      expect(await button.getAttribute("aria-pressed")).toBe("false");
      const status = page.locator('[role="status"]');
      expect(await status.isVisible()).toBe(true);
      expect(await status.textContent()).toMatch(/could not save.*browser/i);
      await page.evaluate("Storage.prototype.setItem = window.originalSetItem");
      await button.click();
      expect(await button.getAttribute("aria-pressed")).toBe("true");
      expect(await status.textContent()).toBe("");
      await page.evaluate(`Storage.prototype.setItem = function () { throw new DOMException("Full", "QuotaExceededError"); }`);
      await button.click();
      expect(await button.getAttribute("aria-pressed")).toBe("true");
      expect(await status.textContent()).toMatch(/could not remove.*browser/i);
      expect(await page.evaluate(`JSON.parse(localStorage.getItem("${storageKey}")).length`)).toBe(1);
      expect(await page.evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    } finally { await page.close(); }
  });

  it.each(["light", "dark"] as const)("keeps shared text roles readable on actual %s surfaces, including the inverse topic count", async (scheme) => {
    const samples = ["paper", "paper-2", "sheet", "wash"].flatMap((surface) => ["muted", "faint", "redline"].map((role) =>
      `<span data-contrast="${role}/${surface}" style="color:var(--${role});background:var(--${surface})">Metadata</span>`)).join("");
    const page = await pageFor(`${samples}<a class="topic-strip__item topic-strip__item--active">All <span class="topic-strip__count" data-contrast="active count">10</span></a>`, scheme);
    try {
      const ratios = await page.locator("[data-contrast]").evaluateAll((nodes) => {
        const luminance = (color: string) => {
          const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
        };
        return nodes.map((node) => {
          let parent = node;
          const view = node.ownerDocument.defaultView!;
          while (view.getComputedStyle(parent).backgroundColor === "rgba(0, 0, 0, 0)") parent = parent.parentElement!;
          const foreground = luminance(view.getComputedStyle(node).color);
          const background = luminance(view.getComputedStyle(parent).backgroundColor);
          return { role: node.getAttribute("data-contrast"), ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05) };
        });
      });
      for (const { role, ratio } of ratios) expect(ratio, `${scheme} ${role}`).toBeGreaterThanOrEqual(4.5);
    } finally { await page.close(); }
  });

  it("reduced motion removes the page entrance while keeping its content visible", async () => {
    const page = await pageFor('<h1>About</h1>');
    try {
      const style = await page.locator(".page").evaluate((node) => {
        const style = node.ownerDocument.defaultView!.getComputedStyle(node);
        return { animation: style.animationName, opacity: style.opacity };
      });
      expect(style).toEqual({ animation: "none", opacity: "1" });
      expect(await page.locator("html").evaluate((node) => node.ownerDocument.defaultView!.getComputedStyle(node).scrollBehavior)).toBe("auto");
    } finally { await page.close(); }
  });

  it("continues hiding JavaScript-only actions when JavaScript is absent", async () => {
    const page: Page = await pageFor('<button class="save-button js-only">Save</button><button class="copy-button js-only">Copy</button><a id="read" href="#sources">Read original</a>');
    try {
      expect(await page.locator(".save-button").isVisible()).toBe(false);
      expect(await page.locator(".copy-button").isVisible()).toBe(false);
      expect(await page.locator("#read").isVisible()).toBe(true);
    } finally { await page.close(); }
  });
});
