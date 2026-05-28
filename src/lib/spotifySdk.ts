export type SpotifyTrackImage = {
  url: string;
  height: number | null;
  width: number | null;
};

export type SpotifyTrack = {
  name: string;
  uri: string;
  duration_ms: number;
  artists: Array<{ name: string }>;
  album: {
    images: SpotifyTrackImage[];
  };
};

export type SpotifyPlayerState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window: {
    current_track: SpotifyTrack;
  };
};

export type SpotifyPlayerInit = {
  name: string;
  getOAuthToken: (callback: (token: string) => void) => void;
  volume?: number;
};

export type SpotifyPlayerInstance = {
  connect: () => Promise<boolean>;
  disconnect: () => Promise<boolean>;
  addListener: (event: string, callback: (...args: any[]) => void) => boolean;
  removeListener: (event: string, callback: (...args: any[]) => void) => boolean;
  getCurrentState: () => Promise<SpotifyPlayerState | null>;
  togglePlay: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  nextTrack: () => Promise<void>;
  previousTrack: () => Promise<void>;
};

export type SpotifySdk = {
  Player: new (options: SpotifyPlayerInit) => SpotifyPlayerInstance;
};