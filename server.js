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

setInterval(() => {
    const now = Date.now();
    for (const [token, data] of activeTokens.entries()) {
        if (now - data.createdAt > 5 * 60 * 1000) {
            activeTokens.delete(token);
        }
    }
}, 60000);

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

io.use((socket, next) => {
    const username = socket.handshake.auth.username;
    if (!username) {
        return next(new Error("Authentication failed: Missing username"));
    }
    socket.username = username;
    next();
});

io.on('connection', async (socket) => {
    // Get all sockets currently in the voice room BEFORE joining
    const socketsInRoom = await io.in('voice_room').fetchSockets();
    const existingPeers = socketsInRoom.map(s => ({ socketId: s.id, username: s.username }));

    socket.join('voice_room');

    // Tell the newly connected player about all existing players
    socket.emit('all_peers', existingPeers);

    // Notify existing players that a new peer joined
    socket.to('voice_room').emit('peer_joined', { username: socket.username, socketId: socket.id });

    socket.on('signal', (data) => {
        io.to(data.targetSocketId).emit('signal', {
            senderSocketId: socket.id,
            senderUsername: socket.username,
            signalData: data.signalData
        });
    });

    socket.on('disconnect', () => {
        playerPositions.delete(socket.username);
        io.to('voice_room').emit('peer_left', { socketId: socket.id });
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
