import crypto from 'node:crypto';

const jsonHeaders = { 'Content-Type': 'application/json' };

function reply(res, status, body) { return res.status(status).json(body); }
function code() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function token() { return crypto.randomUUID(); }
function clean(player) { const { token: _, ...safe } = player; return safe; }

async function db(path, options = {}) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY를 설정해 주세요.');
  const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, Prefer: 'return=representation', ...options.headers }
  });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(data.message || data.hint || 'Supabase 요청에 실패했습니다.');
  return data;
}
async function roomByCode(roomCode) { return (await db(`game_rooms?code=eq.${encodeURIComponent(roomCode)}&select=*`))[0]; }
async function players(roomCode) { return db(`game_players?room_code=eq.${encodeURIComponent(roomCode)}&select=*&order=slot.asc`); }
async function authenticated(roomCode, playerToken) {
  const found = (await db(`game_players?room_code=eq.${encodeURIComponent(roomCode)}&token=eq.${encodeURIComponent(playerToken)}&select=*`))[0];
  if (!found) throw new Error('방 참가 정보가 유효하지 않습니다.');
  return found;
}
async function snapshot(roomCode, playerToken) {
  await authenticated(roomCode, playerToken);
  const room = await roomByCode(roomCode);
  if (!room) throw new Error('방을 찾을 수 없습니다.');
  return { room, players: (await players(roomCode)).map(clean) };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'POST만 허용됩니다.' });
  try {
    const body = req.body || {}, action = body.action, roomCode = String(body.roomCode || '').toUpperCase();
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('온라인 대전은 SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY 설정이 필요합니다.');
    if (action === 'create') {
      let created; for (let i = 0; i < 5 && !created; i++) { const roomCodeCandidate = code(); try { await db('game_rooms', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ code: roomCodeCandidate }) }); created = roomCodeCandidate; } catch {} }
      if (!created) throw new Error('방 코드를 만들지 못했습니다. 다시 시도해 주세요.');
      const playerToken = token();
      await db('game_players', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ room_code: created, slot: 1, token: playerToken, name: body.name || '플레이어 1' }) });
      return reply(res, 200, { roomCode: created, token: playerToken, slot: 1, ...(await snapshot(created, playerToken)) });
    }
    if (action === 'join') {
      const room = await roomByCode(roomCode); if (!room) throw new Error('방 코드를 찾을 수 없습니다.');
      const current = await players(roomCode); if (current.some(player => player.slot === 2)) throw new Error('이미 두 명이 참가한 방입니다.');
      const playerToken = token();
      await db('game_players', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ room_code: roomCode, slot: 2, token: playerToken, name: body.name || '플레이어 2' }) });
      return reply(res, 200, { roomCode, token: playerToken, slot: 2, ...(await snapshot(roomCode, playerToken)) });
    }
    if (action === 'state') return reply(res, 200, await snapshot(roomCode, body.token));
    const self = await authenticated(roomCode, body.token);
    if (action === 'saveCards') {
      await db(`game_players?room_code=eq.${encodeURIComponent(roomCode)}&token=eq.${encodeURIComponent(body.token)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ cards: body.cards, ready: false }) });
      return reply(res, 200, await snapshot(roomCode, body.token));
    }
    if (action === 'ready') {
      await db(`game_players?room_code=eq.${encodeURIComponent(roomCode)}&token=eq.${encodeURIComponent(body.token)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ ready: true }) });
      const current = await players(roomCode); if (current.length === 2 && current.every(player => player.ready)) await db(`game_rooms?code=eq.${encodeURIComponent(roomCode)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ status: 'reviewing' }) });
      return reply(res, 200, await snapshot(roomCode, body.token));
    }
    if (action === 'finalize') {
      if (self.slot !== 1) throw new Error('방장만 최종 상성표를 확정할 수 있습니다.');
      await db(`game_rooms?code=eq.${encodeURIComponent(roomCode)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify(body.approved ? { status: 'battle', final_rules: body.finalRules } : { status: 'lobby', final_rules: null }) });
      if (!body.approved) await db(`game_players?room_code=eq.${encodeURIComponent(roomCode)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ ready: false }) });
      return reply(res, 200, await snapshot(roomCode, body.token));
    }
    if (action === 'choose') {
      await db(`game_players?room_code=eq.${encodeURIComponent(roomCode)}&token=eq.${encodeURIComponent(body.token)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ choice: body.choice }) });
      return reply(res, 200, await snapshot(roomCode, body.token));
    }
    if (action === 'resolve') {
      if (self.slot !== 1) throw new Error('방장 화면에서 승패를 확정합니다.');
      const current = await players(roomCode); if (current.length !== 2 || current.some(player => !player.choice)) throw new Error('두 플레이어의 선택을 기다리고 있습니다.');
      await Promise.all(current.map(player => db(`game_players?room_code=eq.${encodeURIComponent(roomCode)}&slot=eq.${player.slot}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ choice: null, score: player.score + (body.winner === player.slot ? 1 : 0) }) })));
      await db(`game_rooms?code=eq.${encodeURIComponent(roomCode)}`, { method: 'PATCH', headers: jsonHeaders, body: JSON.stringify({ last_result: { winner: body.winner, reason: body.reason || 'AI 판정 완료' } }) });
      return reply(res, 200, await snapshot(roomCode, body.token));
    }
    throw new Error('알 수 없는 방 요청입니다.');
  } catch (error) { return reply(res, 400, { error: error.message || '방 처리에 실패했습니다.' }); }
}
