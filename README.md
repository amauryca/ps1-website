# PS1 Spotify Visualizer

An interactive Vite + React prototype for a PS1-inspired Spotify visualizer. It supports Spotify PKCE login, the Web Playback SDK, synced lyrics from LRCLIB, and an Electron desktop shell that loads the same app.

## Setup

Create a `.env` file from `.env.example` and set:

- `VITE_SPOTIFY_CLIENT_ID`
- `VITE_SPOTIFY_REDIRECT_URI`

The redirect URI must match the value registered in your Spotify app.

## Run

```bash
npm install
npm run dev
```

## Desktop dev

```bash
npm run electron:dev
```

## Build

```bash
npm run build
```# ps1-website
# ps1-website
