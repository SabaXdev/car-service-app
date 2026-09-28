// NBG quotes GEL per EUR; we store EUR per GEL (totalCostEUR = totalCostGEL * exchangeRate).
const NBG_EUR_URL = 'https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/?currencies=EUR';
const OPEN_ER_API_BASE = 'https://open.er-api.com/v6/latest/';
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_BASE_CURRENCY = 'GEL';
const PRIMARY_RATE_SOURCE = 'National Bank of Georgia';
const FALLBACK_RATE_SOURCE = 'ExchangeRate-API';

const rateCache = new Map();

async function fetchRateToEur(fromCurrency, options = {}) {
  const from = (fromCurrency || DEFAULT_BASE_CURRENCY).trim().toUpperCase();
  if (!from) {
    return null;
  }
  if (from === 'EUR') {
    return { rate: 1, source: 'identity', fromCache: false };
  }

  if (!options.fresh) {
    const cached = readCache(from);
    if (cached) {
      return cached;
    }
  }

  let quote = null;
  if (from === DEFAULT_BASE_CURRENCY) {
    quote = await fetchNbgGelToEur();
  }
  if (!quote) {
    quote = await fetchOpenErApi(from);
  }
  if (!quote) {
    return null;
  }

  rateCache.set(from, {
    rate: quote.rate,
    source: quote.source,
    expires: Date.now() + CACHE_TTL_MS,
  });
  console.info(`[exchange-rates] ${quote.source}: 1 ${from} = ${quote.rate} EUR`);
  return { rate: quote.rate, source: quote.source, fromCache: false };
}

async function applyEurConversion(costs, warn, options) {
  const totalGel = Number(costs.totalCostGEL);
  if (!Number.isFinite(totalGel)) {
    return;
  }

  const conversion = await fetchRateToEur(costs.currency || DEFAULT_BASE_CURRENCY, options);
  if (!conversion) {
    costs.exchangeRate = null;
    costs.totalCostEUR = null;
    warn?.('Exchange rate unavailable; EUR total was not calculated.');
    return;
  }

  costs.exchangeRate = conversion.rate;
  costs.totalCostEUR = roundMoney(totalGel * conversion.rate);
  if (!conversion.fromCache && conversion.source === FALLBACK_RATE_SOURCE) {
    warn?.(`National Bank of Georgia rate was unavailable. EUR total uses ${FALLBACK_RATE_SOURCE}.`);
  }
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function roundRate(value) {
  return Math.round(value * 1e6) / 1e6;
}

function readCache(from) {
  const hit = rateCache.get(from);
  if (!hit || hit.expires <= Date.now()) {
    rateCache.delete(from);
    return null;
  }
  return { rate: hit.rate, source: hit.source, fromCache: true };
}

async function fetchNbgGelToEur() {
  const payload = await getJson(NBG_EUR_URL);
  const currencies = Array.isArray(payload) ? payload[0]?.currencies : null;
  if (!Array.isArray(currencies)) {
    console.warn('[exchange-rates] Unexpected National Bank of Georgia payload');
    return null;
  }

  const eurQuote = currencies.find((currency) => String(currency?.code || '').toUpperCase() === 'EUR');
  const gelForQuantity = Number(eurQuote?.rate);
  const quantity = Number(eurQuote?.quantity);
  if (!Number.isFinite(gelForQuantity) || gelForQuantity <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
    console.warn('[exchange-rates] National Bank of Georgia EUR quote is missing');
    return null;
  }

  const eurPerGel = quantity / gelForQuantity;
  if (eurPerGel <= 0 || eurPerGel >= 2) {
    console.warn('[exchange-rates] National Bank of Georgia EUR quote is out of range', eurQuote);
    return null;
  }

  return { rate: roundRate(eurPerGel), source: PRIMARY_RATE_SOURCE };
}

async function fetchOpenErApi(from) {
  const payload = await getJson(`${OPEN_ER_API_BASE}${encodeURIComponent(from)}`);
  if (payload?.result !== 'success') {
    console.warn('[exchange-rates] ExchangeRate-API did not return a success payload');
    return null;
  }

  const eurRate = Number(payload?.rates?.EUR);
  if (!Number.isFinite(eurRate) || eurRate <= 0) {
    console.warn('[exchange-rates] ExchangeRate-API EUR rate is missing');
    return null;
  }

  return { rate: roundRate(eurRate), source: FALLBACK_RATE_SOURCE };
}

async function getJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'car-service-app',
      },
    });
    if (!response.ok) {
      console.warn('[exchange-rates] HTTP', response.status, url);
      return null;
    }
    return await response.json();
  } catch (err) {
    console.warn('[exchange-rates] request failed:', url, err.message || err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  fetchRateToEur,
  applyEurConversion,
  roundMoney,
  DEFAULT_BASE_CURRENCY,
  PRIMARY_RATE_SOURCE,
  FALLBACK_RATE_SOURCE,
};
