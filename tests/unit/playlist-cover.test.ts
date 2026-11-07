import { describe, expect, it, vi } from 'vitest';
import { SpotifyClient } from '../../src/spotify.js';
import { validateCoverJpeg } from '../../src/services/playlist-cover.js';
// A real 8x8 JPEG fixture with frame, tables, and scan data.
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDyuiiivdPmj//Z';
function client(scopes = ['ugc-image-upload', 'playlist-modify-private']) {
  const fetch = vi.fn(async () => new Response(null, { status: 202 }));
  const spotify = new SpotifyClient({ clientId: '', clientSecret: '', refreshToken: '', redirectUri: '' }, {
    fetch: fetch as typeof globalThis.fetch,
    tokenProvider: { getAccessToken: async () => ({ accessToken: 'test-token', expiresInSeconds: 3600, scopes }) },
  });
  return { spotify, fetch };
}
describe('playlist covers', () => {
  it('sends an unquoted base64 JPEG body using the shared authenticated transport', async () => {
    const { spotify, fetch } = client();
    await spotify.uploadPlaylistCover('playlist1', jpeg);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/playlists/playlist1/images');
    expect(init.body).toBe(jpeg);
    expect(init.headers).toMatchObject({ 'Content-Type': 'image/jpeg', Authorization: 'Bearer test-token' });
  });
  it('rejects malformed, non-JPEG, and oversized encoded payloads before making requests', async () => {
    expect(() => validateCoverJpeg('not-base64!')).toThrow(/JPEG/);
    expect(() => validateCoverJpeg(Buffer.from('PNG').toString('base64'))).toThrow(/JPEG/);
    expect(() => validateCoverJpeg(Buffer.from([255,216,255,224,0,2,255,217]).toString('base64'))).toThrow(/JPEG/);
    expect(() => validateCoverJpeg('A'.repeat(262148))).toThrow(/256/);
    const { spotify, fetch } = client();
    await expect(spotify.uploadPlaylistCover('p', 'bad')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails without the cover scope while leaving normal Spotify credentials usable', async () => {
    const { spotify, fetch } = client(['playlist-modify-private']);
    await expect(spotify.uploadPlaylistCover('p', jpeg)).rejects.toThrow(/ugc-image-upload/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not retry an upload with an unknown outcome', async () => {
    const { spotify, fetch } = client();
    fetch.mockRejectedValue(new TypeError('network lost'));
    await expect(spotify.uploadPlaylistCover('p', jpeg)).rejects.toThrow(/outcome is unknown/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
