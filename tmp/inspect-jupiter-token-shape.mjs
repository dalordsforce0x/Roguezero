import 'dotenv/config';

const TOKEN_API_BASE_URL = (process.env.JUPITER_TOKEN_API_BASE_URL || 'https://api.jup.ag/tokens/v2').replace(/\/$/, '');
const apiKey = process.env.JUPITER_API_KEY?.trim();
if (!apiKey) throw new Error('JUPITER_API_KEY is required');

const paths = [
  'toptraded/1h?limit=5',
  'toptraded/24h?limit=5',
  'toporganicscore/24h?limit=5',
  'tag?query=verified',
];

for (const path of paths) {
  const response = await fetch(`${TOKEN_API_BASE_URL}/${path}`, {
    headers: { 'x-api-key': apiKey, Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  const token = Array.isArray(payload) ? payload[0] : null;
  console.log(JSON.stringify({
    path,
    count: Array.isArray(payload) ? payload.length : null,
    keys: token ? Object.keys(token).sort() : null,
    token,
  }, null, 2));
}
