// ==========================================
// CONFIGURATION OPTIONS
// ==========================================
const ENABLE_PRIVATE_CALLS = true; // Set to false to disable private calls globally

// ==========================================
// SOCKET.IO LOGIC
// ==========================================
// Inside your io.on('connection', (socket) => { ... }) block:

// Send toggle state & player list to newly connected client
socket.emit('config_state', { privateCallsEnabled: ENABLE_PRIVATE_CALLS });

// Private Call Request
socket.on('request_private_call', ({ targetSocketId }) => {
    if (!ENABLE_PRIVATE_CALLS) {
        socket.emit('call_error', { message: 'Private calls are currently disabled on this server.' });
        return;
    }

    io.to(targetSocketId).emit('call_invite', {
        senderSocketId: socket.id,
        senderUsername: socket.handshake.auth.username
    });
});

socket.on('accept_private_call', ({ targetSocketId }) => {
    if (!ENABLE_PRIVATE_CALLS) return;

    // Notify caller that call was accepted
    io.to(targetSocketId).emit('call_accepted', { targetSocketId: socket.id });

    // Broadcast status updates to all connected players
    io.emit('player_status_change', { socketId: socket.id, inPrivateCall: true, partnerSocketId: targetSocketId });
    io.emit('player_status_change', { socketId: targetSocketId, inPrivateCall: true, partnerSocketId: socket.id });
});

socket.on('decline_private_call', ({ targetSocketId }) => {
    io.to(targetSocketId).emit('call_declined', { targetSocketId: socket.id });
});

socket.on('end_private_call', ({ targetSocketId }) => {
    // Notify target partner
    io.to(targetSocketId).emit('private_call_ended', { socketId: socket.id });

    // Broadcast status clear to everyone
    io.emit('player_status_change', { socketId: socket.id, inPrivateCall: false });
    io.emit('player_status_change', { socketId: targetSocketId, inPrivateCall: false });
});
