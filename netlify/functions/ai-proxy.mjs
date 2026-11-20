/* netlify/functions/ai-proxy.mjs — Same-origin AI proxy to bypass browser CORS for OpenAI-compatible APIs */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?|172\.(1[6-9]|2\d|3[0-1])\.)/i;

function isAllowedTarget(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    if (!u.hostname || PRIVATE_HOST.test(u.hostname)) return false;
    if (!/\/(chat\/completions|completions|responses)\/?$/i.test(u.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return Response.json({ error: { message: 'Method not allowed' } }, { status: 405 });
  }
  let payload;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: { message: '请求体不是有效 JSON' } }, { status: 400 });
  }
  const { url, apiKey, body } = payload || {};
  if (!url || !isAllowedTarget(url)) {
    return Response.json({ error: { message: '不支持的目标接口地址（仅允许公开 HTTPS OpenAI 兼容对话接口）' } }, { status: 400 });
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
    });
    const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return Response.json(
      { error: { message: '上游 AI 服务连接失败：' + (err?.message || String(err)) } },
      { status: 502 },
    );
  }
};

export const config = {
  path: '/api/ai/chat',
  method: 'POST',
};
