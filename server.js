const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Game state
const rooms = {};
const players = {};

// Constants
const CANVAS_WIDTH = 3000;
const CANVAS_HEIGHT = 2500;
const PLAYER_SIZE = 35;
const PLAYER_SPEED = 5;
const ENEMY_SIZE = 30;
const ENEMY_SPEED = 2;
const ATTACK_RANGE = 65;
const ATTACK_COOLDOWN = 20;
const BOW_RANGE = 250;
const ARROW_SPEED = 12;
const DEFEND_COOLDOWN = 60;
const DEFEND_DURATION = 30;

const PLAYER_COLORS = ['#4169e1', '#228b22', '#dc143c', '#ff8c00', '#9370db', '#20b2aa', '#ff69b4', '#ffd700'];

function createRoom(roomName) {
    const roomId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const room = {
        id: roomId,
        name: roomName,
        players: {},
        enemies: [],
        obstacles: [],
        arrows: [],
        gameLoop: null
    };

    // Setup obstacles
    const offsetX = 500;
    const offsetY = 250;
    room.obstacles = [
        { x: offsetX - 100, y: offsetY - 100, width: 2100, height: 60, type: 'wood' },
        { x: offsetX - 100, y: offsetY - 100, width: 60, height: 1700, type: 'wood' },
        { x: offsetX + 2040, y: offsetY - 100, width: 60, height: 1700, type: 'wood' },
        { x: offsetX - 100, y: offsetY + 1540, width: 2100, height: 60, type: 'wood' },
        { x: offsetX + 100, y: offsetY + 100, width: 120, height: 120, type: 'tower' },
        { x: offsetX + 1780, y: offsetY + 100, width: 120, height: 120, type: 'tower' },
        { x: offsetX + 100, y: offsetY + 1280, width: 120, height: 120, type: 'tower' },
        { x: offsetX + 1780, y: offsetY + 1280, width: 120, height: 120, type: 'tower' },
        { x: offsetX + 850, y: offsetY + 600, width: 300, height: 300, type: 'tower' },
    ];

    rooms[roomId] = room;

    spawnEnemies(roomId, 15);
    startRoomGameLoop(roomId);
    return roomId;
}

function spawnEnemies(roomId, count) {
    const room = rooms[roomId];
    if (!room) return;

    for (let i = 0; i < count; i++) {
        let x, y, attempts = 0;
        let validPosition = false;
        
        // Try to find a valid spawn position (not inside obstacles)
        while (!validPosition && attempts < 50) {
            x = Math.random() * (CANVAS_WIDTH - 200) + 100;
            y = Math.random() * (CANVAS_HEIGHT - 200) + 100;
            validPosition = !checkAnyObstacleCollision(x, y, ENEMY_SIZE, room.obstacles);
            attempts++;
        }
        
        // If we couldn't find a valid position after 50 attempts, spawn anyway
        if (!validPosition) {
            x = Math.random() * (CANVAS_WIDTH - 200) + 100;
            y = Math.random() * (CANVAS_HEIGHT - 200) + 100;
        }
        
        room.enemies.push({
            id: Date.now() + Math.random(),
            x, y,
            size: ENEMY_SIZE,
            speed: ENEMY_SPEED,
            health: 50,
            maxHealth: 50
        });
    }
}

function checkObstacleCollision(x, y, size, obs) {
    return x < obs.x + obs.width && x + size > obs.x && y < obs.y + obs.height && y + size > obs.y;
}

function checkAnyObstacleCollision(x, y, size, obstacles) {
    return obstacles.some(obs => checkObstacleCollision(x, y, size, obs));
}

function startRoomGameLoop(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.gameLoop = setInterval(() => {
        updateRoom(roomId);
        io.to(roomId).emit('gameState', {
            players: room.players,
            enemies: room.enemies,
            obstacles: room.obstacles,
            arrows: room.arrows
        });
    }, 1000 / 30);
}

