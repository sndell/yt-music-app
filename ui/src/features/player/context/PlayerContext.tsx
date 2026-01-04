import type { Track } from "@/lib/api";
import { createContext, useContext, useState } from "react";

type PlayerContextType = {
  currentSong: Track | null;
  setCurrentSong: (song: Track) => void;
  queue: Track[];
};

const PlayerContext = createContext<PlayerContextType | null>(null);

export const PlayerProvider = ({ children }: { children: React.ReactNode }) => {
  const [currentSong, setCurrentSong] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);

  return <PlayerContext.Provider value={{ currentSong, setCurrentSong, queue }}>{children}</PlayerContext.Provider>;
};

export const usePlayer = () => {
  const context = useContext(PlayerContext);
  if (!context) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return context;
};
