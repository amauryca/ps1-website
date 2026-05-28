import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { fetchSyncedLyrics } from './lib/lyrics';
import {
  clearSpotifyAuth,
  createSpotifyAuthUrl,
  fetchAlbumTracks,
  fetchArtistAlbums,
  fetchQueueNextTrack,
  getValidAccessToken,
  handleSpotifyRedirect,
  hasSpotifyConfig,
  loadSpotifyAuth,
  playTrackUri,
  queueTrackUri,
  searchArtists,
  searchTracks,
  seekPlayback,
  skipRemoteTrack,
  toggleRemotePlayback,
  type AlbumTrackResult,
  type ArtistAlbumResult,
  type SearchTrackResult,
  type SearchArtistResult,
} from './lib/spotify';
import { useSpotifyPlayer } from './lib/useSpotifyPlayer';
import type { LyricLine, Track } from './types';

type Palette = {
  a: string;
  b: string;
  c: string;
};

type LyricTrackTarget = {
  title: string;
  artist: string;
  duration: number;
  uri?: string | null;
};

const defaultPalette: Palette = {
  a: 'rgb(166, 39, 75)',
  b: 'rgb(20, 86, 165)',
  c: 'rgb(117, 53, 117)',
};

const demoTracks: Track[] = [
  {
    title: 'Pulse Driver',
    artist: 'Neon Harbor',
    bpm: 142,
    duration: 88,
    accent: '#74f7ff',
    lyrics: [
      { time: 0, text: 'boot sequence humming under the glass' },
      { time: 8, text: 'city lights bend with every kick drum' },
      { time: 20, text: 'mirror waves trace the skyline' },
      { time: 33, text: 'hold the signal, keep it moving' },
      { time: 48, text: 'static blooms into color' },
      { time: 63, text: 'we ride the loop until the dawn' },
      { time: 78, text: 'fading out inside the neon' },
    ],
  },
  {
    title: 'Memory Card Sunset',
    artist: 'Analog Bloom',
    bpm: 118,
    duration: 96,
    accent: '#ff8b5e',
    lyrics: [
      { time: 0, text: 'orange rain on a low-poly horizon' },
      { time: 12, text: 'the room breathes in warm pixels' },
      { time: 27, text: 'every chord leaves a trail' },
      { time: 45, text: 'we keep the last frame glowing' },
      { time: 67, text: 'tomorrow loads from the same save' },
      { time: 84, text: 'and the sunset stays on repeat' },
    ],
  },
];

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function getLyricCacheKey(track: LyricTrackTarget) {
  const roundedDuration = Math.max(0, Math.round(track.duration));
  const uriKey = track.uri ? `${track.uri}|` : '';
  return `${uriKey}${track.artist}::${track.title}::${roundedDuration}`.toLowerCase();
}

function toRgb(r: number, g: number, b: number) {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function rgbToHsl(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) {
      h = (gn - bn) / d + (gn < bn ? 6 : 0);
    } else if (max === gn) {
      h = (bn - rn) / d + 2;
    } else {
      h = (rn - gn) / d + 4;
    }
    h /= 6;
  }

  return { h, s, l };
}

async function extractPalette(imageUrl: string): Promise<Palette> {
  const image = new Image();
  image.crossOrigin = 'anonymous';

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Failed loading album art'));
    image.src = imageUrl;
  });

  const canvas = document.createElement('canvas');
  const size = 56;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    return defaultPalette;
  }

  context.drawImage(image, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);

  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  let bestScore = -1;
  let best = { r: 166, g: 39, b: 75 };

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 120) {
      continue;
    }

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const { s, l } = rgbToHsl(r, g, b);

    red += r;
    green += g;
    blue += b;
    count += 1;

    const score = s * 0.8 + Math.abs(0.52 - l);
    if (score > bestScore) {
      bestScore = score;
      best = { r, g, b };
    }
  }

  if (count === 0) {
    return defaultPalette;
  }

  const avgR = red / count;
  const avgG = green / count;
  const avgB = blue / count;

  return {
    a: toRgb(best.r, best.g, best.b),
    b: toRgb(avgR, avgG, avgB),
    c: toRgb(avgB * 0.7 + best.r * 0.3, avgR * 0.6 + best.g * 0.4, avgG * 0.7 + best.b * 0.3),
  };
}

