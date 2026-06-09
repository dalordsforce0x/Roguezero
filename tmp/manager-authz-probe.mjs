const api = 'https://roguezeroapi-production.up.railway.app';
const id = '230da4b0-edda-4793-a33a-941db7923a14';

const probe = async (label, path, headers = {}) => {
  const r = await fetch(api + path, { headers });
  const t = await r.text();
  let users = null;
  try { users = (JSON.parse(t).users ?? []).length; } catch {}
  console.log(`${label}: STATUS ${r.status} users=${users}`);
  console.log('  body:', t.slice(0, 220));
};

await probe('no-secret', `/manager/${id}/overview`);
await probe('bad-secret', `/manager/${id}/overview`, { 'x-rz-internal-secret': 'wrong' });
await probe('sessions-no-secret', `/manager/${id}/sessions`);
