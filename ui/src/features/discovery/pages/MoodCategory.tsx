import { Link, useParams } from "wouter";
import { Empty, LoadError, Loading } from "../components/States";
import { PlaylistGrid } from "../components/PlaylistGrid";
import { useMoodCategories } from "../hooks/useMoodCategories";
import { useMoodPlaylists } from "../hooks/useMoodPlaylists";

/**
 * One mood or genre: the playlists YouTube Music fills it with.
 *
 * A category is addressed by the `params` token its tile carries, which is what
 * `/moods/:params` holds. The title is looked up in the (cached) categories
 * payload, so a reload on this route keeps its heading without a second read.
 */
export const MoodCategory = () => {
  const { params = "" } = useParams<{ params: string }>();
  const { sections, reload: reloadCategories } = useMoodCategories();
  const { playlists, error, load } = useMoodPlaylists(params);

  const category = (sections ?? [])
    .flatMap((section) => section.categories)
    .find((entry) => entry.params === params);

  const retry = () => {
    load(true);
    reloadCategories();
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="scrollbar flex-1 overflow-y-auto">
        <div className="p-4 sm:p-6">
          <Link
            href="/moods"
            className="inline-flex cursor-pointer items-center gap-1 text-sm text-primary-dark hover:text-primary"
          >
            <span className="icon-[solar--alt-arrow-left-linear]" />
            Moods &amp; genres
          </Link>
          <h1 className="mt-2 text-2xl font-bold">{category?.title ?? "Moods & genres"}</h1>

          {error ? (
            <LoadError message={error} onRetry={retry} />
          ) : playlists === null ? (
            <Loading label="Loading playlists" />
          ) : playlists.length === 0 ? (
            <Empty message="YouTube Music has no playlists in this category." onRetry={retry} />
          ) : (
            <div className="mt-4">
              <PlaylistGrid playlists={playlists} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
