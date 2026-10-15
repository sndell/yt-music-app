import { useEffect, useRef } from "react";
import { usePlayer } from "../context/PlayerContext";
import { loadYouTubeApi, type YouTubePlayer } from "../lib/youtube";

/** How often the picture is checked against the audio. */
const SYNC_POLL_MS = 1000;
/** A drift smaller than this stays; seeking every tick would stutter. */
const MAX_DRIFT_SECONDS = 0.4;

const PLAYER_VARS = {
  autoplay: 1,
  mute: 1,
  controls: 0,
  rel: 0,
  modestbranding: 1,
  playsinline: 1,
  disablekb: 1,
  fs: 0,
  iv_load_policy: 3,
  origin: window.location.origin,
};

const currentAudio = () => document.querySelector("audio");

/**
 * The muted YouTube embed. It has no sound of its own; it follows the app's
 * `<audio>` for play, pause, and seek, and the poll pulls it back when the two
 * streams drift apart.
 */
const YouTubeVideo = ({ videoId }: { videoId: string }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const readyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let player: YouTubePlayer | null = null;
    let poll = 0;

    const seekToAudio = () => {
      const audio = currentAudio();
      if (audio) player?.seekTo(audio.currentTime, true);
    };

    void loadYouTubeApi().then((YT) => {
      if (cancelled || !hostRef.current) return;
      player = new YT.Player(hostRef.current, {
        videoId,
        playerVars: PLAYER_VARS,
        events: {
          onReady: () => {
            readyRef.current = true;
            if (player) player.getIframe().style.pointerEvents = "none";
            player?.mute();
            const audio = currentAudio();
            if (!audio || audio.paused) player?.pauseVideo();
            else player?.playVideo();
            seekToAudio();
            // The capture events can be missed when the overlay mounts
            // mid-song, so the poll is the source of truth: it starts the video
            // whenever the audio plays, stops it when the audio pauses, and
            // seeks only when the two are out of step.
            poll = window.setInterval(() => {
              const node = currentAudio();
              if (!readyRef.current || !player || !node) return;
              if (node.paused) {
                player.pauseVideo();
                return;
              }
              const current = player.getCurrentTime();
              const duration = player.getDuration();
              if (duration > 0 && current >= duration - 0.5) return;
              player.playVideo();
              if (Math.abs(current - node.currentTime) > MAX_DRIFT_SECONDS) {
                player.seekTo(node.currentTime, true);
              }
            }, SYNC_POLL_MS);
          },
        },
      });
      playerRef.current = player;
    });

    const onPlay = (event: Event) => {
      if (event.target instanceof HTMLAudioElement) playerRef.current?.playVideo();
    };
    const onPause = (event: Event) => {
      if (event.target instanceof HTMLAudioElement) playerRef.current?.pauseVideo();
    };
    const onSeeked = (event: Event) => {
      if (event.target instanceof HTMLAudioElement) seekToAudio();
    };
    document.addEventListener("play", onPlay, true);
    document.addEventListener("pause", onPause, true);
    document.addEventListener("seeked", onSeeked, true);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
      document.removeEventListener("play", onPlay, true);
      document.removeEventListener("pause", onPause, true);
      document.removeEventListener("seeked", onSeeked, true);
      readyRef.current = false;
      player?.destroy();
      playerRef.current = null;
    };
  }, [videoId]);

  return <div ref={hostRef} />;
};

/**
 * The music video, drawn over the sidebar and the routed content on black. The
 * queue and the player bar stay put; the toggle in the player turns this on and
 * off. It is inset and rounded like the other panels.
 */
export const VideoOverlay = () => {
  const { currentVideoId, videoOpen } = usePlayer();
  if (!videoOpen || !currentVideoId) return null;
  return (
    <div className="video-frame absolute inset-1.5 z-50 overflow-hidden rounded-xl bg-black">
      <YouTubeVideo key={currentVideoId} videoId={currentVideoId} />
    </div>
  );
};
