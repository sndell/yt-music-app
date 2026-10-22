import { useCallback, useEffect, useRef } from "react";
import { usePlayer } from "@/features/player";
import { playback } from "@/features/player/lib/playback";
import { PyBridge } from "@/lib/api";
import { closePopout } from "@/lib/popout";
import { POPOUT_CHANNEL, type PopoutCommand, type PopoutMessage, type PopoutState } from "../lib/channel";

/**
 * Publishes this window's player to the popout and runs what the popout asks
 * for.
 *
 * Mounted inside PlayerProvider and nowhere else: the popout mounts neither this
 * nor the player bar, so it cannot become a second player with a second audio
 * element. A command arrives here and goes through the same handler a click in
 * the player bar would, which is what keeps the queue, the like state and the
 * history write in one place.
 */
export const PopoutBridge = () => {
  const player = usePlayer();
  const playerRef = useRef(player);
  playerRef.current = player;
  const channelRef = useRef<BroadcastChannel | null>(null);

  const publishState = useCallback(() => {
    const channel = channelRef.current;
    if (!channel) return;
    const current = playerRef.current;
    const audio = playback.get();
    const state: PopoutState = {
      song: current.currentSong,
      queue: current.queue,
      index: current.currentQueueIndex,
      shuffle: current.shuffle,
      loop: audio.loop,
      playing: audio.playing,
      position: audio.position,
      duration: audio.duration,
      lyrics: current.lyrics,
      relatedId: current.relatedId,
      relatedTitle: current.relatedTitle,
      ratingPending: current.ratingPending,
      sentAt: Date.now(),
    };
    channel.postMessage({ type: "state", state } satisfies PopoutMessage);
  }, []);

  const handleCommand = useCallback((command: PopoutCommand) => {
    const current = playerRef.current;
    const transport = playback.transport();
    switch (command.kind) {
      case "play":
        transport?.play();
        break;
      case "pause":
        transport?.pause();
        break;
      case "next":
        transport?.next();
        break;
      case "previous":
        transport?.previous();
        break;
      case "seek":
        transport?.seek(command.position);
        break;
      case "toggle-loop":
        transport?.toggleLoop();
        break;
      case "toggle-shuffle":
        current.toggleShuffle();
        break;
      case "rate":
        void current.rateSong(command.rating);
        break;
      case "play-index": {
        const track = current.queue[command.index];
        if (track) current.playFromQueue(track, command.index);
        break;
      }
      case "play-next":
        current.playTrackNext(command.track);
        break;
      case "add-to-queue":
        current.addTrackToQueue(command.track);
        break;
      case "start-mix":
        current.startMix(command.track);
        break;
      case "open-main":
        void PyBridge.focusMain();
        window.location.hash = command.href;
        break;
      case "close-popout":
        void closePopout();
        break;
    }
  }, []);

  useEffect(() => {
    const channel = new BroadcastChannel(POPOUT_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<PopoutMessage>) => {
      const message = event.data;
      if (message.type === "hello") publishState();
      else if (message.type === "command") handleCommand(message.command);
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [handleCommand, publishState]);

  useEffect(() => {
    publishState();
  }, [
    publishState,
    player.currentSong,
    player.queue,
    player.currentQueueIndex,
    player.shuffle,
    player.lyrics,
    player.relatedId,
    player.relatedTitle,
    player.ratingPending,
  ]);

  useEffect(
    () =>
      playback.subscribe((audio) => {
        channelRef.current?.postMessage({
          type: "tick",
          playing: audio.playing,
          position: audio.position,
          duration: audio.duration,
          loop: audio.loop,
        } satisfies PopoutMessage);
      }),
    [],
  );

  return null;
};
