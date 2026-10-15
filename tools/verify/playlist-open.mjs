/**
 * Open-a-playlist journey, run against the real window over CDP.
 *
 * Picks the first real user playlist from the sidebar (never LM), opens it by
 * hash, and proves the header and track area paint instead of sticking on the
 * skeleton. Read-only: it never adds, removes, or reorders a track.
 */

// Home is the only route with no h1, so starting from Home means the heading we
// later wait for can only belong to the playlist, never to a leftover route.
const HOME_READY = () =>
  !document.querySelector("h1") &&
  (document.querySelectorAll("h2").length > 0 || /Sign in from Settings/.test(document.body.innerText));

export default async function run({ page, check }) {
  const ids = await page.$$eval("[data-playlist-id]", (rows) =>
    rows.map((row) => row.getAttribute("data-playlist-id")).filter(Boolean),
  );
  check("sidebar has playlists", ids.length > 0);

  const target = ids.find((id) => id !== "LM");
  check("found a user playlist to open", Boolean(target));
  if (!target) return;

  const goHome = async () => {
    await page.evaluate(() => { window.location.hash = "#/"; });
    await page.waitForFunction(HOME_READY, undefined, { timeout: 15000 });
  };

  const hash = `#/playlist/${target}`;
  await goHome();
  await page.evaluate((value) => { window.location.hash = value; }, hash);
  await page.waitForFunction(
    (value) => {
      if (window.location.hash !== value) return false;
      const heading = document.querySelector("h1");
      return Boolean(heading && (heading.textContent || "").trim());
    },
    hash,
    { timeout: 15000 },
  );
  const title = ((await page.textContent("h1")) || "").trim();
  check("playlist header paints an h1", title.length > 0);

  // The skeleton announces itself with role="status" text "Loading tracks";
  // wait for it to clear, which means the track list (or an empty list) painted.
  await page.waitForFunction(
    () =>
      !Array.from(document.querySelectorAll('[role="status"]')).some((el) =>
        (el.textContent || "").includes("Loading tracks"),
      ),
    undefined,
    { timeout: 20000 },
  );
  const stillLoading = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="status"]')).some((el) =>
      (el.textContent || "").includes("Loading tracks"),
    ),
  );
  check("playlist leaves the loading skeleton", !stillLoading);

  // Back home, prove the walk did not wedge the router.
  await goHome();
  check("Home paints again after leaving", true);
}
