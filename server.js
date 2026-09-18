const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const players = new Map(); // username -> { ws, x, y, z, world }

// Handle WebSockets for real VC signaling
wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const username = urlParams.get('user');

    if (!username) {
        ws.close();
        return;
    }

    // Register active player session
    players.set(username, { ws, x: 0, y: 0, z: 0, world: 'dirtworld' });
    console.log(`[VC] ${username} connected to WebSockets.`);

    // Broadcast updated player list to all connected clients
    broadcastRoster();

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            // Relay WebRTC audio signaling (offer, answer, candidate) to target peer
            if (data.target && players.has(data.target)) {
                players.get(data.target).ws.send(JSON.stringify({
                    sender: username,
                    type: data.type,
                    payload: data.payload
                }));
            }
        } catch (e) {
            console.error(e);
        }
    });

    ws.on('close', () => {
        players.delete(username);
        console.log(`[VC] ${username} disconnected.`);
        broadcastRoster();
    });
});

function broadcastRoster() {
    const list = Array.from(players.keys());
    const payload = JSON.stringify({ type: 'roster', players: list });
    players.forEach((player) => {
        if (player.ws.readyState === 1) player.ws.send(payload);
    });
}

// Skript telemetry route
app.post('/api/position', (req, res) => {
    const { username, world, x, y, z } = req.body;
    if (username && players.has(username)) {
        const p = players.get(username);
        p.x = x; p.y = y; p.z = z; p.world = world;
    }
    res.sendStatus(200);
});

// Serve frontend dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`VC Server running on port ${PORT}`));
