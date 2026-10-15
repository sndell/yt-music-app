/**
 * Sidebar invariants, run against the real window over CDP.
 *
 * Read-only: it never creates or deletes anything, so it is safe to run at any
 * time. Proves the two things that broke before: Liked Music stays pinned to
 * the first row, and no loader is drawn over a populated list.
 */

const PINNED_ID = "LM";

export default async function run({ page, check }) {
  const rows = await page.$$eval("[data-playlist-id]", (elements) =>
    elements.map((element) => ({
      id: element.getAttribute("data-playlist-id"),
      title: (element.innerText || "").split("\n")[0].trim(),
    })),
  );

  check("sidebar has playlists", rows.length > 0);
  check(`${PINNED_ID} (Liked Music) is the first row`, rows[0]?.id === PINNED_ID);
  check(`only one ${PINNED_ID} row`, rows.filter((row) => row.id === PINNED_ID).length === 1);

  const spinners = await page.$$eval(".animate-spin", (elements) => elements.length);
  check("no loader is drawn over the sidebar", spinners === 0);
}
