/**
 * YouTube's chart countries arrive as ISO 3166-1 alpha-2 codes, and it names
 * only the one it served. The platform's own region names label the rest, so
 * the picker lists exactly the payload's countries and no country table lives
 * in this app.
 */

/** YouTube's own code for the global chart, the one option that is not a country. */
const GLOBAL_CODE = "ZZ";

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

export const chartCountryName = (code: string) => {
  if (code === GLOBAL_CODE) return "Global";
  try {
    return regionNames?.of(code) ?? code;
  } catch {
    return code;
  }
};
