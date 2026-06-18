// backend/monitor.js

const RAFFLE_ADDRESS = "kaspa:qzfcyspged7wkzzmlkud7vsxc3uexlgyu9qxdcuaudsr7phuxmkrc3xwfnexv";

async function checkRaffleAddress() {
    try {
        const response = await fetch(`https://api.kaspa.org/addresses/${RAFFLE_ADDRESS}/balance`);
        const data = await response.json();

        const balance = data.balance / 100000000; // Convert from sompi to KAS

        console.log(`[${new Date().toLocaleTimeString()}] Balance: ${balance} KAS`);

    } catch (error) {
        console.error("Error:", error.message);
    }
}

// Run immediately
checkRaffleAddress();

// Then run every 30 seconds
setInterval(checkRaffleAddress, 30000);

console.log("Monitoring started. Checking every 30 seconds...\n");