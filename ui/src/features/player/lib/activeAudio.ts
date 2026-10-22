/**
 * The audio element carrying the current song.
 *
 * A crossfade has two elements playing at once, and the one on its way out is
 * not the song the window is showing, so anything that syncs to "the" audio
 * has to ask instead of reaching into the document.
 */
let node: HTMLAudioElement | null = null;

export const setActiveAudio = (audio: HTMLAudioElement | null) => {
  node = audio;
};

export const activeAudio = () => node;
