import { PyBridge, type Track } from "@/lib/api";
import { createContext, useCallback, useContext, useState } from "react";

type PlayerContextType = {
  currentSong: Track | null;
  setCurrentSong: (song: Track) => void;
  queue: Track[];
  getWatchPlaylist: (videoId: string, playlistId?: string, radio?: boolean, shuffle?: boolean) => Promise<void>;
};

const PlayerContext = createContext<PlayerContextType | null>(null);

export const PlayerProvider = ({ children }: { children: React.ReactNode }) => {
  const [currentSong, setCurrentSong] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);

  const getWatchPlaylist = useCallback(async (videoId: string, playlistId?: string, radio = false, shuffle = false) => {
    await PyBridge.getWatchPlaylist(videoId, playlistId, radio, shuffle);
  }, []);

  return (
    <PlayerContext.Provider value={{ currentSong, setCurrentSong, queue, getWatchPlaylist }}>
      {children}
    </PlayerContext.Provider>
  );
};

export const usePlayer = () => {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
};
