const schema = { type: 'OBJECT', properties: { approved: { type: 'BOOLEAN' }, summary: { type: 'STRING' }, reasons: { type: 'ARRAY', items: { type: 'STRING' } }, normalizedRules: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, beats: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['id', 'beats'] } } }, required: ['approved', 'summary', 'reasons', 'normalizedRules'] };
const battleSchema = { type: 'OBJECT', properties: { winner: { type: 'INTEGER', enum: [-1, 0, 1] }, reason: { type: 'STRING' } }, required: ['winner', 'reason'] };
const cardSchema = { type: 'OBJECT', properties: { approved: { type: 'BOOLEAN' }, summary: { type: 'STRING' }, reasons: { type: 'ARRAY', items: { type: 'STRING' } }, beats: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['approved', 'summary', 'reasons', 'beats'] };
const recentRequests = new Map();
const cloudflareJsonModels = new Set(['@cf/meta/llama-3.1-8b-instruct-fast', '@cf/meta/llama-3.1-8b-instruct', '@cf/meta/llama-3.1-70b-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3-8b-instruct', '@cf/meta/llama-3.2-11b-vision-instruct']);
function requestKey(input) { return input.mode === 'card' ? `card:${input.card?.id}:${input.card?.name}:${input.card?.ruleText}` : `${input.mode || 'register'}:${JSON.stringify(input)}`; }
function parseVerdict(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{'), end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error('invalid JSON');
}
function hasUniversalWinRule(ruleText) { return /(?:모든|전부|전체|모두|무조건|다)\s*(?:패|것|상대|대상)?\s*(?:을|를|에)?\s*이(?:기|긴|겨|길)/.test(String(ruleText || '').replace(/\s/g, '')); }
function auditCardVerdict(input, verdict) {
  if (input.mode !== 'card') return verdict;
  const ruleText = String(input.card?.ruleText || '');
  const universalClaim = hasUniversalWinRule(ruleText);
  const ownPrefix = String(input.card?.id || '').slice(0, 2);
  const knownHands = (input.hands || []).filter(hand => hand.id !== input.card?.id && hand.name && !/^창작 패\s*\d+$/.test(hand.name) && (hand.owner === 'base' || String(hand.id).startsWith(ownPrefix)));
  const beatIds = new Set((verdict.beats || []).map(String));
  const allKnown = knownHands.length >= 3 && knownHands.every(hand => beatIds.has(hand.id) || beatIds.has(hand.name));
  if (!universalClaim && !allKnown) return verdict;
  return { ...verdict, approved: false, summary: '기존 패 전체를 이기는 규칙은 등록할 수 없습니다.', reasons: ['가위·바위·보와 내 창작 패를 포함한 상성표에서 약점 없이 전부 이기는 사기 규칙입니다.'], beats: [] };
}

function localJudge(input) {
  if (input.mode === 'battle') {
    const [a,b] = input.choices || [], hands = input.hands || [], find = id => hands.find(h => h.id === id), left = find(a), right = find(b);
    const beats = (x,y) => x?.owner === 'base' ? ({scissors:['paper'],rock:['scissors'],paper:['rock']}[x.id] || []).includes(y?.id) : (input.players?.[x?.owner]?.cards?.[Number(x.id?.at(-1))]?.beats || []).includes(y?.id);
    return { winner: beats(left,right) && !beats(right,left) ? 0 : beats(right,left) && !beats(left,right) ? 1 : -1, reason: '등록된 상성 규칙을 기준으로 판정했습니다.', engine: 'local' };
  }
  const hands = input.hands || [], byId = new Map(hands.map(h => [h.id, h])), findings = [];
  for (const hand of hands.filter(h => h.owner !== 'base')) {
    const card = input.players?.[hand.owner]?.cards?.[Number(hand.id.at(-1))], beats = new Set(card?.beats || []);
    if (!beats.size) findings.push(`「${hand.name}」는 이기는 대상이 없습니다.`);
    for (const target of beats) {
      const targetHand = byId.get(target), targetCard = targetHand && input.players?.[targetHand.owner]?.cards?.[Number(targetHand.id.at(-1))];
      if (!targetHand) findings.push(`「${hand.name}」가 존재하지 않는 패를 대상으로 지정했습니다.`);
      if (targetCard?.beats?.includes(hand.id)) findings.push(`「${hand.name}」와 「${targetHand.name}」가 서로를 이긴다고 선언해 모순입니다.`);
    }
    const losesTo = hands.some(other => (input.players?.[other.owner]?.cards?.[Number(other.id.at(-1))]?.beats || []).includes(hand.id));
    if (!losesTo) findings.push(`「${hand.name}」는 어떤 패에도 지지 않아 사기 패가 될 수 있습니다.`);
  }
  return { approved: !findings.length, summary: findings.length ? '' : '로컬 테스트 심판 기준으로 모순과 독점 승리 패가 발견되지 않았습니다.', reasons: findings, normalizedRules: hands.filter(h => h.owner !== 'base').map(h => ({ id: h.id, beats: input.players?.[h.owner]?.cards?.[Number(h.id.at(-1))]?.beats || [] })), engine: 'local' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 허용됩니다.' });
  const input = req.body || {};
  const cloudflare = {
    accountId: process.env.AI_CLOUDFLARE_ACCOUNT_ID,
    token: process.env.AI_CLOUDFLARE_AI_API_TOKEN,
    model: process.env.AI_CLOUDFLARE_AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast'
  };
  const provider = cloudflare.accountId && cloudflare.token ? 'cloudflare' : process.env.GEMINI_API_KEY ? 'gemini' : 'local';
  if (provider === 'local') return res.status(200).json(localJudge(input));
  if (input.mode === 'card' && hasUniversalWinRule(input.card?.ruleText)) return res.status(200).json({ approved: false, summary: '모든 패를 이기는 규칙은 등록할 수 없습니다.', reasons: ['약점 없이 전부 이기는 사기 규칙입니다.'], beats: [], engine: 'rule-guard' });
  if (provider === 'cloudflare' && !cloudflareJsonModels.has(cloudflare.model)) return res.status(400).json({ error: `「${cloudflare.model}」은 구조화된 JSON 판정을 지원하지 않습니다. .env의 AI_CLOUDFLARE_AI_MODEL을 @cf/meta/llama-3.1-8b-instruct-fast 로 바꿔 주세요.` });
  const key = requestKey(input), previous = recentRequests.get(key), now = Date.now();
  if (previous && now - previous < 3000) return res.status(429).json({ error: '같은 AI 검사가 이미 요청되었습니다. 3초 뒤에 다시 시도해 주세요.' });
  recentRequests.set(key, now);
  if (recentRequests.size > 200) for (const [oldKey, timestamp] of recentRequests) if (now - timestamp > 60000) recentRequests.delete(oldKey);
  console.info(`[AI request] ${new Date().toISOString()} provider=${provider} mode=${input.mode || 'register'}`);
  const prompt = input.mode === 'battle' ? `당신은 지뢰 글리코 경기 심판 AI입니다. 등록된 한글 규칙과 기본 가위바위보 규칙만 사용해 두 선택의 승패를 판정하세요. winner는 플레이어 1이면 0, 플레이어 2면 1, 무승부면 -1입니다. reason은 한국어 한 문장, 40자 이내로 작성하세요.\n\n데이터:\n${JSON.stringify(input)}` : input.mode === 'card' ? `당신은 지뢰 글리코 창작 패의 엄격한 등록 심판 AI입니다. card.ruleText의 한글 문장을 정확히 해석해, 새 패와 기본 가위·바위·보 및 이미 등록된 같은 플레이어의 다른 창작 패를 함께 놓은 상성표로 검증하세요. 새 패가 비교 가능한 기존 패 전체를 이기거나, “모든/전부/다/무조건 이긴다”처럼 약점 없이 전칭 승리를 선언하면 무조건 approved=false입니다. 자기 자신을 이김, 존재하지 않는 대상, 판정 불가한 모호함도 거부하세요. beats에는 문장에서 확인된 실제 대상 ID만 넣고, 문장에 없는 대상은 넣지 마세요. summary는 60자 이내, reasons는 최대 2개·각 60자 이내의 한국어 문장으로 작성하세요.\n\n데이터:\n${JSON.stringify(input)}` : `당신은 지뢰 글리코의 최종 공정성 심판 AI입니다. 각 플레이어가 가진 5장(가위·바위·보·창작 패 2장)으로 플레이어 1의 행 5장 × 플레이어 2의 열 5장인 실제 5×5 대전 매트릭스를 먼저 완성한 뒤 공정성을 검증하세요.\n\n판정 규칙:\n- 기본 패는 가위>보, 바위>가위, 보>바위입니다.\n- beats는 해당 패가 이기는 대상 ID 목록이며, 목록에 없으면 무승부입니다.\n- 5×5 매트릭스에서 어느 한 창작 패가 상대의 선택지 전부를 이기거나, 약점 없이 일방적으로 우세하면 사기 패입니다.\n- A가 B를 이기고 B도 A를 이기면 모순입니다.\n- 각 창작 패는 실제 상대의 5장 중 최소 하나를 이기고, 최소 하나에게 져야 합니다.\n- 자기 자신, 존재하지 않는 ID, 중복 이름은 부적합입니다.\napproved는 위반이 하나도 없을 때만 true로 하세요. reasons는 최대 3개의 짧은 한국어 배열로 작성하세요.\n\n데이터:\n${JSON.stringify(input)}`;
  const outputContract = input.mode === 'battle'
    ? '{"winner": 0, "reason": "한국어 판정 근거"}'
    : input.mode === 'card'
      ? '{"approved": true, "summary": "한국어 요약", "reasons": [], "beats": ["실제 대상 ID"]}'
      : '{"approved": true, "summary": "한국어 요약", "reasons": [], "normalizedRules": [{"id":"창작 패 ID", "beats":["실제 대상 ID"]}]}' ;
  try {
    let text, structuredVerdict;
    if (provider === 'cloudflare') {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cloudflare.accountId}/ai/run/${cloudflare.model}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cloudflare.token}` },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: '당신은 한국어 게임 규칙 심판입니다. 설명이나 Markdown 없이 유효한 JSON 객체 하나만 반환하세요.' },
            { role: 'user', content: `${prompt}\n\n반드시 JSON만 반환하세요. 누락하면 안 되는 정확한 형식은 다음과 같습니다: ${outputContract}\napproved는 반드시 true 또는 false여야 합니다. beats에는 데이터에 나온 ID만 넣으세요.` }
          ],
          temperature: 0.1,
          max_tokens: 2048,
          response_format: {
            type: 'json_schema',
            json_schema: input.mode === 'battle' ? { type: 'object', properties: { winner: { type: 'integer', enum: [-1, 0, 1] }, reason: { type: 'string' } }, required: ['winner', 'reason'] } : input.mode === 'card' ? { type: 'object', properties: { approved: { type: 'boolean' }, summary: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } }, beats: { type: 'array', items: { type: 'string' } } }, required: ['approved', 'summary', 'reasons', 'beats'] } : { type: 'object', properties: { approved: { type: 'boolean' }, summary: { type: 'string' }, reasons: { type: 'array', items: { type: 'string' } }, normalizedRules: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, beats: { type: 'array', items: { type: 'string' } } }, required: ['id', 'beats'] } } }, required: ['approved', 'summary', 'reasons', 'normalizedRules'] }
          }
        })
      });
      const data = await response.json();
      if (!response.ok || data.success === false) return res.status(response.status || 502).json({ error: data.errors?.[0]?.message || data.error?.message || 'Cloudflare AI API 오류가 발생했습니다.' });
      structuredVerdict = data.result?.response && typeof data.result.response === 'object' && !Array.isArray(data.result.response) ? data.result.response : null;
      text = structuredVerdict ? '' : data.result?.response || data.result?.text || data.result?.output;
      if (Array.isArray(text)) text = text.map(item => item.text || item).join('');
      if (!structuredVerdict && !text) return res.status(502).json({ error: 'Cloudflare AI가 판정 결과를 반환하지 않았습니다.' });
    } else {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: input.mode === 'battle' ? battleSchema : input.mode === 'card' ? cardSchema : schema, temperature: 0.1, maxOutputTokens: 2048 } }) });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'AI API 오류가 발생했습니다.' });
      text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) return res.status(502).json({ error: 'AI가 판정 결과를 반환하지 않았습니다.' });
    }
    let verdict; try { verdict = structuredVerdict || parseVerdict(text); } catch { return res.status(502).json({ error: 'AI 심판 응답이 완성되지 않았습니다. 다시 저장해 주세요.' }); }
    return res.status(200).json({ ...auditCardVerdict(input, verdict), engine: provider });
  } catch (error) { return res.status(400).json({ error: error.message || 'AI 심판 요청을 처리하지 못했습니다.' }); }
}
