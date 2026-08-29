const schema = { type: 'OBJECT', properties: { approved: { type: 'BOOLEAN' }, summary: { type: 'STRING' }, reasons: { type: 'ARRAY', items: { type: 'STRING' } }, normalizedRules: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, beats: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['id', 'beats'] } } }, required: ['approved', 'summary', 'reasons', 'normalizedRules'] };
const battleSchema = { type: 'OBJECT', properties: { winner: { type: 'INTEGER', enum: [-1, 0, 1] }, reason: { type: 'STRING' } }, required: ['winner', 'reason'] };
const cardSchema = { type: 'OBJECT', properties: { approved: { type: 'BOOLEAN' }, summary: { type: 'STRING' }, reasons: { type: 'ARRAY', items: { type: 'STRING' } }, beats: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['approved', 'summary', 'reasons', 'beats'] };

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
  if (!process.env.GEMINI_API_KEY) return res.status(200).json(localJudge(input));
  const prompt = input.mode === 'battle' ? `당신은 지뢰 글리코 경기 심판 AI입니다. 등록된 한글 규칙과 기본 가위바위보 규칙만 사용해 두 선택의 승패를 판정하세요. winner는 플레이어 1이면 0, 플레이어 2면 1, 무승부면 -1입니다. reason은 한국어 한 문장으로 작성하세요.\n\n데이터:\n${JSON.stringify(input)}` : input.mode === 'card' ? `당신은 지뢰 글리코 창작 패 등록 심판 AI입니다. card.ruleText의 한글 문장을 정확히 해석하세요. approved는 사기 패, 무조건 승리, 모호해서 판정 불가, 자기 자신을 이기는 규칙이면 false입니다. beats에는 문장에서 확인된 대상 ID만 넣고, 문장에 없는 대상은 넣지 마세요. 사기 패가 아니고 최소 하나의 명확한 대상을 이기면 approved true입니다. summary와 reasons는 한국어로 작성하세요.\n\n데이터:\n${JSON.stringify(input)}` : `당신은 지뢰 글리코의 공정성 심판 AI입니다. 각 플레이어의 5장 손모양과 규칙을 검증하세요.\n\n판정 규칙:\n- 기본 패는 가위>보, 바위>가위, 보>바위입니다.\n- beats는 해당 패가 이기는 대상 ID 목록이며, 목록에 없으면 무승부입니다.\n- A가 B를 이기고 B도 A를 이기면 모순입니다.\n- 각 창작 패는 최소 한 패를 이기고 최소 한 패에게 져야 합니다. 모든 패를 이기는 패는 사기 패입니다.\n- 자기 자신, 존재하지 않는 ID, 중복 이름은 부적합입니다.\napproved는 위반이 하나도 없을 때만 true로 하세요. reasons는 한국어 배열로 작성하세요.\n\n데이터:\n${JSON.stringify(input)}`;
  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: input.mode === 'battle' ? battleSchema : input.mode === 'card' ? cardSchema : schema, temperature: 0.1, maxOutputTokens: 700 } }) });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Gemini API 오류가 발생했습니다.' });
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return res.status(502).json({ error: 'Gemini가 판정 결과를 반환하지 않았습니다.' });
    return res.status(200).json({ ...JSON.parse(text), engine: 'gemini' });
  } catch (error) { return res.status(400).json({ error: error.message || 'AI 심판 요청을 처리하지 못했습니다.' }); }
}
