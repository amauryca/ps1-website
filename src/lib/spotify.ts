import type { PlaybackSnapshot } from '../types';

const SPOTIFY_AUTH_ENDPOINT = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'user-read-private',
  'user-read-email',
  'streaming',
];

type StoredAuth = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

type TokenResponse = {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token?: string;
};

type SpotifyImage = {
  url: string;
  height: number | null;
  width: number | null;
};

type PlaybackStateResponse = {
  is_playing: boolean;
  progress_ms: number | null;
  item: {
    name: string;
    duration_ms: number;
    artists: Array<{ name: string }>;
    album: {
      images: SpotifyImage[];
    };
    uri: string;
  } | null;
  device: {
    id: string | null;
  } | null;
};

type QueueTrackItem = {
  name: string;
  duration_ms: number;
  uri: string;
  artists: Array<{ name: string }>;
};

type QueueResponse = {
  currently_playing: QueueTrackItem | null;
  queue: QueueTrackItem[];
};

const storageKey = 'ps1_spotify_auth';
const verifierKey = 'ps1_spotify_verifier';
const redirectKey = 'ps1_spotify_redirect';

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export function getSpotifyClientId() {
  return import.meta.env.VITE_SPOTIFY_CLIENT_ID as string | undefined;
}

export function getSpotifyRedirectUri() {
  const configuredRedirect = import.meta.env.VITE_SPOTIFY_REDIRECT_URI as string | undefined;
  if (!configuredRedirect) {
    return `${window.location.origin}/`;
  }

  try {
    const configuredUrl = new URL(configuredRedirect);
    const currentUrl = new URL(window.location.href);
    const shouldNormalizeLoopbackHost =
      configuredUrl.port === currentUrl.port
      && isLoopbackHost(configuredUrl.hostname)
      && isLoopbackHost(currentUrl.hostname)
      && configuredUrl.origin !== currentUrl.origin;

    if (shouldNormalizeLoopbackHost) {
      return `${currentUrl.origin}${configuredUrl.pathname}${configuredUrl.search}${configuredUrl.hash}`;
    }
  } catch {
    return configuredRedirect;
  }

  return configuredRedirect;
}

export function hasSpotifyConfig() {
  return Boolean(getSpotifyClientId());
}

function base64UrlEncode(bytes: ArrayBuffer) {
  const chars = String.fromCharCode(...new Uint8Array(bytes));
  return window.btoa(chars).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

async function sha256(plain: string) {
  const encoder = new TextEncoder();
  return window.crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

export function randomVerifier() {
  const array = new Uint8Array(64);
  window.crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createSpotifyAuthUrl() {
  const clientId = getSpotifyClientId();
  if (!clientId) {
    throw new Error('Missing VITE_SPOTIFY_CLIENT_ID');
  }

  const verifier = randomVerifier();
  const challenge = base64UrlEncode(await sha256(verifier));
  const redirectUri = getSpotifyRedirectUri();

  window.localStorage.setItem(verifierKey, verifier);
  window.localStorage.setItem(redirectKey, redirectUri);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SPOTIFY_SCOPES.join(' '),
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });

  return `${SPOTIFY_AUTH_ENDPOINT}?${params.toString()}`;
}

function readAuth(): StoredAuth | null {
  const raw = window.localStorage.getItem(storageKey);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as StoredAuth;
  } catch {
    return null;
  }
}

function writeAuth(auth: StoredAuth | null) {
  if (!auth) {
    window.localStorage.removeItem(storageKey);
    return;
  }

  window.localStorage.setItem(storageKey, JSON.stringify(auth));
}

async function exchangeCodeForTokens(code: string) {
  const verifier = window.localStorage.getItem(verifierKey);
  const redirectUri = window.localStorage.getItem(redirectKey) ?? getSpotifyRedirectUri();
  const clientId = getSpotifyClientId();

  if (!verifier || !clientId) {
    throw new Error('Missing Spotify PKCE verifier or client id');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Spotify token exchange failed (${response.status})`);
  }

  const data = (await response.json()) as TokenResponse;
  const auth: StoredAuth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  writeAuth(auth);
  window.localStorage.removeItem(verifierKey);
  window.localStorage.removeItem(redirectKey);
  return auth;
}

async function refreshAccessToken(refreshToken: string) {
  const clientId = getSpotifyClientId();
  if (!clientId) {
    throw new Error('Missing VITE_SPOTIFY_CLIENT_ID');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch(SPOTIFY_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Spotify token refresh failed (${response.status})`);
  }

  const data = (await response.json()) as TokenResponse;
  const current = readAuth();
  const auth: StoredAuth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? current?.refreshToken ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  writeAuth(auth);
  return auth;
}

