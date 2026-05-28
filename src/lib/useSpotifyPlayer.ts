import { useEffect, useMemo, useRef, useState } from 'react';
import { getValidAccessToken, transferPlaybackToDevice } from './spotify';
import type { SpotifyPlayerInstance, SpotifyPlayerState, SpotifySdk } from './spotifySdk';

async function loadSpotifySdk() {
  if (window.Spotify) {
    return window.Spotify;
  }

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-spotify-sdk="true"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load Spotify SDK')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.dataset.spotifySdk = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Spotify SDK'));
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    document.head.appendChild(script);
  });

  return window.Spotify ?? null;
}

function mapState(state: SpotifyPlayerState | null) {
  if (!state) {
    return null;
  }

  const currentTrack = state.track_window.current_track;
  return {
    isPaused: state.paused,
    positionMs: state.position,
    durationMs: currentTrack.duration_ms,
    title: currentTrack.name,
    artist: currentTrack.artists.map((artist) => artist.name).join(', '),
    albumArt: currentTrack.album.images[0]?.url ?? '',
    contextUri: currentTrack.uri,
  };
}

export function useSpotifyPlayer(enabled: boolean) {
  const [ready, setReady] = useState(false);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<ReturnType<typeof mapState>>(null);
  const playerRef = useRef<SpotifyPlayerInstance | null>(null);
  const transferPerformed = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function setupPlayer() {
      if (!enabled) {
        if (playerRef.current) {
          await playerRef.current.disconnect();
          playerRef.current = null;
        }
        setReady(false);
        setDeviceId(null);
        setState(null);
        transferPerformed.current = false;
        return;
      }

      try {
        const sdk = await loadSpotifySdk();
        if (cancelled || !sdk) {
          return;
        }

        if (!playerRef.current) {
          const player = new sdk.Player({
            name: 'PS1 Spotify Visualizer',
            volume: 0.8,
            getOAuthToken: (callback) => {
              void getValidAccessToken().then((token) => callback(token ?? ''));
            },
          });

          player.addListener('ready', async ({ device_id }: { device_id: string }) => {
            if (cancelled) {
              return;
            }

            setDeviceId(device_id);
            setReady(true);

            if (!transferPerformed.current) {
              transferPerformed.current = true;
              try {
                await transferPlaybackToDevice(device_id);
              } catch (transferError) {
                setError(transferError instanceof Error ? transferError.message : 'Unable to transfer playback');
              }
            }
          });

          player.addListener('not_ready', ({ device_id }: { device_id: string }) => {
            if (cancelled) {
              return;
            }

            if (device_id === deviceId) {
              setReady(false);
              setDeviceId(null);
            }
          });

          player.addListener('initialization_error', ({ message }: { message: string }) => {
            setError(message);
          });

          player.addListener('authentication_error', ({ message }: { message: string }) => {
            setError(message);
          });

          player.addListener('account_error', ({ message }: { message: string }) => {
            setError(message);
          });

          player.addListener('player_state_changed', (nextState: SpotifyPlayerState | null) => {
            if (cancelled) {
              return;
            }

            setState(mapState(nextState));
          });

          playerRef.current = player;
          const connected = await player.connect();
          if (!connected) {
            setError('Unable to connect Spotify Web Playback SDK');
          }
        }
      } catch (setupError) {
        if (!cancelled) {
          setError(setupError instanceof Error ? setupError.message : 'Spotify player setup failed');
        }
      }
    }

    void setupPlayer();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const controls = useMemo(() => {
    return {
      async togglePlay() {
        const player = playerRef.current;
        if (!player) {
          throw new Error('Spotify player is not ready');
        }

        await player.togglePlay();
      },
      async pause() {
        const player = playerRef.current;
        if (!player) {
          throw new Error('Spotify player is not ready');
        }

        await player.pause();
      },
      async resume() {
        const player = playerRef.current;
        if (!player) {
          throw new Error('Spotify player is not ready');
        }

        await player.resume();
      },
      async seek(positionMs: number) {
        const player = playerRef.current;
        if (!player) {
          throw new Error('Spotify player is not ready');
        }

        await player.seek(positionMs);
      },
      async nextTrack() {
        const player = playerRef.current;
        if (!player) {
          throw new Error('Spotify player is not ready');
        }

        await player.nextTrack();
      },
      async previousTrack() {
        const player = playerRef.current;
        if (!player) {
          throw new Error('Spotify player is not ready');
        }

        await player.previousTrack();
      },
    };
  }, []);

  return {
    ready,
    deviceId,
    error,
    state,
    ...controls,
  };
}