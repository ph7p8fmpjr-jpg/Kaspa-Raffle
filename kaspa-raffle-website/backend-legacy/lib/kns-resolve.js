const KNS_API = 'https://api.knsdomains.org/mainnet/api/v1';

const KNOWN_KNS_FALLBACK = {
    'winraffle.kas': 'kaspa:qr3rxmae6r5h9kkt7q5my7rajy492da7cxpy0kkzr99tk3xcydc2uwa3a7u6r',
};

const onchainCache = new Map();

function isKnsDomain(value) {
    return typeof value === 'string' && value.endsWith('.kas') && !value.startsWith('kaspa:');
}

function isOnchainAddress(value) {
    return typeof value === 'string' && /^kaspa:[a-z0-9]{61,63}$/.test(value);
}

function getKnownKnsFallback(domain, envFallback) {
    const normalized = domain.trim().toLowerCase();
    const envValue = (envFallback || '').trim();
    if (envValue && isOnchainAddress(envValue)) {
        return envValue;
    }
    return KNOWN_KNS_FALLBACK[normalized] || null;
}

async function resolveKnsToOnchain(domain, envFallback) {
    const normalized = domain.trim().toLowerCase();
    if (onchainCache.has(normalized)) {
        return onchainCache.get(normalized);
    }

    try {
        const res = await fetch(`${KNS_API}/assets?search=${encodeURIComponent(normalized)}`);
        if (res.ok) {
            const payload = await res.json();
            const assets = payload?.data?.assets || [];
            const match = assets.find(
                (asset) => asset.isDomain && String(asset.asset).toLowerCase() === normalized
            );

            if (match?.owner && isOnchainAddress(match.owner)) {
                onchainCache.set(normalized, match.owner);
                return match.owner;
            }
        }
    } catch (error) {
        console.warn(`[kns] API lookup failed for ${normalized}:`, error.message);
    }

    const fallback = getKnownKnsFallback(normalized, envFallback);
    if (fallback) {
        console.warn(`[kns] Using fallback on-chain address for ${normalized}`);
        onchainCache.set(normalized, fallback);
        return fallback;
    }

    throw new Error(`KNS domain not found or has no owner: ${normalized}`);
}

async function resolveRaffleOnchainAddress(configuredAddress, envFallback) {
    const value = (configuredAddress || '').trim();
    if (!value) {
        throw new Error('RAFFLE_ADDRESS is not configured');
    }
    if (isOnchainAddress(value)) {
        return value;
    }
    if (isKnsDomain(value)) {
        return resolveKnsToOnchain(value, envFallback);
    }
    throw new Error(`Invalid raffle address: ${value}`);
}

function getRaffleDisplayAddress(configuredAddress, displayOverride) {
    const display = (displayOverride || '').trim();
    if (display) return display;
    const value = (configuredAddress || '').trim();
    if (isKnsDomain(value)) return value;
    return value;
}

module.exports = {
    isKnsDomain,
    isOnchainAddress,
    getKnownKnsFallback,
    resolveKnsToOnchain,
    resolveRaffleOnchainAddress,
    getRaffleDisplayAddress,
};