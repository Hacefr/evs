const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_SECRET_KEY || "YOUR_SECRET_ADMIN_KEY_HERE";

// Store active voice tokens, connected players, and stress test state
const validTokens = new Set();
const activeSessions = new Map(); // username -> ws socket
let isStressTesting = false;
let fakeSessions = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Helper function to validate auth tokens
function isValidToken(token) {
    if (!token) return false;
    return validTokens.has(token) || token === "test"; // "test" allowed for quick debugging
}

// Token generation endpoint (Called by Minecraft Skript)
app.post('/api/auth/token', (req, res) => {
    const { username, secret } = req.body;
    
    // Optional secret check to prevent external API spam
    if (secret && secret !== ADMIN_KEY) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    const generatedToken = Math.random().toString(36).substring(2, 10);
    validTokens.add(generatedToken);

    // Auto-expire token after 2 minutes if unused
    setTimeout(() => {
        validTokens.delete(generatedToken);
    }, 120000);

    res.json({ success: true, token: generatedToken });
});

// Main Web Route (Stealth Authentication Bypass)
app.get('/', (req, res) => {
    const token = req.query.auth;

    if (token && isValidToken(token)) {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } else {
        // Return 404 status code alongside fake broken page for web crawlers
        res.status(404).sendFile(path.join(__dirname, 'public', 'url.html'));
    }
});

// Admin Load / Stress Test Endpoint (Triggered from Skript GUI)
app.get('/api/admin/stress-test', (req, res) => {
    if (req.query.key !== ADMIN_KEY) {
        return res.status(403).json({ error: "Forbidden" });
    }

    isStressTesting = !isStressTesting;

    if (isStressTesting) {
        for (let i = 1; i <= 50; i++) {
            fakeSessions.set(`TestBot_${i}`, { connectedAt: Date.now() });
        }
    } else {
        fakeSessions.clear();
    }

    res.json({
        success: true,
        stressTestActive: isStressTesting,
        fakeUsersCount: fakeSessions.size
    });
});

// Real-time WebSocket Signaling for WebRTC
wss.on('connection', (ws) => {
    let clientUsername = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                // Register player session
                case 'join':
                    clientUsername = data.username;
                    activeSessions.set(clientUsername, ws);
                    broadcastRoster();
                    break;

                // Handle WebRTC WebRTC peer-to-peer signaling (offers, answers, ICE candidates)
                case 'signal':
                    const targetSocket = activeSessions.get(data.target);
                    if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
                        targetSocket.send(JSON.stringify({
                            type: 'signal',
                            sender: clientUsername,
                            signalData: data.signalData
                        }));
                    }
                    break;

                // Position updates sent from Minecraft via Skript/HTTP or client bridge
                case 'position':
                    // Broadcast updated 3D coordinates to nearby connected peers
                    broadcastToPeers(clientUsername, {
                        type: 'position_update',
                        username: clientUsername,
                        x: data.x,
                        y: data.y,
                        z: data.z
                    });
                    break;
            }
        } catch (err) {
            console.error("Error processing WebSocket message:", err);
        }
    });

    ws.on('close', () => {
        if (clientUsername) {
            activeSessions.delete(clientUsername);
            broadcastRoster();
        }
    });
});

// Helper: Broadcast current online roster to all users
function broadcastRoster() {
    const realUsers = Array.from(activeSessions.keys());
    const fakeUsers = Array.from(fakeSessions.keys());
    const fullRoster = [...realUsers, ...fakeUsers];

    const payload = JSON.stringify({ type: 'roster', users: fullRoster });

    for (const [_, socket] of activeSessions) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
        }
    }
}

// Helper: Relay position packet to active clients
function broadcastToPeers(sender, packet) {
    const payload = JSON.stringify(packet);
    for (const [user, socket] of activeSessions) {
        if (user !== sender && socket.readyState === WebSocket.OPEN) {
            socket.send(payload);
        }
    }
}

server.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});
