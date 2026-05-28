/// <reference types="vite/client" />

import type { SpotifySdk } from './lib/spotifySdk';

declare global {
  interface Window {
    Spotify?: SpotifySdk;
    onSpotifyWebPlaybackSDKReady?: () => void;
  }
}

export {};