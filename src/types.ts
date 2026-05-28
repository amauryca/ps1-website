export type LyricLine = {
  time: number;
  text: string;
};

export type Track = {
  title: string;
  artist: string;
  bpm: number;
  duration: number;
  accent: string;
  lyrics: LyricLine[];
};

export type PlaybackSnapshot = {
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  title: string;
  artist: string;
  albumArt: string;
  deviceId: string | null;
  contextUri: string | null;
};