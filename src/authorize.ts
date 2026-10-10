import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { URL } from 'node:url';
import { getSpotifyAuthConfig } from './config.js';
import type { ISpotifyTokenResponse } from './models/spotify.js';
import { REQUESTED_SCOPES } from './scopes.js';

const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';

interface ICallbackResult {
  code: string;
}

const config = getSpotifyAuthConfig();
const redirectUrl = new URL(config.redirectUri);

if (redirectUrl.hostname !== '127.0.0.1') {
  throw new Error(
    'For this local bootstrap script, SPOTIFY_REDIRECT_URI must use 127.0.0.1, not localhost.',
  );
}

const state = randomBytes(24).toString('hex');
const authUrl = new URL(SPOTIFY_AUTHORIZE_URL);
authUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: config.clientId,
  scope: REQUESTED_SCOPES.join(' '),
  redirect_uri: config.redirectUri,
  state,
}).toString();

function waitForAuthorizationCode(): Promise<ICallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      try {
        const requestUrl = new URL(
          request.url ?? '/',
          `http://${request.headers.host}`,
        );

        if (requestUrl.pathname !== redirectUrl.pathname) {
          response.writeHead(404).end('Not found');
          return;
        }

        const returnedState = requestUrl.searchParams.get('state');
        const error = requestUrl.searchParams.get('error');
        const code = requestUrl.searchParams.get('code');

        if (error) {
          response.writeHead(400).end(`Spotify authorization failed: ${error}`);
          server.close();
          reject(new Error(`Spotify authorization failed: ${error}`));
          return;
        }

        if (returnedState !== state) {
          response.writeHead(400).end('State mismatch');
          server.close();
          reject(new Error('OAuth state mismatch'));
          return;
        }

        if (!code) {
          response.writeHead(400).end('Missing authorization code');
          server.close();
          reject(new Error('Spotify callback did not include a code'));
          return;
        }

        response
          .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Spotify authorized. You can close this tab and return to the terminal.');

        server.close();
        resolve({ code });
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    server.on('error', reject);
    server.listen(Number(redirectUrl.port), redirectUrl.hostname);
  });
}

async function exchangeCode(code: string): Promise<ISpotifyTokenResponse> {
  const credentials = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
  ).toString('base64');

  const response = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Token exchange failed (${response.status}): ${await response.text()}`,
    );
  }

  return (await response.json()) as ISpotifyTokenResponse;
}

process.stdout.write('\nOpen this URL in your browser and approve access:\n\n');
process.stdout.write(`${authUrl.toString()}\n\n`);
process.stdout.write(`Waiting for Spotify callback on ${config.redirectUri} ...\n`);

const { code } = await waitForAuthorizationCode();
const token = await exchangeCode(code);

if (!token.refresh_token) {
  throw new Error('Spotify did not return a refresh token. Revoke the app grant and authorize again.');
}

process.stdout.write('\nAuthorization complete. Put this in your .env:\n\n');
process.stdout.write(`SPOTIFY_REFRESH_TOKEN=${token.refresh_token}\n\n`);