function updateRoom(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Update arrows (iterate backwards to safely remove)
    for (let i = room.arrows.length - 1; i >= 0; i--) {
        const arrow = room.arrows[i];
        arrow.x += arrow.vx;
        arrow.y += arrow.vy;
        arrow.distance += Math.hypot(arrow.vx, arrow.vy);

        // Check if arrow hit obstacle or exceeded range
        if (checkAnyObstacleCollision(arrow.x, arrow.y, 5, room.obstacles) || arrow.distance > BOW_RANGE) {
            room.arrows.splice(i, 1);
            continue;
        }

        // Arrow hits enemy (check backwards to safely remove)
        let arrowRemoved = false;
        for (let j = room.enemies.length - 1; j >= 0; j--) {
            const enemy = room.enemies[j];
            const dist = Math.hypot(enemy.x + enemy.size/2 - arrow.x, enemy.y + enemy.size/2 - arrow.y);
            if (dist < enemy.size / 2) {
                enemy.health -= 25;
                io.to(roomId).emit('enemyHit', { x: enemy.x + enemy.size/2, y: enemy.y + enemy.size/2 });
                
                if (enemy.health <= 0) {
                    const shooter = room.players[arrow.playerId];
                    if (shooter) shooter.score += 10;
                    room.enemies.splice(j, 1);
                }
                
                // Remove arrow after hit
                room.arrows.splice(i, 1);
                arrowRemoved = true;
                break; // Arrow can only hit one enemy
            }
        }
        if (arrowRemoved) continue;
    }

    // Enemy AI
    room.enemies.forEach(enemy => {
        let nearestPlayer = null;
        let minDist = Infinity;

        Object.values(room.players).forEach(player => {
            if (player.health <= 0) return;
            const dist = Math.hypot(player.x - enemy.x, player.y - enemy.y);
            if (dist < minDist) {
                minDist = dist;
                nearestPlayer = player;
            }
        });

        if (nearestPlayer) {
            const dx = nearestPlayer.x - enemy.x;
            const dy = nearestPlayer.y - enemy.y;
            const dist = Math.hypot(dx, dy);

            if (dist > 0) {
                const newX = enemy.x + (dx / dist) * enemy.speed;
                const newY = enemy.y + (dy / dist) * enemy.speed;
                if (!checkAnyObstacleCollision(newX, newY, enemy.size, room.obstacles)) {
                    enemy.x = newX;
                    enemy.y = newY;
                }
            }

            // Damage player
            const collisionDist = Math.hypot(enemy.x + enemy.size/2 - (nearestPlayer.x + nearestPlayer.size/2),
                                             enemy.y + enemy.size/2 - (nearestPlayer.y + nearestPlayer.size/2));
            if (collisionDist < (enemy.size + nearestPlayer.size)/2) {
                if (!nearestPlayer.defending) {
                    nearestPlayer.health -= 0.08;
                    if (nearestPlayer.health <= 0) {
                        nearestPlayer.health = 0;
                        io.to(nearestPlayer.id).emit('playerDied', { playerId: nearestPlayer.id, score: nearestPlayer.score });
                    }
                }
            }
        }
    });

    // Player cooldowns
    Object.values(room.players).forEach(p => {
        if (p.attackCooldown > 0) p.attackCooldown--;
        if (p.attackCooldown === 0) p.attacking = false;
        if (p.bowCooldown > 0) p.bowCooldown--;
        if (p.defendCooldown > 0) p.defendCooldown--;
        if (p.defendDuration > 0) {
            p.defendDuration--;
            if (p.defendDuration === 0) p.defending = false;
        }
    });

    // Gradual enemy respawn
    if (room.enemies.length < 15 + Object.keys(room.players).length * 2) {
        if (Math.random() < 0.02) {
            spawnEnemies(roomId, 1);
        }
    }
}

// Player input
function handlePlayerInput(socket, data) {
    const player = players[socket.id];
    if (!player || !player.room) return;
    const room = rooms[player.room];
    if (!room || !room.players[socket.id]) return;

    const p = room.players[socket.id];
    if (p.health <= 0) return;

    let newX = p.x, newY = p.y;
    if (data.keys['w'] || data.keys['arrowup']) newY -= PLAYER_SPEED;
    if (data.keys['s'] || data.keys['arrowdown']) newY += PLAYER_SPEED;
    if (data.keys['a'] || data.keys['arrowleft']) newX -= PLAYER_SPEED;
    if (data.keys['d'] || data.keys['arrowright']) newX += PLAYER_SPEED;

    newX = Math.max(0, Math.min(CANVAS_WIDTH - PLAYER_SIZE, newX));
    newY = Math.max(0, Math.min(CANVAS_HEIGHT - PLAYER_SIZE, newY));
    if (!checkAnyObstacleCollision(newX, newY, PLAYER_SIZE, room.obstacles)) {
        p.x = newX;
        p.y = newY;
    }

    // Melee attack (iterate backwards to safely remove enemies)
    if (data.keys[' '] && p.attackCooldown === 0) {
        p.attacking = true;
        p.attackCooldown = ATTACK_COOLDOWN;
        for (let i = room.enemies.length - 1; i >= 0; i--) {
            const enemy = room.enemies[i];
            const dist = Math.hypot(enemy.x + enemy.size/2 - (p.x + p.size/2), enemy.y + enemy.size/2 - (p.y + p.size/2));
            if (dist < ATTACK_RANGE) {
                enemy.health -= 35;
                io.to(player.room).emit('enemyHit', { x: enemy.x + enemy.size/2, y: enemy.y + enemy.size/2 });
                if (enemy.health <= 0) {
                    p.score += 10;
                    room.enemies.splice(i, 1);
                }
            }
        }
    }

    // Bow attack
    if (data.keys['e'] && p.bowCooldown === 0) {
        p.bowCooldown = 30; // Bow cooldown in frames (1 second at 30fps)
        shootArrow(socket.id, player.room, data.mouseX, data.mouseY);
    }

    // Defend
    if (data.keys['q'] && p.defendCooldown === 0 && !p.defending) {
        p.defending = true;
        p.defendDuration = DEFEND_DURATION;
        p.defendCooldown = DEFEND_COOLDOWN;
    }
}

