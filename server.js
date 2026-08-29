import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
if (fs.existsSync(path.join(root, '.env'))) {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}
const [{ default: judgeHandler }, { default: roomHandler }] = await Promise.all([import('./api/judge.js'), import('./api/room.js')]);
const port = Number(process.env.PORT || 3000);

function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve, reject) => { let body=''; req.on('data', chunk => { body += chunk; if (body.length > 100_000) reject(new Error('요청이 너무 큽니다.')); }); req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('요청 형식이 올바르지 않습니다.')); } }); req.on('error', reject); }); }

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (req.method === 'POST' && (req.url === '/api/judge' || req.url === '/api/room')) {
    try { req.body = await readBody(req); } catch (error) { return json(res, 400, { error: error.message }); }
    const wrapped = { status: code => ({ json: body => json(res, code, body) }), json: body => json(res, 200, body) };
    return req.url === '/api/room' ? roomHandler(req, wrapped) : judgeHandler(req, wrapped);
  }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const requested = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(root, `.${requested}`);
  if (!file.startsWith(root) || !fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '0.0.0.0', () => console.log(`Glyco game: http://localhost:${port}`));
