const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "MY_SUPER_SECRET_KEY_123";

const activeTokens = new Map();
const playerPositions = new Map();

function generateOneTimeToken(username) {
    const token = crypto.randomBytes(16).toString('hex');
    activeTokens.set(token, {
        username: username,
        createdAt: Date.now()
    });
    return token;
}

// Clean up expired auth tokens every 60 seconds
setInterval(() => {
    const now = Date.now();
    for (const [token, data] of activeTokens.entries()) {
        if (now - data.createdAt > 5 * 60 * 1000) {
            activeTokens.delete(token);
        }
    }
}, 60000);

// Route: Auth Redirect
app.get('/connect', (req, res) => {
    const { user, secret, token } = req.query;

    if (user && secret === ADMIN_SECRET) {
        const generatedToken = generateOneTimeToken(user);
        return res.redirect(`/connect.html?token=${generatedToken}`);
    }

    if (token) {
        return res.sendFile(path.join(__dirname, 'public', 'connect.html'));
    }

    res.status(403).send("Unauthorized connection link. Run /voice in-game.");
});

// Route: Token Validation
app.post('/api/auth/validate', (req, res) => {
    const { token } = req.body;

    if (!token || !activeTokens.has(token)) {
        return res.status(401).json({ valid: false, error: "Invalid or expired token" });
    }

    const tokenData = activeTokens.get(token);
    activeTokens.delete(token);

    res.json({
        valid: true,
        username: tokenData.username
    });
});

// Route: Receive Minecraft Position Updates
app.get('/api/position', (req, res) => {
    const { username, world, x, y, z } = req.query;

    if (!username) {
        return res.status(400).send("Missing username parameter.");
    }

    const posData = {
        username: username,
        position: {
            world: world || "world",
            x: parseFloat(x) || 0,
            y: parseFloat(y) || 0,
            z: parseFloat(z) || 0
        }
    };

    // Update in-memory position map and broadcast to all connected WebRTC browser sessions
    playerPositions.set(username, posData.position);
    io.emit('position_update', posData);

    res.status(200).send("Position received");
});

// Socket.io Middleware
io.use((socket, next) => {
    const username = socket.handshake.auth.username;
    if (!username) {
        return next(new Error("Authentication failed: Missing username"));
    }
    socket.username = username;
    next();
});

// Socket.io WebRTC Signaling Handler
io.on('connection', async (socket) => {
    const socketsInRoom = await io.in('voice_room').fetchSockets();
    const existingPeers = socketsInRoom.map(s => ({ socketId: s.id, username: s.username }));

    socket.join('voice_room');

    // Send existing peers to the newly connected socket
    socket.emit('all_peers', existingPeers);

    // Send currently known player positions to the newcomer
    for (const [username, position] of playerPositions.entries()) {
        socket.emit('position_update', { username, position });
    }

    // Notify other peers in room about the new user
    socket.to('voice_room').emit('peer_joined', { username: socket.username, socketId: socket.id });

    // Relay WebRTC signaling packets
    socket.on('signal', (data) => {
        io.to(data.targetSocketId).emit('signal', {
            senderSocketId: socket.id,
            senderUsername: socket.username,
            signalData: data.signalData
        });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        playerPositions.delete(socket.username);
        io.to('voice_room').emit('peer_left', { socketId: socket.id });
    });
});

server.listen(PORT, () => {
    console.log(`Proximity Voice server listening on port ${PORT}`);
});
