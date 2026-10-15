import { describe, expect, it } from "vitest";
import type { Track } from "@/lib/api";
import { duplicateVideoIds, formatAddedAt, sortTracks, visibleTracks } from "./trackFilter";

const track = (videoId: string, overrides: Partial<Track> = {}): Track => ({
  videoId,
  title: `Song ${videoId}`,
  artists: [{ name: "Artist", id: "" }],
  album: null,
  likeStatus: "INDIFFERENT",
  inLibrary: false,
  thumbnails: [],
  isAvailable: true,
  isExplicit: false,
  videoType: "MUSIC_VIDEO_TYPE_ATV",
  views: null,
  duration: "3:00",
  durationSeconds: 180,
  setVideoId: `${videoId}-set`,
  ...overrides,
});

describe("duplicateVideoIds", () => {
  it("returns only the videoIds that appear more than once", () => {
    const ids = duplicateVideoIds([track("a"), track("b"), track("a"), track("c"), track("b")]);
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("is empty for a list without repeats", () => {
    expect(duplicateVideoIds([track("a"), track("b")]).size).toBe(0);
  });
});

describe("visibleTracks", () => {
  const list = [track("a", { title: "Alpha" }), track("b", { title: "Beta" }), track("a", { title: "Alpha" }), track("c")];

  it("shows every appearance of a repeated song when finding duplicates", () => {
    const shown = visibleTracks(list, { search: "", duplicatesOnly: true });
    expect(shown.map((item) => item.videoId)).toEqual(["a", "a"]);
    expect(shown).toHaveLength(2);
  });

  it("shows the whole list when not finding duplicates", () => {
    expect(visibleTracks(list, { search: "", duplicatesOnly: false })).toHaveLength(4);
  });

  it("matches on the song, its artists and the album", () => {
    const songs = [
      track("a", { title: "Sunrise", artists: [{ name: "Nobody", id: "" }], album: { name: "Days", id: "al" } }),
      track("b", { title: "Beta", artists: [{ name: "Aurora", id: "" }] }),
      track("c", { title: "Gamma", album: { name: "Nights", id: "al2" } }),
    ];
    expect(visibleTracks(songs, { search: "sun", duplicatesOnly: false }).map((t) => t.videoId)).toEqual(["a"]);
    expect(visibleTracks(songs, { search: "aurora", duplicatesOnly: false }).map((t) => t.videoId)).toEqual(["b"]);
    expect(visibleTracks(songs, { search: "nights", duplicatesOnly: false }).map((t) => t.videoId)).toEqual(["c"]);
  });

  it("combines the search with the duplicates filter", () => {
    const songs = [track("a", { title: "Alpha" }), track("b", { title: "Beta" }), track("a", { title: "Alpha" })];
    expect(visibleTracks(songs, { search: "alpha", duplicatesOnly: true })).toHaveLength(2);
    expect(visibleTracks(songs, { search: "beta", duplicatesOnly: true })).toHaveLength(0);
  });

  it("groups the copies of each repeated song together", () => {
    const songs = [
      track("a", { title: "Alpha" }),
      track("b", { title: "Beta" }),
      track("a", { title: "Alpha" }),
      track("c", { title: "Gamma" }),
      track("b", { title: "Beta" }),
    ];
    const shown = visibleTracks(songs, { search: "", duplicatesOnly: true });
    expect(shown.map((item) => item.videoId)).toEqual(["a", "a", "b", "b"]);
  });

  it("orders the groups by where each song is first seen", () => {
    const songs = [
      track("b", { title: "B one" }),
      track("x", { title: "Single" }),
      track("a", { title: "A one" }),
      track("b", { title: "B two" }),
      track("a", { title: "A two" }),
    ];
    const shown = visibleTracks(songs, { search: "", duplicatesOnly: true });
    expect(shown.map((item) => item.title)).toEqual(["B one", "B two", "A one", "A two"]);
  });

  it("keeps the original list's order when not finding duplicates", () => {
    const songs = [track("a"), track("b"), track("a"), track("b")];
    expect(visibleTracks(songs, { search: "", duplicatesOnly: false }).map((t) => t.videoId)).toEqual([
      "a",
      "b",
      "a",
      "b",
    ]);
  });
});

describe("sortTracks", () => {
  const list = [track("a", { addedAt: 300 }), track("b", { addedAt: 100 }), track("c", { addedAt: 200 })];

  it("keeps the playlist's own order untouched", () => {
    expect(sortTracks(list, "playlist").map((t) => t.videoId)).toEqual(["a", "b", "c"]);
  });

  it("orders the newest add first", () => {
    expect(sortTracks(list, "added-desc").map((t) => t.videoId)).toEqual(["a", "c", "b"]);
  });

  it("orders the oldest add first", () => {
    expect(sortTracks(list, "added-asc").map((t) => t.videoId)).toEqual(["b", "c", "a"]);
  });

  it("keeps songs without a time at the end, in playlist order", () => {
    const mixed = [track("x"), track("a", { addedAt: 300 }), track("y"), track("b", { addedAt: 100 })];
    expect(sortTracks(mixed, "added-desc").map((t) => t.videoId)).toEqual(["a", "b", "x", "y"]);
    expect(sortTracks(mixed, "added-asc").map((t) => t.videoId)).toEqual(["b", "a", "x", "y"]);
  });

  it("keeps equal times in the order they appear", () => {
    const copies = [track("a", { addedAt: 100 }), track("b", { addedAt: 100 }), track("a", { addedAt: 100 })];
    expect(sortTracks(copies, "added-asc").map((t) => t.videoId)).toEqual(["a", "b", "a"]);
  });

  it("leaves the given list alone", () => {
    const before = list.map((t) => t.videoId);
    sortTracks(list, "added-asc");
    expect(list.map((t) => t.videoId)).toEqual(before);
  });
});

describe("formatAddedAt", () => {
  it("is null without a time", () => {
    expect(formatAddedAt(null)).toBeNull();
    expect(formatAddedAt(undefined)).toBeNull();
  });

  it("formats the day and year", () => {
    const formatted = formatAddedAt(1613573891);
    expect(formatted).toMatch(/2021/);
    expect(formatted).not.toMatch(/^Added/);
  });
});
