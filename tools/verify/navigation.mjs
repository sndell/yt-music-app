/**
 * Route walk, run against the real window over CDP.
 *
 * Navigating by setting location.hash is far steadier than clicking a nav item:
 * it skips hover state and pointer targets. For each destination we wait on a
 * marker that only the route's own content paints, so "paints" means content,
 * not a blank frame. Read-only: it never creates, edits, or deletes anything.
 */

// The sidebar rail is w-20 (80px) or w-72 (288px), so its column is left of
// this. A spinner to the right belongs to the page, not the rail.
const SIDEBAR_WIDTH = 320;

// Only Home has no h1, so "no h1" plus content rules out a heading left behind
// by another route (Library/Search/Settings/collections all render one).
const HOME_READY = () =>
  !document.querySelector("h1") &&
  (document.querySelectorAll("h2").length > 0 || /Sign in from Settings/.test(document.body.innerText));

export default async function run({ page, check }) {
  const go = (hash) => page.evaluate((value) => { window.location.hash = value; }, hash);

  const homeReady = () => page.waitForFunction(HOME_READY, undefined, { timeout: 15000 });

  // A page heading is the reliable marker for the other routes.
  const headingReady = (text) =>
    page.waitForFunction(
      ({ selector, text }) => {
        const node = document.querySelector(selector);
        return Boolean(node && (node.textContent || "").includes(text));
      },
      { selector: "h1", text },
      { timeout: 15000 },
    );

  await go("#/");
  await homeReady();
  check("Home paints content", await page.evaluate(HOME_READY));

  await go("#/library");
  await headingReady("Library");
  check("Library paints its heading", ((await page.textContent("h1")) || "").includes("Library"));

  await go("#/search");
  await headingReady("Search");
  check("Search paints its page", ((await page.textContent("h1")) || "").includes("Search"));

  await go("#/settings");
  await headingReady("Settings");
  check("Settings paints its heading", ((await page.textContent("h1")) || "").includes("Settings"));

  // The walk must not have disturbed the sidebar. LM (Liked Music) stays first.
  const ids = await page.$$eval("[data-playlist-id]", (rows) =>
    rows.map((row) => row.getAttribute("data-playlist-id")),
  );
  check("sidebar has playlists", ids.length > 0);
  check("Liked Music (LM) is the first row", ids[0] === "LM");
  check("only one LM row", ids.filter((id) => id === "LM").length === 1);

  // No loader drawn over the sidebar column (its left edge sits inside the rail).
  const railSpinners = await page.$$eval(
    ".animate-spin",
    (spinners, railWidth) => spinners.filter((el) => el.getBoundingClientRect().left < railWidth).length,
    SIDEBAR_WIDTH,
  );
  check("no loader over the sidebar", railSpinners === 0);
}
