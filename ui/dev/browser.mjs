#!/usr/bin/env node
/**
 * Drive the real app window over CDP.
 *
 * The window is WebView2, so a Chromium client can attach to its remote
 * debugging port (9222 + slot, opened by DEVTOOLS=1). This gives an agent
 * reliable clicks, screenshots, console capture, and assertion scripts against
 * the *real* window with the *real* Python bridge — not a browser mock.
 *
 *   node ui/dev/browser.mjs targets
 *   node ui/dev/browser.mjs shot --out app/dev/.dev-artifacts/browser.png
 *   node ui/dev/browser.mjs text
 *   node ui/dev/browser.mjs click-text "New playlist"
 *   node ui/dev/browser.mjs console --ms 3000
 *   node ui/dev/browser.mjs run tools/verify/sidebar.mjs
 *
 * Exit codes: 0 pass, 1 fail, 2 infra (not connected / bad args).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_INFRA = 2;

function devSlot() {
  const fromEnv = process.env.DEV_SLOT?.trim();
  if (fromEnv) return Math.max(0, Number.parseInt(fromEnv, 10) || 0);
  for (const rel of ["app/dev/.dev-slot", "dev/.dev-slot", "app/.dev-slot"]) {
    const file = path.join(REPO, rel);
    if (existsSync(file)) {
      const value = Number.parseInt(readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim(), 10);
      return Number.isNaN(value) || value < 0 ? 0 : value;
    }
  }
  return 0;
}

function parseArgs(argv) {
  const options = { port: Number(process.env.YTM_CDP_PORT) || 9222 + devSlot(), command: argv[0], rest: [] };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") options.port = Number(argv[++i]);
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--ms") options.ms = Number(argv[++i]);
    else if (arg === "--timeout") options.timeout = Number(argv[++i]);
    else options.rest.push(arg);
  }
  return options;
}

async function connect(port) {
  const endpoint = `http://127.0.0.1:${port}`;
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (error) {
    throw Object.assign(new Error(
      `cannot attach over CDP at ${endpoint}: ${error.message}\n` +
        "Start the window with DEVTOOLS=1 (tools/dev.py up --devtools) so the port is open.",
    ), { infra: true });
  }
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith("http")) ?? pages[0];
  if (!page) throw Object.assign(new Error("no page found in the window"), { infra: true });
  return { browser, page };
}

/** Assertion helper handed to verify scripts. */
function makeCheck() {
  const results = [];
  const check = (name, condition) => {
    const passed = Boolean(condition);
    results.push({ name, passed });
    console.log(`  ${passed ? "ok  " : "FAIL"} ${name}`);
    return passed;
  };
  check.results = results;
  return check;
}

const commands = {
  async targets({ port }) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      for (const target of list) console.log(`${target.type}\t${target.url}`);
    } catch (error) {
      throw Object.assign(new Error(
        `no CDP endpoint at 127.0.0.1:${port}: ${error.message}\n` +
          "Start the window with DEVTOOLS=1 (tools/dev.py up --devtools) so the port is open.",
      ), { infra: true });
    }
    return EXIT_OK;
  },

  async shot({ page, out }) {
    const target = out ? path.resolve(REPO, out) : path.join(REPO, "app/dev/.dev-artifacts/browser.png");
    await page.screenshot({ path: target });
    console.log(target);
    return EXIT_OK;
  },

  async text({ page }) {
    console.log(await page.evaluate(() => document.body.innerText));
    return EXIT_OK;
  },

  async click({ page, rest }) {
    const selector = rest[0];
    if (!selector) throw Object.assign(new Error("click needs a selector"), { infra: true });
    await page.click(selector, { timeout: 10_000 });
    return EXIT_OK;
  },

  async "click-text"({ page, rest }) {
    const text = rest.join(" ");
    if (!text) throw Object.assign(new Error("click-text needs text"), { infra: true });
    await page.getByText(text, { exact: false }).first().click({ timeout: 10_000 });
    return EXIT_OK;
  },

  async wait({ page, rest, timeout }) {
    const selector = rest[0];
    if (!selector) throw Object.assign(new Error("wait needs a selector"), { infra: true });
    await page.waitForSelector(selector, { timeout: timeout ?? 10_000 });
    console.log(`found ${selector}`);
    return EXIT_OK;
  },

  async console({ page, ms }) {
    let failed = false;
    page.on("console", (message) => {
      const level = message.type();
      console.log(`[${level}] ${message.text()}`);
      if (level === "error") failed = true;
    });
    page.on("pageerror", (error) => {
      console.log(`[pageerror] ${error.message}`);
      failed = true;
    });
    await page.waitForTimeout(ms ?? 3000);
    return failed ? EXIT_FAIL : EXIT_OK;
  },

  async run({ page, browser, rest }) {
    const scriptPath = rest[0];
    if (!scriptPath) throw Object.assign(new Error("run needs a script path"), { infra: true });
    const resolved = path.resolve(REPO, scriptPath);
    const module = await import(pathToFileURL(resolved).href);
    const check = makeCheck();
    const run = module.default ?? module.run;
    if (typeof run !== "function") {
      throw Object.assign(new Error(`${scriptPath} must export run() or a default function`), { infra: true });
    }
    await run({ page, browser, check });
    const failed = check.results.filter((entry) => !entry.passed);
    if (failed.length > 0) {
      console.log(`FAIL ${failed.length} of ${check.results.length} checks`);
      return EXIT_FAIL;
    }
    console.log(`PASS ${check.results.length} checks`);
    return EXIT_OK;
  },
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.command || !commands[options.command]) {
    console.error(`usage: node ui/dev/browser.mjs <${Object.keys(commands).join("|")}> [args]`);
    return EXIT_INFRA;
  }

  let connection = null;
  try {
    // `targets` talks plain HTTP; everything else needs a page.
    if (options.command !== "targets") connection = await connect(options.port);
    const code = await commands[options.command]({ ...options, ...(connection ?? {}) });
    return code;
  } catch (error) {
    console.error(`error: ${error.message}`);
    return error.infra ? EXIT_INFRA : EXIT_FAIL;
  } finally {
    if (connection?.browser) await connection.browser.close().catch(() => undefined);
  }
}

process.exit(await main());
