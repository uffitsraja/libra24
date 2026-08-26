const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);

const FB_DB = process.env.FIREBASE_DB_URL || 'https://lucky-7-casino-default-rtdb.asia-southeast1.firebasedatabase.app';
const FB_ROOT = 'libra24';

const FILES = {
  users: path.join(DATA, 'users.json'),
  games: path.join(DATA, 'games.json'),
  settings: path.join(DATA, 'settings.json'),
  notifs: path.join(DATA, 'notifications.json')
};

const DEFAULT_GAMES = {
  aviator: { id: 'aviator', name: 'Aviator', image: '', url: '', active: true, order: 1 },
  teenpatti: { id: 'teenpatti', name: 'Teen Patti', image: '', url: '', active: true, order: 2 },
  andarbahar: { id: 'andarbahar', name: 'Andar Bahar', image: '', url: '', active: true, order: 3 },
  lucky7: { id: 'lucky7', name: 'Lucky 7', image: '', url: '', active: true, order: 4 },
  simplebets: { id: 'simplebets', name: 'Simple Bets', image: '', url: '', active: true, order: 5 }
};

function loadLocal(file, def = {}) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  return def;
}

async function fbGet(key, def) {
  try {
    const res = await fetch(`${FB_DB}/${FB_ROOT}/${key}.json`);
    if (!res.ok) throw new Error('FB get ' + res.status);
    const data = await res.json();
    if (data === null || data === undefined) return def;
    return data;
  } catch (e) {
    console.error('FB get failed', key, e.message);
    return loadLocal(FILES[key] || path.join(DATA, key + '.json'), def);
  }
}

