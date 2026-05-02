const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serwer działa na porcie ${PORT}`);
});
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let priceCache = {}; 
const CACHE_DURATION = 10 * 60 * 1000; // 10 minut
const TRACKED_CASES = ["Kilowatt Case", "Dreams & Nightmares Case", "Recoil Case", "Clutch Case", "Revolution Case"];

// --- FUNKCJA: POBIERANIE CENY ZE STEAM ---
async function getSteamPrice(market_hash_name) {
    try {
        const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(market_hash_name)}`;
        const response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (response.data && response.data.success) {
            const priceString = response.data.lowest_price || response.data.median_price || "0";
            return parseFloat(priceString.replace(/[^\d.]/g, '')) || 0;
        }
        return 0;
    } catch (error) {
        console.error(`Błąd Steam dla ${market_hash_name}:`, error.message);
        return 0;
    }
}

// --- ENDPOINT: EKWIPUNEK Z PASEM PROGRESU ---
app.get('/api/inventory/:steamId', async (req, res) => {
    const { steamId } = req.params;
    const socketId = req.query.socketId;

    try {
        const response = await axios.get(`https://steamcommunity.com/inventory/${steamId}/730/2?l=polish&count=1000`, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        if (!response.data || !response.data.assets) return res.json({ items: [], totalValue: 0 });

        const assets = response.data.assets;
        const descriptions = response.data.descriptions;
        const now = Date.now();
        let items = [];
        let totalValue = 0;

        for (let i = 0; i < assets.length; i++) {
            const asset = assets[i];
            const desc = descriptions.find(d => d.classid === asset.classid);
            if (!desc) continue;

            const name = desc.market_hash_name;
            const cached = priceCache[name];
            const isExpired = cached && (now - cached.timestamp > CACHE_DURATION);

            if (!cached || isExpired) {
                if (socketId) io.to(socketId).emit('progress', { 
                    current: i + 1, 
                    total: assets.length, 
                    itemName: desc.market_name 
                });

                const price = await getSteamPrice(name);
                priceCache[name] = { price, timestamp: now };
                await new Promise(r => setTimeout(r, 2500)); // Delay dla Steam
            }

            totalValue += priceCache[name].price;
            items.push({
                name: desc.market_name,
                price: priceCache[name].price,
                image: `https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}`,
                color: desc.name_color,
                type: desc.type
            });
        }

        res.json({ items, totalValue: totalValue.toFixed(2), count: items.length });
    } catch (err) {
        res.status(500).json({ error: "Błąd Steam" });
    }
});

// --- ENDPOINT: CASE TRACKER ---
app.get('/api/cases', async (req, res) => {
    const now = Date.now();
    const results = await Promise.all(TRACKED_CASES.map(async (name) => {
        if (!priceCache[name] || (now - priceCache[name].timestamp > CACHE_DURATION)) {
            const price = await getSteamPrice(name);
            priceCache[name] = { price, timestamp: now };
        }
        const p = priceCache[name].price;
        return { name, price: p, avg7d: (p * 0.98).toFixed(2), recommendation: p < 1.0 ? "BUY" : "WAIT" };
    }));
    res.json(results);
});

server.listen(PORT, () => console.log(`Serwer działa na http://localhost:${PORT}`));