export default function App() {
  const [connected, setConnected] = useState(Boolean(loadSpotifyAuth()));
  const [status, setStatus] = useState('Connect Spotify to start playback');
  const [demoTrackIndex, setDemoTrackIndex] = useState(0);
  const [demoPlaying, setDemoPlaying] = useState(false);
  const [demoPosition, setDemoPosition] = useState(0);
  const [liveLyrics, setLiveLyrics] = useState<LyricLine[]>([]);
  const [livePosition, setLivePosition] = useState(0);
  const [liveDuration, setLiveDuration] = useState(0);
  const [livePlaying, setLivePlaying] = useState(false);
  const [liveAnchorPosition, setLiveAnchorPosition] = useState(0);
  const [liveAnchorAtMs, setLiveAnchorAtMs] = useState(0);
  const [palette, setPalette] = useState<Palette>(defaultPalette);
  const [view, setView] = useState<'song' | 'search' | 'lyrics'>('song');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchArtistResults, setSearchArtistResults] = useState<SearchArtistResult[]>([]);
  const [searchResults, setSearchResults] = useState<SearchTrackResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedArtist, setSelectedArtist] = useState<SearchArtistResult | null>(null);
  const [selectedArtistAlbums, setSelectedArtistAlbums] = useState<ArtistAlbumResult[]>([]);
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null);
  const [selectedAlbumTracks, setSelectedAlbumTracks] = useState<AlbumTrackResult[]>([]);
  const [albumTrackQuery, setAlbumTrackQuery] = useState('');
  const [artistLoading, setArtistLoading] = useState(false);
  const [artistError, setArtistError] = useState('');
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubPosition, setScrubPosition] = useState(0);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  const [lyricTrackOffset, setLyricTrackOffset] = useState(0);
  const lyricCacheRef = useRef<Record<string, LyricLine[]>>({});
  const activeLyricKeyRef = useRef<string | null>(null);
  const seekInFlightRef = useRef(false);
  const pendingSeekRef = useRef<number | null>(null);
  const lyricsViewportRef = useRef<HTMLDivElement | null>(null);
  const lyricsTrackRef = useRef<HTMLDivElement | null>(null);
  const lyricLineRefs = useRef<Array<HTMLParagraphElement | null>>([]);

  const player = useSpotifyPlayer(connected);

  useEffect(() => {
    void (async () => {
      try {
        const auth = await handleSpotifyRedirect();
        if (auth) {
          setConnected(true);
          setStatus('Spotify connected');
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Spotify auth failed');
      }
    })();
  }, []);

  useEffect(() => {
    if (!connected) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const token = await getValidAccessToken();
        if (!token && !cancelled) {
          setConnected(false);
          setStatus('Spotify session expired. Connect again.');
        }
      } catch {
        if (!cancelled) {
          setConnected(false);
          setStatus('Spotify session expired. Connect again.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected]);

  useEffect(() => {
    if (player.error) {
      setStatus(player.error);
      return;
    }

    if (!connected) {
      setStatus(hasSpotifyConfig() ? 'Connect Spotify to start playback' : 'Demo mode active. Add VITE_SPOTIFY_CLIENT_ID to enable Spotify.');
      return;
    }

    if (player.ready) {
      setStatus('Live playback synced');
      return;
    }

    if (player.webPlaybackUnavailable) {
      setStatus('Spotify connected in remote mode (web player unavailable in this runtime)');
      return;
    }

    setStatus('Spotify connected, preparing playback device');
  }, [connected, player.error, player.ready, player.webPlaybackUnavailable]);

  useEffect(() => {
    if (!player.state) {
      return;
    }

    setLivePosition(player.state.positionMs / 1000);
    setLiveDuration(player.state.durationMs / 1000);
    setLivePlaying(!player.state.isPaused);
    setLiveAnchorPosition(player.state.positionMs / 1000);
    setLiveAnchorAtMs(performance.now());
  }, [player.state?.positionMs, player.state?.durationMs, player.state?.isPaused]);

  useEffect(() => {
    if (!player.state || !livePlaying) {
      return;
    }

    const interval = window.setInterval(() => {
      const elapsedSeconds = Math.max(0, (performance.now() - liveAnchorAtMs) / 1000);
      const next = liveAnchorPosition + elapsedSeconds;
      setLivePosition(Math.min(liveDuration || next, next));
    }, 50);

    return () => window.clearInterval(interval);
  }, [player.state, liveAnchorAtMs, liveAnchorPosition, liveDuration, livePlaying]);

  useEffect(() => {
    if (!player.state) {
      return;
    }

    const currentTrack: LyricTrackTarget = {
      title: player.state.title,
      artist: player.state.artist,
      duration: player.state.durationMs / 1000,
      uri: player.state.contextUri,
    };
    const cacheKey = getLyricCacheKey(currentTrack);
    activeLyricKeyRef.current = cacheKey;

    const cachedLyrics = lyricCacheRef.current[cacheKey];
    if (cachedLyrics) {
      setLiveLyrics(cachedLyrics);
      setLyricsLoading(false);
      return;
    }

    setLyricsLoading(true);
    setLiveLyrics([]);

    let cancelled = false;
    void (async () => {
      const nextLyrics = await fetchSyncedLyrics(currentTrack.artist, currentTrack.title, currentTrack.duration);
      if (cancelled || activeLyricKeyRef.current !== cacheKey) {
        return;
      }

      lyricCacheRef.current[cacheKey] = nextLyrics;
      setLiveLyrics(nextLyrics);
      setLyricsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [player.state?.artist, player.state?.title, player.state?.durationMs, player.state?.contextUri]);

  useEffect(() => {
    if (!connected) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const nextTrack = await fetchQueueNextTrack();
        if (!nextTrack || cancelled) {
          return;
        }

        const nextTrackTarget: LyricTrackTarget = {
          title: nextTrack.title,
          artist: nextTrack.artist,
          duration: nextTrack.durationMs / 1000,
          uri: nextTrack.uri,
        };
        const cacheKey = getLyricCacheKey(nextTrackTarget);
        if (lyricCacheRef.current[cacheKey]) {
          return;
        }

        const prefetchedLyrics = await fetchSyncedLyrics(nextTrackTarget.artist, nextTrackTarget.title, nextTrackTarget.duration);
        if (cancelled) {
          return;
        }
        lyricCacheRef.current[cacheKey] = prefetchedLyrics;
      } catch {
        // Queue access may fail on some account/session states.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, player.state?.title, player.state?.artist, player.state?.contextUri]);

  useEffect(() => {
    if (!player.state?.albumArt) {
      return;
    }

    let active = true;
    void (async () => {
      try {
        const nextPalette = await extractPalette(player.state?.albumArt ?? '');
        if (active) {
          setPalette(nextPalette);
        }
      } catch {
        if (active) {
          setPalette(defaultPalette);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [player.state?.albumArt]);

  useEffect(() => {
    if (player.state || !demoPlaying) {
      return;
    }

    const activeDemoTrack = demoTracks[demoTrackIndex];
    const interval = window.setInterval(() => {
      setDemoPosition((current) => {
        const next = current + 0.1;
        if (next >= activeDemoTrack.duration) {
          setDemoTrackIndex((currentIndex) => (currentIndex + 1) % demoTracks.length);
          return 0;
        }
        return next;
      });
    }, 100);

    return () => window.clearInterval(interval);
  }, [demoPlaying, demoTrackIndex, player.state]);

  const fallbackTrack = demoTracks[demoTrackIndex];
  const activeTrack = player.state
    ? {
        title: player.state.title,
        artist: player.state.artist,
        bpm: fallbackTrack.bpm,
        duration: liveDuration || player.state.durationMs / 1000,
        accent: fallbackTrack.accent,
        lyrics: liveLyrics.length > 0 ? liveLyrics : [{ time: 0, text: lyricsLoading ? 'Loading synced lyrics...' : 'No synced lyrics found' }],
      }
    : fallbackTrack;

  const albumArt = player.state?.albumArt ?? '';
  const position = player.state ? livePosition : demoPosition;
  const effectivePosition = isScrubbing ? scrubPosition : position;
  const playing = player.state ? livePlaying : demoPlaying;
  const progress = Math.min(100, (effectivePosition / Math.max(activeTrack.duration, 1)) * 100);
  const activeLyricIndex = useMemo(() => {
    for (let i = activeTrack.lyrics.length - 1; i >= 0; i -= 1) {
      if (effectivePosition >= activeTrack.lyrics[i].time) {
        return i;
      }
    }
    return 0;
  }, [activeTrack.lyrics, effectivePosition]);

  const recalculateLyricOffset = useCallback(() => {
    const viewport = lyricsViewportRef.current;
    const track = lyricsTrackRef.current;
    const activeLine = lyricLineRefs.current[activeLyricIndex];
    if (!viewport || !track || !activeLine) {
      return;
    }

    const viewportCenter = viewport.clientHeight / 2;
    const activeLineCenter = track.offsetTop + activeLine.offsetTop + activeLine.offsetHeight / 2;
    setLyricTrackOffset(Math.round(viewportCenter - activeLineCenter));
  }, [activeLyricIndex]);

  useLayoutEffect(() => {
    recalculateLyricOffset();
  }, [recalculateLyricOffset, activeTrack.lyrics]);

  useEffect(() => {
    const viewport = lyricsViewportRef.current;
    if (!viewport) {
      return;
    }

    const observer = new ResizeObserver(() => {
      recalculateLyricOffset();
    });
    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, [recalculateLyricOffset]);

  async function connectSpotify() {
    if (!hasSpotifyConfig()) {
      setStatus('Missing VITE_SPOTIFY_CLIENT_ID');
      return;
    }

    try {
      const url = await createSpotifyAuthUrl();
      window.location.assign(url);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to start Spotify sign-in');
    }
  }

  async function disconnectSpotify() {
    clearSpotifyAuth();
    setConnected(false);
    setDemoPlaying(false);
    setLiveLyrics([]);
    setStatus('Spotify disconnected');
  }

  async function handlePlayPause() {
    if (player.state) {
      try {
        await player.togglePlay();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Unable to control Spotify playback');
      }
      return;
    }

    if (connected) {
      try {
        await toggleRemotePlayback(demoPlaying);
        return;
      } catch {
        // Fallback to demo transport.
      }
    }

    setDemoPlaying((current) => !current);
  }

  async function handleSeek(positionSeconds: number) {
    const boundedPosition = Math.max(0, Math.min(positionSeconds, activeTrack.duration));
    if (player.state) {
      try {
        await seekPlayback(boundedPosition * 1000);
        setLivePosition(boundedPosition);
        setLiveAnchorPosition(boundedPosition);
        setLiveAnchorAtMs(performance.now());
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Unable to seek playback');
      }
      return;
    }

    setDemoPosition(boundedPosition);
  }

  async function flushPendingSeek() {
    if (seekInFlightRef.current) {
      return;
    }

    const queuedSeek = pendingSeekRef.current;
    if (queuedSeek === null) {
      return;
    }

    seekInFlightRef.current = true;
    pendingSeekRef.current = null;
    await handleSeek(queuedSeek);
    seekInFlightRef.current = false;

    if (pendingSeekRef.current !== null) {
      void flushPendingSeek();
    }
  }

  function commitSeek(nextSeconds: number) {
    const boundedPosition = Math.max(0, Math.min(nextSeconds, activeTrack.duration));
    setScrubPosition(boundedPosition);
    setIsScrubbing(false);
    pendingSeekRef.current = boundedPosition;
    void flushPendingSeek();
  }

  async function handleSkip(direction: 'next' | 'previous') {
    if (player.state) {
      try {
        if (direction === 'next') {
          await player.nextTrack();
        } else {
          await player.previousTrack();
        }
        setLivePosition(0);
        setLiveAnchorPosition(0);
        setLiveAnchorAtMs(performance.now());
      } catch (error) {
        setStatus(error instanceof Error ? error.message : `Unable to skip ${direction}`);
      }
      return;
    }

    if (connected) {
      try {
        await skipRemoteTrack(direction);
        setLivePosition(0);
        setLiveAnchorPosition(0);
        setLiveAnchorAtMs(performance.now());
        return;
      } catch {
        // Fall through to demo controls if remote skip fails.
      }
    }

    setDemoTrackIndex((current) => {
      if (direction === 'next') {
        return (current + 1) % demoTracks.length;
      }
      return (current - 1 + demoTracks.length) % demoTracks.length;
    });
    setDemoPosition(0);
  }

  function handleScrubInput(nextSeconds: number) {
    const boundedPosition = Math.max(0, Math.min(nextSeconds, activeTrack.duration));
    setScrubPosition(boundedPosition);
  }

  async function handlePlayResult(uri: string) {
    try {
      await playTrackUri(uri, player.deviceId);
      setView('song');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to play track');
    }
  }

  async function handlePickArtist(artist: SearchArtistResult) {
    setSelectedArtist(artist);
    setSelectedAlbumId(null);
    setSelectedAlbumTracks([]);
    setAlbumTrackQuery('');
    setArtistError('');
    setArtistLoading(true);
    try {
      const albums = await fetchArtistAlbums(artist.id);
      setSelectedArtistAlbums(albums);
      if (albums[0]) {
        setSelectedAlbumId(albums[0].id);
        setSelectedAlbumTracks(await fetchAlbumTracks(albums[0].id));
      }
    } catch (error) {
      setSelectedArtistAlbums([]);
      setSelectedAlbumTracks([]);
      setStatus(error instanceof Error ? error.message : 'Unable to load artist discography');
      setArtistError(error instanceof Error ? error.message : 'Unable to load artist discography');
    } finally {
      setArtistLoading(false);
    }
  }

  async function handlePickAlbum(albumId: string) {
    setSelectedAlbumId(albumId);
    setArtistLoading(true);
    try {
      setSelectedAlbumTracks(await fetchAlbumTracks(albumId));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to load album tracks');
    } finally {
      setArtistLoading(false);
    }
  }

  async function handleQueueTrack(uri: string) {
    try {
      await queueTrackUri(uri, player.deviceId);
      setStatus('Track queued (or started if nothing was playing)');
      setView('song');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to queue track');
    }
  }

  const filteredAlbumTracks = useMemo(() => {
    const normalizedQuery = albumTrackQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return selectedAlbumTracks;
    }

    return selectedAlbumTracks.filter((track) => track.name.toLowerCase().includes(normalizedQuery));
  }, [albumTrackQuery, selectedAlbumTracks]);

  // Debounced Spotify search
  useEffect(() => {
    if (!connected || searchQuery.trim().length < 2) {
      setSearchArtistResults([]);
      setSearchResults([]);
      // Only clear artist state if query is cleared (user is typing fresh)
      if (searchQuery.trim().length < 2) {
        setSelectedArtist(null);
        setSelectedArtistAlbums([]);
        setSelectedAlbumId(null);
        setSelectedAlbumTracks([]);
        setArtistError('');
      }
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    const timer = setTimeout(() => {
      const query = searchQuery.trim();
      void Promise.all([searchArtists(query), searchTracks(query)])
        .then(([artists, tracks]) => {
          setSearchArtistResults(artists);
          setSearchResults(tracks);
          setSearchLoading(false);
        })
        .catch(() => {
          setSearchArtistResults([]);
          setSearchResults([]);
          setSearchLoading(false);
        });
    }, 320);
    return () => clearTimeout(timer);
  }, [searchQuery, connected]);

  const canConnect = hasSpotifyConfig();
  const canControl = Boolean(connected || player.state || !hasSpotifyConfig());
  const hasLyrics = liveLyrics.length > 0;
  const noLyricsAvailable = !lyricsLoading && !hasLyrics && Boolean(player.state);

  const progressBar = (
    <div className="progress-area">
      <div className="time-row">
        <span>{formatTime(effectivePosition)}</span>
        <span>-{formatTime(Math.max(activeTrack.duration - effectivePosition, 0))}</span>
      </div>
      <div className="progress-rail">
        <div className="progress-fill" style={{ width: `${progress}%` }} />
        <input
          className="progress-scrubber"
          type="range"
          min={0}
          max={Math.max(activeTrack.duration, 1)}
          step={0.1}
          value={effectivePosition}
          onPointerDown={() => { setIsScrubbing(true); setScrubPosition(position); }}
          onInput={(event) => handleScrubInput(event.currentTarget.valueAsNumber)}
          onPointerUp={(event) => commitSeek(event.currentTarget.valueAsNumber)}
          onTouchEnd={(event) => commitSeek(event.currentTarget.valueAsNumber)}
          onKeyUp={(event) => {
            const key = event.key;
            if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown') {
              commitSeek(event.currentTarget.valueAsNumber);
            }
          }}
          aria-label="Seek through track"
          disabled={!canControl}
        />
      </div>
    </div>
  );

  const controlsRow = (
    <div className="controls-row">
      <button type="button" className="control" onClick={() => void handleSkip('previous')} disabled={!canControl}>{'<<'}</button>
      <button type="button" className="control big" onClick={handlePlayPause} disabled={!canControl}>
        {playing ? '||' : '>'}
      </button>
      <button type="button" className="control" onClick={() => void handleSkip('next')} disabled={!canControl}>{'>>'}</button>
    </div>
  );

  return (
    <div
      className="app-shell"
      style={{
        ['--mesh-a' as string]: palette.a,
        ['--mesh-b' as string]: palette.b,
        ['--mesh-c' as string]: palette.c,
      }}
    >
      <div className="mesh" />

      <header className="topbar">
        <button type="button" className="close" aria-label="Close">×</button>
        <div className="topbar-right">
          <div className="status-chip">
            <span className={`status-dot ${connected ? 'online' : 'offline'}`} />
            <span>{status}</span>
          </div>
          <div className="view-tabs" role="tablist">
            {(['song', 'search', 'lyrics'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={view === tab}
                className={`view-tab${view === tab ? ' active' : ''}`}
                onClick={() => setView(tab)}
              >
                {tab === 'song' ? 'Song only' : tab === 'search' ? 'Search' : 'Lyrics'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {view === 'song' ? (
        <main className="player-screen">
          <div className="player-card">
            <div className="artwork-wrap">
              {albumArt
                ? <img className="artwork" src={albumArt} alt={`${activeTrack.title} cover`} />
                : <div className="artwork placeholder" />}
            </div>
            <div className="title-block">
              <h2>{activeTrack.title}</h2>
              <p>{activeTrack.artist}</p>
            </div>
            {progressBar}
            {controlsRow}
            <div className="actions">
              <button type="button" className="pill" onClick={connected ? disconnectSpotify : connectSpotify} disabled={!canConnect && !connected}>
                {connected ? 'Disconnect Spotify' : 'Connect Spotify'}
              </button>
            </div>
          </div>
        </main>
      ) : view === 'search' ? (
        <main className="search-screen">
          <section className="search-panel">
            <div className="search-input-wrap">
              <input
                className="search-input"
                type="search"
                placeholder="Search artists or song titles…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.currentTarget.value)}
                aria-label="Search Spotify artists or song titles"
                autoFocus
              />
            </div>
            <div className="search-results">
              {selectedArtist ? (
                <div className="artist-discography">
                  <div className="artist-banner">
                    <div className="artist-banner-art">
                      {selectedArtist.image ? <img src={selectedArtist.image} alt="" aria-hidden="true" /> : <div className="result-art-placeholder" />}
                    </div>
                    <div className="artist-banner-copy">
                      <p className="search-section-label">Discography</p>
                      <h3>{selectedArtist.name}</h3>
                      <button type="button" className="artist-close" onClick={() => setSelectedArtist(null)}>← Back to results</button>
                    </div>
                  </div>

                  {artistLoading && <p className="search-hint">Loading discography…</p>}
                  {!artistLoading && artistError && <p className="search-hint">{artistError}</p>}

                  {!artistLoading && selectedArtistAlbums.length > 0 && (
                    <div className="artist-albums">
                      <p className="search-section-label">Albums</p>
                      <div className="album-strip">
                        {selectedArtistAlbums.map((album) => (
                          <button
                            key={album.id}
                            type="button"
                            className={`album-card${selectedAlbumId === album.id ? ' active' : ''}`}
                            onClick={() => void handlePickAlbum(album.id)}
                          >
                            <div className="result-art album-art">
                              {album.image ? <img src={album.image} alt="" aria-hidden="true" /> : <div className="result-art-placeholder" />}
                            </div>
                            <span className="album-name">{album.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {!artistLoading && selectedAlbumTracks.length > 0 && (
                    <div className="artist-tracks">
                      <div className="artist-tracks-header">
                        <p className="search-section-label">Songs</p>
                        <input
                          className="album-track-search"
                          type="search"
                          placeholder="Filter songs in this album"
                          value={albumTrackQuery}
                          onChange={(event) => setAlbumTrackQuery(event.currentTarget.value)}
                          aria-label="Filter songs in selected album"
                        />
                      </div>
                      <div className="track-list">
                        {filteredAlbumTracks.map((track) => (
                          <div key={track.id} className="track-item">
                            <span className="track-number">{track.trackNumber}</span>
                            <span className="track-title">{track.name}</span>
                            <span className="track-duration">{formatTime(track.durationMs / 1000)}</span>
                            <div className="track-actions">
                              <button
                                type="button"
                                className="track-action-btn"
                                onClick={() => void handlePlayResult(track.uri)}
                              >
                                Play
                              </button>
                              <button
                                type="button"
                                className="track-action-btn secondary"
                                onClick={() => void handleQueueTrack(track.uri)}
                              >
                                Queue
                              </button>
                            </div>
                          </div>
                        ))}
                        {filteredAlbumTracks.length === 0 && (
                          <p className="search-hint">No songs match this filter</p>
                        )}
                      </div>
                    </div>
                  )}

                  {!artistLoading && selectedArtistAlbums.length > 0 && selectedAlbumTracks.length === 0 && (
                    <p className="search-hint">Pick an album to load its songs</p>
                  )}
                </div>
              ) : (
                <>
                  {!connected && <p className="search-hint">Connect Spotify to search</p>}
                  {connected && searchQuery.trim().length === 0 && <p className="search-hint">Type an artist name or song title</p>}
                  {connected && searchLoading && <p className="search-hint">Searching…</p>}
                  {connected && !searchLoading && searchArtistResults.length > 0 && <p className="search-section-label">Artists</p>}
                  {connected && !searchLoading && searchArtistResults.map((artist) => (
                    <button
                      key={artist.uri}
                      type="button"
                      className="search-result artist-result"
                      onClick={() => void handlePickArtist(artist)}
                    >
                      <div className="result-art artist-art">
                        {artist.image
                          ? <img src={artist.image} alt="" aria-hidden="true" />
                          : <div className="result-art-placeholder" />}
                      </div>
                      <div className="result-info">
                        <span className="result-title">{artist.name}</span>
                        <span className="result-artist">Artist</span>
                      </div>
                    </button>
                  ))}
                  {connected && !searchLoading && searchResults.length > 0 && <p className="search-section-label">Songs</p>}
                  {connected && !searchLoading && searchResults.map((result) => {
                    const isPlaying = player.state?.contextUri === result.uri;
                    return (
                      <div
                        key={result.uri}
                        className={`search-result${isPlaying ? ' playing' : ''}`}
                      >
                        <div className="result-art">
                          {result.albumArt
                            ? <img src={result.albumArt} alt="" aria-hidden="true" />
                            : <div className="result-art-placeholder" />}
                        </div>
                        <div className="result-info">
                          <span className="result-title">{result.title}</span>
                          <span className="result-artist">{result.artist}</span>
                        </div>
                        <span className="result-duration">{formatTime(result.durationMs / 1000)}</span>
                        <div className="result-actions">
                          <button
                            type="button"
                            className="track-action-btn"
                            onClick={() => void handlePlayResult(result.uri)}
                          >
                            Play
                          </button>
                          <button
                            type="button"
                            className="track-action-btn secondary"
                            onClick={() => void handleQueueTrack(result.uri)}
                          >
                            Queue
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </section>

          <aside className="side-player">
            <div className="artwork-wrap">
              {albumArt
                ? <img className="artwork" src={albumArt} alt={`${activeTrack.title} cover`} />
                : <div className="artwork placeholder" />}
            </div>
            <div className="title-block">
              <h2>{activeTrack.title}</h2>
              <p>{activeTrack.artist}</p>
            </div>
            {progressBar}
            {controlsRow}
            <div className="actions">
              <button type="button" className="pill" onClick={connected ? disconnectSpotify : connectSpotify} disabled={!canConnect && !connected}>
                {connected ? 'Disconnect' : 'Connect Spotify'}
              </button>
            </div>
          </aside>
        </main>
      ) : (
        <main className="stage">
          <section className="left-panel">
            <div className="artwork-wrap">
              {albumArt
                ? <img className="artwork" src={albumArt} alt={`${activeTrack.title} cover`} />
                : <div className="artwork placeholder" />}
            </div>
            {progressBar}
            <div className="title-block">
              <h2>{activeTrack.title}</h2>
              <p>{activeTrack.artist}</p>
            </div>
            {controlsRow}
            <div className="actions">
              <button type="button" className="pill" onClick={connected ? disconnectSpotify : connectSpotify} disabled={!canConnect && !connected}>
                {connected ? 'Disconnect' : 'Connect Spotify'}
              </button>
            </div>
          </section>

          <section className="lyrics-panel">
            {noLyricsAvailable ? (
              <div className="no-lyrics">
                <span className="no-lyrics-icon">♫</span>
                <p className="no-lyrics-label">No synced lyrics available</p>
              </div>
            ) : lyricsLoading ? (
              <div className="no-lyrics">
                <span className="no-lyrics-icon loading-pulse">♩</span>
                <p className="no-lyrics-label">Finding lyrics…</p>
              </div>
            ) : (
              <div className="lyrics-viewport" ref={lyricsViewportRef}>
                <div
                  className="lyrics-track"
                  style={{ ['--track-offset' as string]: `${lyricTrackOffset}px` }}
                  ref={lyricsTrackRef}
                >
                  {activeTrack.lyrics.map((line, idx) => {
                    const distance = Math.abs(idx - activeLyricIndex);
                    const depth = Math.min(distance, 4);
                    const isActive = distance === 0;
                    return (
                      <p
                        key={`${line.time}-${line.text}`}
                        className={isActive ? 'lyric active' : `lyric depth-${depth}`}
                        ref={(element) => { lyricLineRefs.current[idx] = element; }}
                      >
                        {line.text}
                      </p>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}
