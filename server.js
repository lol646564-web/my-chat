const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require("socket.io");
const bcrypt = require('bcryptjs');
const multer = require('multer');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => { cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname)); }
});

const upload = multer({ storage: storage, limits: { fileSize: 100 * 1024 * 1024 } }).single('media');

const server = http.createServer((req, res) => {
    if (req.url === '/') {
        fs.readFile('index.html', (err, data) => {
            if (err) { res.writeHead(500); res.end('Ошибка'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } 
    else if (req.url === '/upload-media' && req.method === 'POST') {
        upload(req, res, (err) => {
            if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
            if (!req.file) { res.writeHead(400); res.end('Файл не получен'); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: '/uploads/' + req.file.filename, type: req.file.mimetype }));
        });
    }
    else if (req.url === '/upload-avatar' && req.method === 'POST') {
        const avatarUpload = multer({ storage: storage }).single('avatar');
        avatarUpload(req, res, (err) => {
            if (err) { res.writeHead(500); res.end('Ошибка загрузки'); return; }
            if (!req.file) { res.writeHead(400); res.end('Файл не получен'); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ path: '/uploads/' + req.file.filename }));
        });
    }
    else if (req.url.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, req.url);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
            res.end(data);
        });
    }
    else { res.writeHead(404); res.end('Страница не найдена'); }
});

const io = new Server(server);

let users = {};
let messages = [];
let groups = {}; 
let onlineUsers = new Set();
const activeCalls = {}; 

if (fs.existsSync('users.json')) {
    let rawUsers = JSON.parse(fs.readFileSync('users.json', 'utf8'));
    for (let name in rawUsers) {
        if (typeof rawUsers[name] === 'string') users[name] = { password: rawUsers[name], status: "Пользователь чата", bio: "", avatar: null };
        else {
            users[name] = rawUsers[name];
            if (!users[name].avatar) users[name].avatar = null;
            if (users[name].bio === undefined) users[name].bio = "";
        }
    }
}
if (fs.existsSync('messages.json')) messages = JSON.parse(fs.readFileSync('messages.json', 'utf8'));
if (fs.existsSync('groups.json')) groups = JSON.parse(fs.readFileSync('groups.json', 'utf8'));

function saveUsers() { fs.writeFileSync('users.json', JSON.stringify(users, null, 2)); }
function saveMessages() { fs.writeFileSync('messages.json', JSON.stringify(messages, null, 2)); }
function saveGroups() { fs.writeFileSync('groups.json', JSON.stringify(groups, null, 2)); }

