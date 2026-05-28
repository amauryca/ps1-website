import type { LyricLine } from '../types';

type LRCLibResponse = {
  id: number;
  instrumental: boolean;
  syncedLyrics?:
    | string
    | Array<{
        timestamp: number;
        line: string;
      }>;
  plainLyrics?: string;
  artistName?: string;
  trackName?: string;
  duration?: number;
};

function normalize(text: string) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function parseLrcString(value: string): LyricLine[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const matches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
      const text = line.replace(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g, '').trim();
      if (matches.length === 0 || text.length === 0) {
        return [];
      }

      return matches.map((match) => {
        const minutes = Number(match[1] ?? '0');
        const seconds = Number(match[2] ?? '0');
        const fractionRaw = match[3] ?? '0';
        const paddedFraction = fractionRaw.padEnd(3, '0').slice(0, 3);
        const milliseconds = Number(paddedFraction);

        return {
          time: minutes * 60 + seconds + milliseconds / 1000,
          text,
        };
      });
    })
    .sort((a, b) => a.time - b.time);
}

function scoreSearchCandidate(item: LRCLibResponse, artist: string, title: string, durationSeconds?: number) {
  const artistNorm = normalize(artist);
  const titleNorm = normalize(title);
  const candidateArtist = normalize(item.artistName ?? '');
  const candidateTitle = normalize(item.trackName ?? '');

  let score = 0;
  if (candidateArtist === artistNorm) {
    score += 5;
  } else if (candidateArtist.includes(artistNorm) || artistNorm.includes(candidateArtist)) {
    score += 3;
  }

  if (candidateTitle === titleNorm) {
    score += 5;
  } else if (candidateTitle.includes(titleNorm) || titleNorm.includes(candidateTitle)) {
    score += 3;
  }

  if (typeof durationSeconds === 'number' && typeof item.duration === 'number') {
    const durationDelta = Math.abs(item.duration - durationSeconds);
    if (durationDelta <= 1.5) {
      score += 3;
    } else if (durationDelta <= 4) {
      score += 2;
    } else if (durationDelta <= 8) {
      score += 1;
    }
  }

  return score;
}

function parseLines(data: LRCLibResponse): LyricLine[] {
  if (data.instrumental) {
    return [];
  }

  const synced = Array.isArray(data.syncedLyrics)
    ? data.syncedLyrics
        .filter((entry) => entry.line.trim().length > 0)
        .map((entry) => ({
          time: Math.max(0, entry.timestamp / 1000),
          text: entry.line.trim(),
        }))
    : typeof data.syncedLyrics === 'string'
      ? parseLrcString(data.syncedLyrics)
      : [];

  if (synced.length > 0) {
    return synced;
  }

  return (data.plainLyrics ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => ({
      time: index * 4,
      text: line,
    }));
}

async function fetchSearch(artist: string, title: string, durationSeconds?: number): Promise<LyricLine[]> {
  const query = `${artist} ${title}`.trim();
  const url = new URL('https://lrclib.net/api/search');
  url.searchParams.set('q', query);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return [];
  }

  const results = (await response.json()) as LRCLibResponse[];
  if (!Array.isArray(results) || results.length === 0) {
    return [];
  }

  const ranked = [...results].sort(
    (a, b) => scoreSearchCandidate(b, artist, title, durationSeconds) - scoreSearchCandidate(a, artist, title, durationSeconds),
  );

  const best = ranked[0];

  return parseLines(best);
}

export async function fetchSyncedLyrics(artist: string, title: string, durationSeconds?: number): Promise<LyricLine[]> {
  return fetchSearch(artist, title, durationSeconds);
}
