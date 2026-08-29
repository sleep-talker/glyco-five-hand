import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import judgeHandler from './api/judge.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
if (fs.existsSync(path.join(root, '.env'))) {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
const apiKey = process.env.GEMINI_API_KEY;

const schema = {
  type: 'OBJECT',
  properties: {
    approved: { type: 'BOOLEAN' },
    summary: { type: 'STRING' },
    reasons: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['approved', 'summary', 'reasons']
};

function localJudge(input) {
  const hands = input.hands || [], byId = new Map(hands.map(h => [h.id, h]));
  const findings = [];
  for (const hand of hands.filter(h => h.owner !== 'base')) {
    const owner = input.players?.[hand.owner]?.cards?.[Number(hand.id.at(-1))];
    const beats = new Set(owner?.beats || []);
    if (!beats.size) findings.push(`「${hand.name}」는 이기는 대상이 없습니다.`);
    for (const target of beats) {
      const targetHand = byId.get(target);
      if (!targetHand) findings.push(`「${hand.name}」가 존재하지 않는 패를 대상으로 지정했습니다.`);
      const targetOwner = targetHand && input.players?.[targetHand.owner]?.cards?.[Number(targetHand.id.at(-1))];
      if (targetOwner?.beats?.includes(hand.id)) findings.push(`「${hand.name}」와 「${targetHand.name}」가 서로를 이긴다고 선언해 모순입니다.`);
    }
    const losesTo = hands.some(other => other.id !== hand.id && (input.players?.[other.owner]?.cards?.[Number(other.id.at(-1))]?.beats || []).includes(hand.id));
    if (!losesTo) findings.push(`「${hand.name}」는 어떤 패에도 지지 않아 사기 패가 될 수 있습니다.`);
  }
  return { approved: findings.length === 0, summary: findings.length ? '' : '로컬 테스트 심판 기준으로 모순과 독점 승리 패가 발견되지 않았습니다.', reasons: findings, engine: 'local' };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100_000) reject(new Error('요청이 너무 큽니다.')); });
    req.on('end', () => resolve(JSON.parse(body || '{}')));
    req.on('error', reject);
  });
}

async function judge(req, res) {
  if (!apiKey) {
    const input = await readBody(req);
    return json(res, 200, localJudge(input));
  }
  try {
    const input = await readBody(req);
    const prompt = `당신은 지뢰 글리코의 공정성 심판 AI입니다. 각 플레이어의 5장 손모양과 규칙을 엄격하게 검증하세요.

판정 규칙:
1) 기본 패는 가위>보, 바위>가위, 보>바위입니다. 기본 패가 창작 패를 이긴다는 선언이 없으면 둘은 무승부입니다.
2) 각 창작 패의 beats는 해당 패가 이기는 대상 ID 목록입니다. 목록에 없는 상대와는 무승부입니다.
3) A가 B를 이긴다고 선언하면서 B도 A를 이긴다고 선언하면 모순입니다. 양쪽이 동시에 승리하는 매치업은 허용하지 마세요.
4) 각 창작 패는 최소 한 패를 이기고, 최소 한 패에게 져야 합니다. 모든 패를 이기거나 아무도 이기지 못하는 패는 사기/무의미한 패입니다.
5) 같은 이름, 자기 자신을 이기는 규칙, 존재하지 않는 ID도 부적합입니다.
6) approved는 위반이 하나도 없을 때만 true입니다. reasons에는 한국어로 구체적인 수정 이유를 짧게 작성하세요. 문제가 없으면 빈 배열을 반환하세요.

데이터:
${JSON.stringify(input, null, 2)}`;
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1, maxOutputTokens: 700 } })
    });
    const data = await response.json();
    if (!response.ok) return json(res, response.status, { error: data.error?.message || 'Gemini API 오류가 발생했습니다.' });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return json(res, 502, { error: 'Gemini가 판정 결과를 반환하지 않았습니다.' });
    return json(res, 200, { ...JSON.parse(text), engine: 'gemini' });
  } catch (error) { return json(res, 400, { error: error.message || 'AI 심판 요청을 처리하지 못했습니다.' }); }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.method === 'POST' && req.url === '/api/judge') {
    try { req.body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
    const wrapped = { status: code => ({ json: body => json(res, code, body) }), json: body => json(res, 200, body) };
    return judgeHandler(req, wrapped);
  }
  const requested = req.url === '/' ? '/index.html' : req.url;
  const file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(root) || !fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, () => console.log(`Glyco game: http://localhost:${port}`));
