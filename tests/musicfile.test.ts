// Music-file helpers: accept-list filtering and display-name sanitization
// (IndexedDB/File paths are browser-only and not exercised in Node).

import { describe, expect, it } from 'vitest';
import {
  MUSIC_ACCEPT,
  MUSIC_EXTENSIONS,
  clearStoredMusic,
  isAcceptedMusicFile,
  loadStoredMusic,
  sanitizeMusicName,
} from '../src/game/musicfile';

describe('music picker accept list', () => {
  it('offers audio/* with the mp3 family extensions', () => {
    expect(Object.keys(MUSIC_ACCEPT)).toEqual(['audio/*']);
    expect(MUSIC_ACCEPT['audio/*']).toEqual(MUSIC_EXTENSIONS);
    expect(MUSIC_EXTENSIONS).toContain('.mp3');
  });
});

describe('isAcceptedMusicFile', () => {
  it('accepts any audio MIME type', () => {
    expect(isAcceptedMusicFile({ name: 'track.bin', type: 'audio/mpeg' })).toBe(true);
    expect(isAcceptedMusicFile({ name: 'track', type: 'Audio/OGG' })).toBe(true);
  });

  it('accepts known extensions case-insensitively when the type is missing', () => {
    expect(isAcceptedMusicFile({ name: 'Theme.MP3', type: '' })).toBe(true);
    expect(isAcceptedMusicFile({ name: 'theme.ogg' })).toBe(true);
    expect(isAcceptedMusicFile({ name: 'theme.m4a', type: 'application/octet-stream' })).toBe(true);
    expect(isAcceptedMusicFile({ name: 'theme.wav' })).toBe(true);
  });

  it('rejects non-audio files and lookalike extensions', () => {
    expect(isAcceptedMusicFile({ name: 'cover.png', type: 'image/png' })).toBe(false);
    expect(isAcceptedMusicFile({ name: 'notes.txt' })).toBe(false);
    expect(isAcceptedMusicFile({ name: 'fake.mp3.exe', type: 'application/x-msdownload' })).toBe(false);
    expect(isAcceptedMusicFile({ name: 'noextension' })).toBe(false);
  });
});

describe('storage guards', () => {
  it('loads nothing and clears safely without IndexedDB', async () => {
    await expect(loadStoredMusic()).resolves.toBeNull();
    await expect(clearStoredMusic()).resolves.toBeUndefined();
  });
});

describe('sanitizeMusicName', () => {
  it('keeps a plain file name', () => {
    expect(sanitizeMusicName('soundtrack.mp3')).toBe('soundtrack.mp3');
  });

  it('keeps only the basename of POSIX and Windows paths', () => {
    expect(sanitizeMusicName('/home/me/Music/theme.ogg')).toBe('theme.ogg');
    expect(sanitizeMusicName('C:\\Users\\me\\song.wav')).toBe('song.wav');
  });

  it('strips control characters and surrounding whitespace', () => {
    expect(sanitizeMusicName('  my\u0000song\n.mp3  ')).toBe('mysong.mp3');
    expect(sanitizeMusicName('\u007f')).toBe('Custom soundtrack');
  });

  it('falls back for an empty name', () => {
    expect(sanitizeMusicName('')).toBe('Custom soundtrack');
    expect(sanitizeMusicName('   ')).toBe('Custom soundtrack');
    expect(sanitizeMusicName('/home/me/')).toBe('Custom soundtrack');
  });

  it('caps the display name at 120 characters', () => {
    const long = 'a'.repeat(200) + '.mp3';
    expect(sanitizeMusicName(long)).toHaveLength(120);
  });
});
