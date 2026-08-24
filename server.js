const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);

const FILES = {
  users: path.join(DATA, 'users.json'),
  games: path.join(DATA, 'games.json'),
  settings: path.join(DATA, 'settings.json'),
  notifs: path.join(DATA, 'notifications.json')
};

function load(file, def = {}) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e){}
  return def;
}
function save(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let users = load(FILES.users, {});
let games = load(FILES.games, {
  aviator: { id: 'aviator', name: 'Aviator', image: '', url: '', active: true, order: 1 },
  teenpatti: { id: 'teenpatti', name: 'Teen Patti', image: '', url: '', active: true, order: 2 },
  andarbahar: { id: 'andarbahar', name: 'Andar Bahar', image: '', url: '', active: true, order: 3 },
  lucky7: { id: 'lucky7', name: 'Lucky 7', image: '', url: '', active: true, order: 4 },
  simplebets: { id: 'simplebets', name: 'Simple Bets', image: '', url: '', active: true, order: 5 }
});
let settings = load(FILES.settings, {
  siteName: 'Libra 24',
  notifyAgents: []
});
let notifications = load(FILES.notifs, []);
let gameTokens = {}; // temporary tokens for games
if (!users['master']) {
  users['master'] = {
    id: uuidv4(),
    username: 'master',
    password: bcrypt.hashSync('master123', 8),
    role: 'master',
    coins: 0,
    sharePercent: 0,
    isActive: true,
    parent: null,
    createdAt: new Date().toISOString(),
    token: null
  };
  save(FILES.users, users);
}
save(FILES.games, games);
save(FILES.settings, settings);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/master', (req, res) => res.sendFile(path.join(__dirname, 'public', 'master.html')));
app.get('/agent', (req, res) => res.sendFile(path.join(__dirname, 'public', 'agent.html')));
// Token validate API for games
app.get('/api/validate-token', (req, res) => {
  const { token, user } = req.query;
  if (!token || !user) {
    return res.json({ success: false, message: 'Missing token' });
  }

  const data = gameTokens[token];
  if (!data || data.username !== user || data.expires < Date.now()) {
    return res.json({ success: false, message: 'Invalid or expired token' });
  }

  res.json({
    success: true,
    username: data.username,
    coins: data.coins
  });
});
io.on('connection', (socket) => {
  socket.on('login', ({ username, password }, cb) => {
    username = (username || '').trim().toLowerCase();
    const u = users[username];
    if (!u || !u.isActive) return cb({ success: false, message: 'Invalid ID or inactive' });
    if (!bcrypt.compareSync(password, u.password)) return cb({ success: false, message: 'Wrong password' });

    u.token = crypto.randomBytes(20).toString('hex');
    u.lastLogin = new Date().toISOString();
    save(FILES.users, users);

    socket.username = username;
    socket.role = u.role;
    socket.join(u.role);
    if (u.role === 'agent') socket.join('agent_' + username);
    if (u.role === 'player' && u.parent) socket.join('agent_' + u.parent);

    if (u.role === 'player') {
      const msg = {
        id: uuidv4(),
        type: 'site_enter',
        text: `Player ${u.username} (Coins: ${u.coins}) entered Libra 24`,
        username: u.username,
        coins: u.coins,
        time: new Date().toISOString()
      };
      notifications.unshift(msg);
      if (notifications.length > 200) notifications.pop();
      save(FILES.notifs, notifications);

      io.to('master').emit('notification', msg);
      (settings.notifyAgents || []).forEach(ag => {
        io.to('agent_' + ag).emit('notification', msg);
      });
    }

    cb({
      success: true,
      user: {
        username: u.username,
        role: u.role,
        coins: u.coins,
        sharePercent: u.sharePercent || 0,
        token: u.token,
        parent: u.parent
      }
    });
  });

  socket.on('auth', ({ username, token }, cb) => {
    const u = users[username];
    if (!u || u.token !== token) return cb({ success: false });
    socket.username = username;
    socket.role = u.role;
    socket.join(u.role);
    if (u.role === 'agent') socket.join('agent_' + username);
    if (u.role === 'player' && u.parent) socket.join('agent_' + u.parent);
    cb({ success: true, user: { username: u.username, role: u.role, coins: u.coins, sharePercent: u.sharePercent || 0, parent: u.parent } });
  });

  socket.on('master_create_agent', ({ username, password, sharePercent, coins }, cb) => {
    if (socket.role !== 'master') return cb({ success: false });
    username = (username || '').trim().toLowerCase();
    if (!username || !password) return cb({ success: false, message: 'Required' });
    if (users[username]) return cb({ success: false, message: 'Already exists' });

    users[username] = {
      id: uuidv4(),
      username,
      password: bcrypt.hashSync(password, 8),
      role: 'agent',
      coins: Number(coins) || 0,
      sharePercent: Number(sharePercent) || 0,
      isActive: true,
      parent: 'master',
      createdAt: new Date().toISOString(),
      token: null
    };
    save(FILES.users, users);
    io.to('master').emit('users_updated', getSafeUsers());
    cb({ success: true });
  });

  socket.on('master_create_player', ({ username, password, coins, agent }, cb) => {
    if (socket.role !== 'master' && socket.role !== 'agent') return cb({ success: false });
    username = (username || '').trim().toLowerCase();
    if (!username || !password) return cb({ success: false, message: 'Required' });
    if (users[username]) return cb({ success: false, message: 'Already exists' });

    const parent = socket.role === 'master' ? (agent || null) : socket.username;

    users[username] = {
      id: uuidv4(),
      username,
      password: bcrypt.hashSync(password, 8),
      role: 'player',
      coins: Number(coins) || 0,
      sharePercent: 0,
      isActive: true,
      parent,
      createdAt: new Date().toISOString(),
      token: null
    };
    save(FILES.users, users);
    io.to('master').emit('users_updated', getSafeUsers());
    if (parent) io.to('agent_' + parent).emit('users_updated', getSafeUsers());
    cb({ success: true });
  });
    socket.on('update_coins', ({ username, amount }, cb) => {
    if (socket.role !== 'master' && socket.role !== 'agent') return cb({ success: false });
    const u = users[username];
    if (!u) return cb({ success: false, message: 'Not found' });
    if (socket.role === 'agent' && u.parent !== socket.username) return cb({ success: false, message: 'Not your player' });

    u.coins = Math.max(0, (u.coins || 0) + Number(amount));
    save(FILES.users, users);
    io.emit('balance_update', { username, coins: u.coins });
    io.to('master').emit('users_updated', getSafeUsers());
    cb({ success: true, coins: u.coins });
  });

  socket.on('toggle_user', ({ username, active }, cb) => {
    if (socket.role !== 'master' && socket.role !== 'agent') return cb({ success: false });
    const u = users[username];
    if (!u) return cb({ success: false });
    if (socket.role === 'agent' && u.parent !== socket.username) return cb({ success: false });
    u.isActive = !!active;
    save(FILES.users, users);
    io.to('master').emit('users_updated', getSafeUsers());
    cb({ success: true });
  });

  socket.on('set_share', ({ username, percent }, cb) => {
    if (socket.role !== 'master') return cb({ success: false });
    const u = users[username];
    if (!u || u.role !== 'agent') return cb({ success: false });
    u.sharePercent = Number(percent) || 0;
    save(FILES.users, users);
    io.to('master').emit('users_updated', getSafeUsers());
    cb({ success: true });
  });

  socket.on('update_game', ({ id, name, image, url, active }, cb) => {
    if (socket.role !== 'master') return cb({ success: false });
    if (!games[id]) games[id] = { id, order: Object.keys(games).length + 1 };
    if (name !== undefined) games[id].name = name;
    if (image !== undefined) games[id].image = image;
    if (url !== undefined) games[id].url = url;
    if (active !== undefined) games[id].active = active;
    save(FILES.games, games);
    io.emit('games_updated', games);
    cb({ success: true });
  });

  socket.on('set_notify_agents', ({ agents }, cb) => {
    if (socket.role !== 'master') return cb({ success: false });
    settings.notifyAgents = agents || [];
    save(FILES.settings, settings);
    cb({ success: true });
  });

  socket.on('master_update_profile', ({ newUsername, newPassword, currentPassword }, cb) => {
    if (socket.role !== 'master') return cb({ success: false });
    const u = users[socket.username];
    if (!u) return cb({ success: false, message: 'Not found' });

    if (newPassword && newPassword.length > 0) {
      if (!currentPassword || !bcrypt.compareSync(currentPassword, u.password)) {
        return cb({ success: false, message: 'Current password galat hai' });
      }
      if (newPassword.length < 4) return cb({ success: false, message: 'New password kam se kam 4 characters' });
      u.password = bcrypt.hashSync(newPassword, 8);
    }

    if (newUsername && newUsername.trim() && newUsername.trim().toLowerCase() !== socket.username) {
      const nu = newUsername.trim().toLowerCase();
      if (users[nu]) return cb({ success: false, message: 'Username already exists' });
      users[nu] = { ...u, username: nu };
      delete users[socket.username];
      socket.username = nu;
      u.username = nu;
    }

    save(FILES.users, users);
    u.token = crypto.randomBytes(20).toString('hex');
    save(FILES.users, users);

    cb({
      success: true,
      user: {
        username: u.username,
        role: u.role,
        coins: u.coins,
        token: u.token
      }
    });
  });

 socket.on('player_enter_game', ({ gameId }, cb) => {
  if (socket.role !== 'player') return cb({ success: false });
  const u = users[socket.username];
  const g = games[gameId];
  if (!u || !g || !g.url) return cb({ success: false, message: 'Game not available' });

  // Temporary token (60 seconds)
  const token = crypto.randomBytes(16).toString('hex');
  gameTokens[token] = {
    username: u.username,
    coins: u.coins,
    expires: Date.now() + 60 * 1000
  };

  // Clean old tokens
  Object.keys(gameTokens).forEach(t => {
    if (gameTokens[t].expires < Date.now()) delete gameTokens[t];
  });

  const msg = {
    id: uuidv4(),
    type: 'game_enter',
    text: `Player ${u.username} (Coins: ${u.coins}) entered ${g.name}`,
    username: u.username,
    coins: u.coins,
    game: g.name,
    time: new Date().toISOString()
  };
  notifications.unshift(msg);
  if (notifications.length > 200) notifications.pop();
  save(FILES.notifs, notifications);

  io.to('master').emit('notification', msg);
  (settings.notifyAgents || []).forEach(ag => {
    io.to('agent_' + ag).emit('notification', msg);
  });

  const base = g.url.endsWith('/') ? g.url.slice(0, -1) : g.url;
  const finalUrl = `${base}/?token=${token}&user=${encodeURIComponent(u.username)}`;

  cb({ success: true, url: finalUrl });
});

  socket.on('live_bet', (data) => {
    io.to('master').emit('live_bet', data);
  });

  socket.on('get_state', () => {
    const safe = getSafeUsers();
    if (socket.role === 'master') {
      socket.emit('full_state', { users: safe, games, settings, notifications: notifications.slice(0, 50) });
    } else if (socket.role === 'agent') {
      const myPlayers = {};
      Object.values(safe).forEach(u => {
        if (u.parent === socket.username || u.username === socket.username) myPlayers[u.username] = u;
      });
      socket.emit('agent_state', { users: myPlayers, games, notifications: notifications.filter(n => n.username && users[n.username]?.parent === socket.username).slice(0, 30) });
    } else if (socket.role === 'player') {
      const u = users[socket.username];
      socket.emit('player_state', { coins: u?.coins || 0, games });
    }
  });

  socket.on('disconnect', () => {});
});

function getSafeUsers() {
  const out = {};
  Object.values(users).forEach(u => {
    out[u.username] = {
      username: u.username,
      role: u.role,
      coins: u.coins,
      sharePercent: u.sharePercent || 0,
      isActive: u.isActive,
      parent: u.parent,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin
    };
  });
  return out;
}

server.listen(PORT, () => {
  console.log(`Libra 24 running on http://localhost:${PORT}`);
  console.log(`Master login: master / master123`);
});
