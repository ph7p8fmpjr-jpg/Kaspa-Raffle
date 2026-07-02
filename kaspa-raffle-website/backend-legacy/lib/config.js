const { readJson, writeJson } = require('./store');

const DEFAULT_CONFIG = {
    fundingAddress: 'kaspa:fundingaddresshere1234567890abcdefghijklmnopqrstuvwxyz',
    fundingDescription: 'Kaspa Core Developers for ongoing improvements',
};

function getConfig() {
    return { ...DEFAULT_CONFIG, ...readJson('config.json', {}) };
}

function updateFunding({ fundingAddress, fundingDescription }) {
    const config = getConfig();
    if (fundingAddress) config.fundingAddress = fundingAddress.trim();
    if (fundingDescription) config.fundingDescription = fundingDescription.trim();
    writeJson('config.json', config);
    return config;
}

module.exports = { getConfig, updateFunding, DEFAULT_CONFIG };