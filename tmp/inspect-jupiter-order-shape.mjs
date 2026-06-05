import 'dotenv/config';

const apiKey = process.env.JUPITER_API_KEY?.trim();
if (!apiKey) throw new Error('JUPITER_API_KEY is required');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const samples = [
  ['JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'],
  ['MET', 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL'],
  ['Fartcoin', '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump'],
];

for (const [symbol, mint] of samples) {
  const url = new URL(process.env.JUPITER_QUOTE_BASE_URL || 'https://api.jup.ag/swap/v2/order');
  url.searchParams.set('inputMint', USDC_MINT);
  url.searchParams.set('outputMint', mint);
  url.searchParams.set('amount', '5000000');
  url.searchParams.set('slippageBps', '50');
  url.searchParams.set('restrictIntermediateTokens', 'true');
  const response = await fetch(url, { headers: { 'x-api-key': apiKey, Accept: 'application/json' } });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  console.log(JSON.stringify({
    symbol,
    status: response.status,
    keys: payload && typeof payload === 'object' ? Object.keys(payload).sort() : null,
    payload,
    raw: payload ? undefined : text.slice(0, 1000),
  }, null, 2));
}
