/**
 * VoxelLab on Cloudflare Workers.
 *
 * Single Worker that serves the built frontend (static assets) and the
 * multiplayer backend:
 *   - WebSocket  GET /ws?worldId=<id>  -> routed to the WorldDO for that world
 *   - REST       GET /api/worlds       -> lobby world list
 *                DELETE /api/worlds/:id
 *                GET /api/scenes, POST /api/save/:name, GET /api/load/:name
 *                GET /health
 *
 * Everything else falls through to the static assets (the Vite build in dist/).
 */

import { WorldDO } from './WorldDO.js';
import { LobbyDO } from './LobbyDO.js';
import { SceneDO } from './SceneDO.js';
import { WORLD_LIST } from '../shared/messages.js';

export { WorldDO, LobbyDO, SceneDO };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // --- WebSocket: route to the world's Durable Object ---
    if (path === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade && upgrade.toLowerCase() === 'websocket') {
        const worldId = (url.searchParams.get('worldId') || 'default').trim().slice(0, 50) || 'default';
        const id = env.WORLD.idFromName(worldId);
        return env.WORLD.get(id).fetch(request);
      }
      return new Response('Expected WebSocket upgrade', { status: 426, headers: CORS });
    }

    const lobby = () => env.LOBBY.get(env.LOBBY.idFromName('lobby'));
    const scenes = () => env.SCENE.get(env.SCENE.idFromName('scenes'));

    // --- World list ---
    if (request.method === 'GET' && path === '/api/worlds') {
      const worlds = await lobby().list();
      return json({ type: WORLD_LIST, worlds });
    }

    // --- Delete world ---
    if (request.method === 'DELETE' && path.startsWith('/api/worlds/')) {
      const worldId = decodeURIComponent(path.slice('/api/worlds/'.length));
      if (!worldId) return json({ error: 'World ID is required' }, 400);
      const id = env.WORLD.idFromName(worldId);
      await env.WORLD.get(id).deleteWorld();
      return json({ ok: true });
    }

    // --- Offline scene storage ---
    if (request.method === 'GET' && path === '/api/scenes') {
      return json(await scenes().list());
    }

    let match;
    if ((match = path.match(/^\/api\/save\/([\w-]+)$/)) && request.method === 'POST') {
      const name = match[1];
      const body = await request.text();
      await scenes().save(name, body);
      return json({ ok: true });
    }

    if ((match = path.match(/^\/api\/load\/([\w-]+)$/)) && request.method === 'GET') {
      const name = match[1];
      const data = await scenes().load(name);
      if (data === null) return json({ error: 'Scene not found' }, 404);
      return new Response(data, {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // --- Health ---
    if (request.method === 'GET' && path === '/health') {
      const worlds = await lobby().list();
      return json({ status: 'ok', worlds: worlds.length });
    }

    // --- Static assets (frontend) ---
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not Found', { status: 404, headers: CORS });
  },
};