// Shoot arrow
function shootArrow(playerId, roomId, mouseX, mouseY) {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[playerId];
    if (!player) return;

    const px = player.x + player.size / 2;
    const py = player.y + player.size / 2;
    const dx = mouseX - px;
    const dy = mouseY - py;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) return;

    room.arrows.push({
        id: Date.now() + Math.random(),
        playerId,
        x: px,
        y: py,
        vx: (dx / dist) * ARROW_SPEED,
        vy: (dy / dist) * ARROW_SPEED,
        distance: 0
    });
}

// Socket events
io.on('connection', socket => {
    console.log('Player connected:', socket.id);
    players[socket.id] = { id: socket.id, name: 'Knight', room: null };

    socket.on('setPlayerName', name => { 
        if (players[socket.id]) {
            players[socket.id].name = name.substring(0, 15); // Limit name length
        }
    });

    socket.on('createRoom', roomName => {
        const roomId = createRoom(roomName.substring(0, 20)); // Limit room name length
        socket.emit('roomCreated', { roomId, roomName });
        io.emit('roomsList', Object.values(rooms).map(r => ({ id: r.id, name: r.name, players: Object.keys(r.players).length })));
    });

    socket.on('getRooms', () => {
        socket.emit('roomsList', Object.values(rooms).map(r => ({ id: r.id, name: r.name, players: Object.keys(r.players).length })));
    });

    socket.on('joinRoom', roomId => {
        const room = rooms[roomId];
        if (!room) return socket.emit('error', 'Room not found');
        if (Object.keys(room.players).length >= 8) return socket.emit('error', 'Room is full');
        if (players[socket.id].room) leaveRoom(socket.id);

        socket.join(roomId);
        players[socket.id].room = roomId;
        const colorIndex = Object.keys(room.players).length % PLAYER_COLORS.length;

        room.players[socket.id] = {
            id: socket.id,
            name: players[socket.id].name,
            x: CANVAS_WIDTH / 2,
            y: CANVAS_HEIGHT / 2,
            size: PLAYER_SIZE,
            speed: PLAYER_SPEED,
            health: 100,
            maxHealth: 100,
            score: 0,
            color: PLAYER_COLORS[colorIndex],
            attacking: false,
            attackCooldown: 0,
            bowCooldown: 0,
            defending: false,
            defendDuration: 0,
            defendCooldown: 0
        };

        socket.emit('roomJoined', roomId);
        io.emit('roomsList', Object.values(rooms).map(r => ({ id: r.id, name: r.name, players: Object.keys(r.players).length })));
    });

    socket.on('leaveRoom', () => {
        leaveRoom(socket.id);
        io.emit('roomsList', Object.values(rooms).map(r => ({ id: r.id, name: r.name, players: Object.keys(r.players).length })));
    });
    
    socket.on('playerInput', data => handlePlayerInput(socket, data));

    socket.on('disconnect', () => {
        leaveRoom(socket.id);
        delete players[socket.id];
        io.emit('roomsList', Object.values(rooms).map(r => ({ id: r.id, name: r.name, players: Object.keys(r.players).length })));
        console.log('Player disconnected:', socket.id);
    });
});

function leaveRoom(playerId) {
    const player = players[playerId];
    if (!player || !player.room) return;
    const room = rooms[player.room];
    if (room) {
        delete room.players[playerId];
        if (Object.keys(room.players).length === 0) {
            clearInterval(room.gameLoop);
            delete rooms[player.room];
        }
    }
    player.room = null;
}

http.listen(PORT, () => console.log(`Server running on port ${PORT}`));