import { useState } from "react";
import { useLocation, useParams } from "wouter";
import { cn } from "@/util/cn";
import { ChartArtistList } from "../components/ChartArtistList";
import { CountryMenu } from "../components/CountryMenu";
import { Empty, LoadError, Loading } from "../components/States";
import { PlaylistGrid } from "../components/PlaylistGrid";
import { useCharts } from "../hooks/useCharts";
import { chartCountryName } from "../lib/countryName";

/**
 * The route carries the country; YouTube's own code for the global chart is
 * `ZZ`, and anything the route cannot hold falls back to it rather than asking
 * for a country that does not exist.
 */
const countryFromRoute = (value: string | undefined) => {
  const code = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "ZZ";
};

/**
 * `/charts`: YouTube Music's own charts, global by default and switchable by
 * country. The country list is the payload's, so a code YouTube adds shows up
 * without a change here.
 */
export const Charts = () => {
  const params = useParams<{ country?: string }>();
  const country = countryFromRoute(params.country);
  const [, navigate] = useLocation();
  const { charts, error, load } = useCharts(country);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);

  const sections = charts?.sections ?? [];
  const artists = charts?.artists ?? [];
  const codes = charts?.countries ?? [];
  const activeCountry = charts?.country ?? country;
  const label = charts?.countryName || chartCountryName(activeCountry);
  const menuOpen = menuAnchor !== null;
  // A country is a route, so a switch is a fresh read and a reload keeps it.
  const openCountry = (code: string) => navigate(code === "ZZ" ? "/charts" : `/charts/${code}`);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Charts</h1>
              <p className="mt-1 text-sm text-primary-dark">YouTube Music's top songs, videos and artists</p>
            </div>
            {codes.length > 0 && (
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={`Chart country: ${label}`}
                onClick={(event) => (menuOpen ? setMenuAnchor(null) : setMenuAnchor(event.currentTarget))}
                className={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium transition-colors duration-200",
                  menuOpen ? "bg-primary-light text-primary" : "text-primary-dark hover:bg-primary-light hover:text-primary",
                )}
              >
                <span className="icon-[solar--global-linear] text-sm" aria-hidden="true" />
                {label}
                <span
                  className={cn(
                    "icon-[solar--alt-arrow-down-linear] text-sm transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]",
                    menuOpen && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </button>
            )}
          </div>

          {/* Charts outrank an error: a failed retry must never cover the charts
              that did land. With nothing fetched, the error still speaks first. */}
          {error && <LoadError message={error} onRetry={() => load(true)} />}

          {charts === null ? (
            !error && <Loading label="Loading charts" />
          ) : sections.length === 0 && artists.length === 0 ? (
            <Empty
              message="YouTube Music returned no charts for this country."
              onRetry={() => load(true)}
            />
          ) : (
            <div className="mt-4 flex flex-col gap-8">
              {sections.map((section) => (
                <section key={section.key} className="min-w-0">
                  <h2 className="text-xl font-bold">{section.title}</h2>
                  <div className="mt-3">
                    <PlaylistGrid playlists={section.playlists} />
                  </div>
                </section>
              ))}
              {artists.length > 0 && (
                <section className="min-w-0">
                  <h2 className="text-xl font-bold">Artists</h2>
                  <div className="mt-3">
                    <ChartArtistList artists={artists} />
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
      {menuAnchor && (
        <CountryMenu
          open={menuOpen}
          trigger={menuAnchor}
          codes={codes}
          activeCode={activeCountry}
          onSelect={openCountry}
          onClose={() => setMenuAnchor(null)}
        />
      )}
    </div>
  );
};