async function fbSet(key, data) {
  try {
    const file = FILES[key] || path.join(DATA, key + '.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {}
  try {
    const res = await fetch(`${FB_DB}/${FB_ROOT}/${key}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) console.error('FB set failed', key, res.status);
  } catch (e) {
    console.error('FB set error', key, e.message);
  }
}

function save(file, data) {
  let key = 'users';
  if (file.includes('games')) key = 'games';
  else if (file.includes('settings')) key = 'settings';
  else if (file.includes('notif')) key = 'notifs';
  else if (file.includes('users')) key = 'users';
  fbSet(key, data);
}

let users = {};
let games = { ...DEFAULT_GAMES };
let settings = { siteName: 'Libra 24', notifyAgents: [] };
let notifications = [];
let transactions = [];

async function initData() {
  users = await fbGet('users', {});
  games = await fbGet('games', DEFAULT_GAMES);
  settings = await fbGet('settings', { siteName: 'Libra 24', notifyAgents: [] });
  notifications = await fbGet('notifs', []);
  if (!Array.isArray(notifications)) notifications = [];
  transactions = await fbGet('transactions', []);
  if (!Array.isArray(transactions)) transactions = [];

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
  }
  Object.keys(DEFAULT_GAMES).forEach(id => {
    if (!games[id]) games[id] = DEFAULT_GAMES[id];
  });
  await fbSet('users', users);
  await fbSet('games', games);
  await fbSet('settings', settings);
  await fbSet('notifs', notifications);
  await fbSet('transactions', transactions);
  console.log('Libra data loaded. Users:', Object.keys(users).length);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function pushTx(tx) {
  transactions.unshift(tx);
  if (transactions.length > 500) transactions = transactions.slice(0, 500);
  fbSet('transactions', transactions);
}

app.post('/api/wallet/adjust', (req, res) => {
  try {
    const { username, token, delta, reason, game } = req.body || {};
    const u = users[(username || '').trim().toLowerCase()];
    if (!u) return res.status(404).json({ success: false, message: 'User not found' });
    if (!token || u.token !== token) return res.status(401).json({ success: false, message: 'Invalid token' });
    if (u.role !== 'player') return res.status(403).json({ success: false, message: 'Players only' });

    const d = Number(delta) || 0;
    u.coins = Math.max(0, (Number(u.coins) || 0) + d);
    save(FILES.users, users);

    const tx = {
      id: uuidv4(),
      username: u.username,
      delta: d,
      balance: u.coins,
      reason: reason || (d >= 0 ? 'win' : 'bet'),
      game: game || 'game',
      time: new Date().toISOString()
    };
    pushTx(tx);

    io.emit('balance_update', { username: u.username, coins: u.coins });
    io.to('master').emit('users_updated', getSafeUsers());
    if (u.parent) io.to('agent_' + u.parent).emit('users_updated', getSafeUsers());

    res.json({ success: true, coins: u.coins, tx });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/wallet/history', (req, res) => {
  try {
    const username = (req.query.username || '').trim().toLowerCase();
    const token = req.query.token || '';
    const u = users[username];
    if (!u || u.token !== token) return res.status(401).json({ success: false, message: 'Unauthorized' });
    const list = transactions.filter(t => t.username === username).slice(0, 50);
    res.json({ success: true, transactions: list, coins: u.coins });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/master', (req, res) => res.sendFile(path.join(__dirname, 'public', 'master.html')));
app.get('/agent', (req, res) => res.sendFile(path.join(__dirname, 'public', 'agent.html')));

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
      id: uuidv4(), username,
      password: bcrypt.hashSync(password, 8),
      role: 'agent', coins: Number(coins) || 0,
      sharePercent: Number(sharePercent) || 0,
      isActive: true, parent: 'master',
      createdAt: new Date().toISOString(), token: null
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
      id: uuidv4(), username,
      password: bcrypt.hashSync(password, 8),
      role: 'player', coins: Number(coins) || 0,
      sharePercent: 0, isActive: true, parent,
      createdAt: new Date().toISOString(), token: null
    };
    save(FILES.users, users);
    io.to('master').emit('users_updated', getSafeUsers());
    if (parent) io.to('agent_' + parent).emit('users_updated', getSafeUsers());
    cb({ success: true });
  });  socket.on('update_coins', ({ username, amount }, cb) => {
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
    if (!u || !g) return cb({ success: false });

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
    (settings.notifyAgents || []).forEach(ag => io.to('agent_' + ag).emit('notification', msg));

    let finalUrl = g.url || '';
    if (finalUrl && u.token) {
      const sep = finalUrl.includes('?') ? '&' : '?';
      finalUrl = finalUrl + sep + 'user=' + encodeURIComponent(u.username)
        + '&token=' + encodeURIComponent(u.token)
        + '&role=player'
        + '&coins=' + encodeURIComponent(u.coins || 0);
    }
    cb({ success: true, url: finalUrl });
  });

  socket.on('live_bet', (data) => {
    io.to('master').emit('live_bet', data);
  });

  socket.on('get_transactions', (cb) => {
    if (socket.role !== 'player' && socket.role !== 'master' && socket.role !== 'agent') {
      return typeof cb === 'function' && cb({ success: false });
    }
    let list = transactions || [];
    if (socket.role === 'player') {
      list = list.filter(t => t.username === socket.username).slice(0, 40);
    } else if (socket.role === 'agent') {
      list = list.filter(t => {
        const u = users[t.username];
        return u && u.parent === socket.username;
      }).slice(0, 50);
    } else {
      list = list.slice(0, 80);
    }
    if (typeof cb === 'function') cb({ success: true, transactions: list });
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
      socket.emit('agent_state', {
        users: myPlayers,
        games,
        notifications: notifications.filter(n => n.username && users[n.username]?.parent === socket.username).slice(0, 30)
      });
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

initData().then(() => {
  server.listen(PORT, () => {
    console.log(`Libra 24 running on http://localhost:${PORT}`);
    console.log(`Master login: master / master123`);
    console.log(`Data: Firebase ${FB_DB}/${FB_ROOT}`);
  });
}).catch(err => {
  console.error('Init failed', err);
  server.listen(PORT, () => console.log('Started with empty/local data'));
});