export async function handleSpotifyRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    throw new Error(error);
  }

  if (!code) {
    return null;
  }

  url.searchParams.delete('code');
  url.searchParams.delete('state');
  window.history.replaceState({}, document.title, '/');
  return exchangeCodeForTokens(code);
}

export function loadSpotifyAuth() {
  return readAuth();
}

export function clearSpotifyAuth() {
  writeAuth(null);
}

export async function getValidAccessToken() {
  const auth = readAuth();
  if (!auth) {
    return null;
  }

  if (auth.expiresAt > Date.now() + 60_000) {
    return auth.accessToken;
  }

  if (!auth.refreshToken) {
    writeAuth(null);
    return null;
  }

  const refreshed = await refreshAccessToken(auth.refreshToken);
  return refreshed.accessToken;
}

type SpotifyDevice = {
  id: string;
  is_active: boolean;
  is_restricted: boolean;
};

type DevicesResponse = {
  devices: SpotifyDevice[];
};

async function fetchPlaybackDevices(accessToken: string): Promise<SpotifyDevice[]> {
  const response = await fetch(`${SPOTIFY_API_BASE}/me/player/devices`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return [];
  }

  const data = (await response.json()) as DevicesResponse;
  return data.devices ?? [];
}

async function ensurePlaybackDevice(accessToken: string, preferredDeviceId: string | null): Promise<string | null> {
  // If we have the Web Playback SDK device ID, use it directly — it's valid
  // as soon as the 'ready' event fires and avoids a race with the devices API
  // (the browser device can take several seconds to appear in that list).
  if (preferredDeviceId) {
    return preferredDeviceId;
  }

  const devices = await fetchPlaybackDevices(accessToken);
  const availableDevices = devices.filter((device) => !device.is_restricted);

  if (availableDevices.length === 0) {
    return null;
  }

  const activeDevice = availableDevices.find((device) => device.is_active);
  if (activeDevice) {
    return activeDevice.id;
  }

  const fallbackDevice = availableDevices[0];
  await transferPlaybackToDevice(fallbackDevice.id, false);
  return fallbackDevice.id;
}

export async function fetchCurrentPlayback(): Promise<PlaybackSnapshot | null> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return null;
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/me/player`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch playback state (${response.status})`);
  }

  const data = (await response.json()) as PlaybackStateResponse;
  if (!data.item) {
    return null;
  }

  return {
    isPlaying: data.is_playing,
    progressMs: data.progress_ms ?? 0,
    durationMs: data.item.duration_ms,
    title: data.item.name,
    artist: data.item.artists.map((artist) => artist.name).join(', '),
    albumArt: data.item.album.images[0]?.url ?? '',
    deviceId: data.device?.id ?? null,
    contextUri: data.item.uri,
  };
}

export async function transferPlaybackToDevice(deviceId: string, play = false) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error('No active Spotify session');
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/me/player`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_ids: [deviceId], play }),
  });

  if (!response.ok) {
    throw new Error(`Failed to transfer playback (${response.status})`);
  }
}

export async function toggleRemotePlayback(isPlaying: boolean) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error('No active Spotify session');
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/me/player/${isPlaying ? 'pause' : 'play'}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to control playback (${response.status})`);
  }
}

export async function seekPlayback(positionMs: number) {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error('No active Spotify session');
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/me/player/seek?position_ms=${Math.max(0, Math.floor(positionMs))}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to seek playback (${response.status})`);
  }
}

export async function skipRemoteTrack(direction: 'next' | 'previous') {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    throw new Error('No active Spotify session');
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/me/player/${direction}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to skip ${direction} track (${response.status})`);
  }
}

export type SearchTrackResult = {
  uri: string;
  title: string;
  artist: string;
  albumArt: string;
  durationMs: number;
};

export type SearchArtistResult = {
  id: string;
  uri: string;
  name: string;
  image: string;
};

export type ArtistAlbumResult = {
  id: string;
  name: string;
  albumType: string;
  image: string;
  releaseDate: string;
};

export type AlbumTrackResult = {
  id: string;
  uri: string;
  name: string;
  trackNumber: number;
  durationMs: number;
};

