import { describe, expect, it } from "vitest";
import type { WatchCounterpart, WatchTrack } from "@/lib/api";
import { musicVideoId } from "./musicVideo";

const track = (overrides: Partial<WatchTrack> = {}): WatchTrack => ({
  videoId: "audio-1",
  title: "Song",
  length: "3:00",
  thumbnail: [],
  likeStatus: null,
  videoType: "MUSIC_VIDEO_TYPE_ATV",
  inLibrary: null,
  feedbackTokens: null,
  pinnedToListenAgain: null,
  listenAgainFeedbackTokens: null,
  ...overrides,
});

const counterpart = (
  videoId: string,
  videoType: NonNullable<WatchCounterpart["videoType"]>,
): WatchCounterpart => ({
  videoId,
  title: "Song",
  length: "3:00",
  thumbnail: [],
  feedbackTokens: null,
  likeStatus: "INDIFFERENT",
  artists: [],
  views: "1M",
  videoType,
});

describe("musicVideoId", () => {
  it("uses the row's own id when the row is a music video", () => {
    expect(musicVideoId(track({ videoId: "vid-1", videoType: "MUSIC_VIDEO_TYPE_OMV" }))).toBe("vid-1");
  });

  it("uses the counterpart id for an audio row that has a music video", () => {
    const row = track({ counterpart: counterpart("video-9", "MUSIC_VIDEO_TYPE_OMV") });
    expect(musicVideoId(row)).toBe("video-9");
  });

  it("returns null for an audio row with no counterpart", () => {
    expect(musicVideoId(track())).toBeNull();
  });

  it("returns null when the counterpart is not a music video", () => {
    expect(musicVideoId(track({ counterpart: counterpart("alt", "MUSIC_VIDEO_TYPE_ATV") }))).toBeNull();
    expect(musicVideoId(track({ counterpart: counterpart("ugc", "MUSIC_VIDEO_TYPE_UGC") }))).toBeNull();
  });

  it("returns null without a track", () => {
    expect(musicVideoId(null)).toBeNull();
  });
});
