const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const RAFFLE_ADDRESS = "kaspa:qzfcyspged7wkzzmlkud7vsxc3uexlgyu9qxdcuaudsr7phuxmkrc3xwfnexv";

let currentBalance = 0;

async function updateBalance() {
    try {
        const response = await fetch(`https://api.kaspa.org/addresses/${RAFFLE_ADDRESS}/balance`);
        const data = await response.json();
        currentBalance = data.balance / 100000000;
        console.log(`[${new Date().toLocaleTimeString()}] Balance: ${currentBalance} KAS`);
    } catch (error) {
        console.error("Error updating balance:", error.message);
    }
}

updateBalance();
setInterval(updateBalance, 30000);

app.get('/api/jackpot', (req, res) => {
    res.json({
        balance: currentBalance,
        lastUpdated: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});