function getUserRooms(username) {
    const rooms = new Set();
    rooms.add('general');
    for (const [roomId, roomData] of Object.entries(groups)) {
        if (roomData.members.includes(username)) rooms.add(roomId);
    }
    return Array.from(rooms);
}

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('register', (data) => {
        const { username, password } = data;
        if (users[username]) return socket.emit('auth error', 'Пользователь уже существует!');
        users[username] = { password: bcrypt.hashSync(password, 10), status: "Пользователь чата", bio: "", avatar: null };
        saveUsers();
        socket.emit('auth success', username);
    });

    socket.on('login', (data) => {
        const { username, password } = data;
        if (!users[username]) return socket.emit('auth error', 'Пользователь не найден!');
        const dbPass = typeof users[username] === 'string' ? users[username] : users[username].password;
        if (bcrypt.compareSync(password, dbPass)) {
            currentUser = username;
            onlineUsers.add(username);
            activeCalls[username] = socket.id; 
            io.emit('online status', Array.from(onlineUsers));
            socket.emit('auth success', username);
            socket.emit('room list', getUserRooms(username));
        } else {
            socket.emit('auth error', 'Неверный пароль!');
        }
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser);
            delete activeCalls[currentUser];
            io.emit('online status', Array.from(onlineUsers));
        }
    });

    socket.on('get rooms', (username) => socket.emit('room list', getUserRooms(username)));
    socket.on('get all users', () => {
        const userList = Object.keys(users).map(name => ({ username: name, avatar: users[name].avatar }));
        socket.emit('all users list', userList);
    });
    socket.on('get profile', (username) => {
        if (!users[username]) return socket.emit('profile error', 'Пользователь не найден');
        socket.emit('profile data', { 
            username: username, status: users[username].status, bio: users[username].bio || "", avatar: users[username].avatar,
            isOnline: onlineUsers.has(username)
        });
    });
    socket.on('update profile', (data) => {
        const { oldUsername, newUsername, status, bio, avatar } = data;
        if (newUsername !== oldUsername && users[newUsername]) return socket.emit('profile error', 'Это имя уже занято!');
        const userData = users[oldUsername];
        const updatedData = { password: userData.password, status: status, bio: bio !== undefined ? bio : (userData.bio || ""), avatar: avatar !== undefined ? avatar : userData.avatar };
        if (newUsername !== oldUsername) {
            users[newUsername] = updatedData; delete users[oldUsername];
            messages.forEach(m => { if (m.user === oldUsername) m.user = newUsername; });
            saveMessages();
        } else users[oldUsername] = updatedData;
        saveUsers();
        socket.emit('profile updated', newUsername);
    });
    socket.on('check user', (username) => {
        if (!users[username]) socket.emit('user not found', username);
        else socket.emit('user found', username);
    });
    socket.on('create private chat', (data) => {
        const roomId = [data.user, data.friend].sort().join('_');
        if (!groups[roomId]) {
            groups[roomId] = { name: 'ЛС', members: [data.user, data.friend] };
            saveGroups();
            io.emit('update room list');
        }
        socket.emit('private chat created', roomId);
    });
    socket.on('create group', (data) => {
        const roomId = 'group_' + Date.now();
        groups[roomId] = { name: data.groupName, members: data.members };
        saveGroups();
        const systemMsg = {
            id: Date.now() + '-sys',
            user: 'Система', message: `Группа "${data.groupName}" создана.`,
            room: roomId, avatar: null, isMedia: false, reactions: {}
        };
        messages.push(systemMsg);
        saveMessages();
        io.emit('update room list'); 
    });
    socket.on('join room', (roomName) => {
        socket.join(roomName);
        const roomMessages = messages.filter(m => m.room === roomName);
        socket.emit('room history', roomMessages);
    });
    socket.on('get room name', (roomId) => {
        if (groups[roomId]) {
            let name = groups[roomId].name;
            if (name === 'ЛС') {
                const parts = roomId.split('_');
                const friend = parts.find(p => p !== currentUser);
                name = friend; 
            }
            socket.emit('room name', { roomId: roomId, name: name });
        }
    });
    socket.on('chat message', (data) => {
        const msgObj = { 
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            user: data.user, message: data.message, room: data.room,
            avatar: users[data.user] ? users[data.user].avatar : null,
            isMedia: false, mediaUrl: null, mediaType: null, reactions: {}, replyTo: data.replyTo || null
        };
        messages.push(msgObj); saveMessages();
        io.to(data.room).emit('chat message', msgObj);
    });
    socket.on('send media', (data) => {
        const msgObj = { 
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            user: data.user, message: data.caption || '', room: data.room,
            avatar: users[data.user] ? users[data.user].avatar : null,
            isMedia: true, mediaUrl: data.url, mediaType: data.type, reactions: {}, replyTo: data.replyTo || null
        };
        messages.push(msgObj); saveMessages();
        io.to(data.room).emit('chat message', msgObj);
    });
    socket.on('delete message', (data) => {
        const msgIndex = messages.findIndex(m => m.id === data.messageId && m.user === data.user);
        if (msgIndex !== -1) {
            const room = messages[msgIndex].room;
            messages.splice(msgIndex, 1); saveMessages();
            io.to(room).emit('message deleted', data.messageId);
        }
    });
    socket.on('add reaction', (data) => {
        const msg = messages.find(m => m.id === data.messageId);
        if (msg) {
            if (!msg.reactions) msg.reactions = {};
            if (!msg.reactions[data.emoji]) msg.reactions[data.emoji] = [];
            const userIndex = msg.reactions[data.emoji].indexOf(data.user);
            if (userIndex === -1) msg.reactions[data.emoji].push(data.user);
            else {
                msg.reactions[data.emoji].splice(userIndex, 1);
                if (msg.reactions[data.emoji].length === 0) delete msg.reactions[data.emoji];
            }
            saveMessages();
            io.to(msg.room).emit('update reaction', { messageId: msg.id, reactions: msg.reactions });
        }
    });
    socket.on('typing', (data) => socket.to(data.room).emit('user typing', data.user));
    socket.on('stop typing', (data) => socket.to(data.room).emit('user stop typing', data.user));

    // --- ЗВОНКИ ---
    socket.on('call user', (data) => {
        const targetSocketId = activeCalls[data.to];
        if (targetSocketId) io.to(targetSocketId).emit('incoming call', { from: data.from, offer: data.offer });
        else socket.emit('call error', 'Пользователь не в сети');
    });
    socket.on('answer call', (data) => {
        const targetSocketId = activeCalls[data.to];
        if (targetSocketId) io.to(targetSocketId).emit('call answered', { answer: data.answer });
    });
    socket.on('end call', (data) => {
        const targetSocketId = activeCalls[data.to];
        if (targetSocketId) io.to(targetSocketId).emit('call ended');
    });
    socket.on('ice candidate', (data) => {
        const targetSocketId = activeCalls[data.to];
        if (targetSocketId) io.to(targetSocketId).emit('ice candidate', { candidate: data.candidate });
    });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});