type SearchResponse = {
  artists: {
    items: Array<{
      id: string;
      uri: string;
      name: string;
      images: SpotifyImage[];
    }>;
  };
  tracks: {
    items: Array<{
      uri: string;
      name: string;
      duration_ms: number;
      artists: Array<{ name: string }>;
      album: { images: SpotifyImage[] };
    }>;
  };
};

export async function searchTracks(query: string): Promise<SearchTrackResult[]> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return [];

  const params = new URLSearchParams({ q: query, type: 'track', limit: '25', market: 'from_token' });
  const response = await fetch(`${SPOTIFY_API_BASE}/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return [];

  const data = (await response.json()) as SearchResponse;
  return data.tracks.items.map((item) => ({
    uri: item.uri,
    title: item.name,
    artist: item.artists.map((a) => a.name).join(', '),
    albumArt: item.album.images[0]?.url ?? '',
    durationMs: item.duration_ms,
  }));
}

export async function searchArtists(query: string): Promise<SearchArtistResult[]> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return [];

  const params = new URLSearchParams({ q: query, type: 'artist', limit: '10', market: 'from_token' });
  const response = await fetch(`${SPOTIFY_API_BASE}/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return [];

  const data = (await response.json()) as SearchResponse;
  return data.artists.items.map((item) => ({
    id: item.id,
    uri: item.uri,
    name: item.name,
    image: item.images[0]?.url ?? '',
  }));
}

type ArtistAlbumsResponse = {
  items: Array<{
    id: string;
    name: string;
    album_type: string;
    images: SpotifyImage[];
    release_date: string;
  }>;
};

type AlbumTracksResponse = {
  items: Array<{
    id: string;
    uri: string;
    name: string;
    track_number: number;
    duration_ms: number;
  }>;
};

export async function fetchArtistAlbums(artistId: string): Promise<ArtistAlbumResult[]> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return [];

  const params = new URLSearchParams({
    include_groups: 'album,single',
    limit: '10',
  });
  const response = await fetch(`${SPOTIFY_API_BASE}/artists/${artistId}/albums?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return [];

  const data = (await response.json()) as ArtistAlbumsResponse;
  return data.items.map((item) => ({
    id: item.id,
    name: item.name,
    albumType: item.album_type,
    image: item.images[0]?.url ?? '',
    releaseDate: item.release_date,
  }));
}

export async function fetchAlbumTracks(albumId: string): Promise<AlbumTrackResult[]> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return [];

  const response = await fetch(`${SPOTIFY_API_BASE}/albums/${albumId}/tracks?limit=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return [];

  const data = (await response.json()) as AlbumTracksResponse;
  return data.items.map((item) => ({
    id: item.id,
    uri: item.uri,
    name: item.name,
    trackNumber: item.track_number,
    durationMs: item.duration_ms,
  }));
}

export async function queueTrackUri(uri: string, deviceId: string | null): Promise<void> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new Error('No active Spotify session');

  const targetDeviceId = await ensurePlaybackDevice(accessToken, deviceId);
  const currentPlayback = await fetchCurrentPlayback().catch(() => null);

  if (!currentPlayback) {
    await playTrackUri(uri, targetDeviceId);
    return;
  }

  const qs = new URLSearchParams({ uri });
  if (targetDeviceId) {
    qs.set('device_id', targetDeviceId);
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/me/player/queue?${qs.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to queue track (${response.status})`);
  }
}

export async function playTrackUri(uri: string, deviceId: string | null): Promise<void> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) throw new Error('No active Spotify session');

  const targetDeviceId = await ensurePlaybackDevice(accessToken, deviceId);
  const qs = targetDeviceId ? `?device_id=${encodeURIComponent(targetDeviceId)}` : '';
  const response = await fetch(`${SPOTIFY_API_BASE}/me/player/play${qs}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ uris: [uri] }),
  });

  if (!response.ok && response.status !== 204) {
    throw new Error(`Failed to play track (${response.status})`);
  }
}

export async function fetchQueueNextTrack(): Promise<{
  title: string;
  artist: string;
  durationMs: number;
  uri: string;
} | null> {
  const accessToken = await getValidAccessToken();
  if (!accessToken) {
    return null;
  }

  const response = await fetch(`${SPOTIFY_API_BASE}/me/player/queue`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as QueueResponse;
  const nextTrack = data.queue?.[0];
  if (!nextTrack) {
    return null;
  }

  return {
    title: nextTrack.name,
    artist: nextTrack.artists.map((artist) => artist.name).join(', '),
    durationMs: nextTrack.duration_ms,
    uri: nextTrack.uri,
  };
}
