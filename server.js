const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require("socket.io");
const bcrypt = require('bcryptjs');
const multer = require('multer');
const mongoose = require('mongoose');

const MONGO_URI = 'mongodb+srv://lol646564_db_user:ldX5Ta9z4tjIj1dK@cadelyfiles.wmgybw6.mongodb.net/?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB подключена!'))
    .catch(err => console.error('Ошибка подключения к MongoDB:', err));

// Схемы
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: String,
    status: { type: String, default: "Пользователь чата" },
    bio: { type: String, default: "" },
    avatar: { type: String, default: null }
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
    id: String, user: String, message: String, room: String, avatar: String,
    isMedia: Boolean, mediaUrl: String, mediaType: String, reactions: { type: Object, default: {} }, replyTo: String
});
const Message = mongoose.model('Message', MessageSchema);

const GroupSchema = new mongoose.Schema({
    id: { type: String, unique: true }, name: String, members: [String]
});
const Group = mongoose.model('Group', GroupSchema);

// Настройки сервера
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
let onlineUsers = new Set();
const activeCalls = {}; 

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('register', async (data) => {
        try {
            const { username, password } = data;
            const existing = await User.findOne({ username });
            if (existing) return socket.emit('auth error', 'Пользователь уже существует!');
            const hashedPassword = bcrypt.hashSync(password, 10);
            const newUser = new User({ username, password: hashedPassword });
            await newUser.save();
            socket.emit('auth success', username);
        } catch (e) { socket.emit('auth error', 'Ошибка регистрации'); }
    });

    socket.on('login', async (data) => {
        try {
            const { username, password } = data;
            const user = await User.findOne({ username });
            if (!user) return socket.emit('auth error', 'Пользователь не найден!');
            if (bcrypt.compareSync(password, user.password)) {
                currentUser = username;
                onlineUsers.add(username);
                activeCalls[username] = socket.id; 
                
                // Отправляем статус всем
                io.emit('online status', Array.from(onlineUsers));
                
                socket.emit('auth success', username);
                
                // Загружаем комнаты
                const groups = await Group.find({ members: username });
                const rooms = ['general', ...groups.map(g => g.id)];
                const allGroups = await Group.find({});
                allGroups.forEach(g => { if(g.id.includes('_') && g.members.includes(username)) rooms.push(g.id); });
                socket.emit('room list', [...new Set(rooms)]);
            } else {
                socket.emit('auth error', 'Неверный пароль!');
            }
        } catch (e) { socket.emit('auth error', 'Ошибка входа'); }
    });

    socket.on('disconnect', () => {
        if (currentUser) {
            onlineUsers.delete(currentUser);
            delete activeCalls[currentUser];
            io.emit('online status', Array.from(onlineUsers));
        }
    });

    socket.on('get rooms', async (username) => {
        const groups = await Group.find({ members: username });
        const rooms = ['general', ...groups.map(g => g.id)];
        socket.emit('room list', [...new Set(rooms)]);
    });

    socket.on('get all users', async () => {
        const users = await User.find({}, 'username avatar');
        socket.emit('all users list', users);
    });

    socket.on('get profile', async (username) => {
        const user = await User.findOne({ username });
        if (!user) return socket.emit('profile error', 'Пользователь не найден');
        socket.emit('profile data', { 
            username: user.username, status: user.status, bio: user.bio, avatar: user.avatar,
            isOnline: onlineUsers.has(username)
        });
    });

    socket.on('update profile', async (data) => {
        const { oldUsername, newUsername, status, bio, avatar } = data;
        if (newUsername !== oldUsername) {
            const existing = await User.findOne({ username: newUsername });
            if (existing) return socket.emit('profile error', 'Это имя уже занято!');
        }
        await User.updateOne({ username: oldUsername }, { username: newUsername, status, bio, avatar });
        socket.emit('profile updated', newUsername);
    });

    socket.on('check user', async (username) => {
        const user = await User.findOne({ username });
        if (!user) socket.emit('user not found', username);
        else socket.emit('user found', username);
    });

    socket.on('create private chat', async (data) => {
        const roomId = [data.user, data.friend].sort().join('_');
        const existing = await Group.findOne({ id: roomId });
        if (!existing) {
            await new Group({ id: roomId, name: 'ЛС', members: [data.user, data.friend] }).save();
            io.emit('update room list');
        }
        socket.emit('private chat created', roomId);
    });

    socket.on('create group', async (data) => {
        const roomId = 'group_' + Date.now();
        await new Group({ id: roomId, name: data.groupName, members: data.members }).save();
        const sysMsg = new Message({
            id: Date.now() + '-sys', user: 'Система', message: `Группа "${data.groupName}" создана.`,
            room: roomId, avatar: null, isMedia: false, reactions: {}
        });
        await sysMsg.save();
        io.emit('update room list'); 
    });

    socket.on('join room', async (roomName) => {
        socket.join(roomName);
        const msgs = await Message.find({ room: roomName });
        socket.emit('room history', msgs);
    });

    socket.on('get room name', async (roomId) => {
        const group = await Group.findOne({ id: roomId });
        if (group) {
            let name = group.name;
            if (name === 'ЛС') {
                const parts = roomId.split('_');
                name = parts.find(p => p !== currentUser); 
            }
            socket.emit('room name', { roomId: roomId, name: name });
        }
    });

    socket.on('chat message', async (data) => {
        const user = await User.findOne({ username: data.user });
        const msg = new Message({
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            user: data.user, message: data.message, room: data.room,
            avatar: user ? user.avatar : null, isMedia: false, reactions: {}, replyTo: data.replyTo || null
        });
        await msg.save();
        io.to(data.room).emit('chat message', msg);
    });

    socket.on('send media', async (data) => {
        const user = await User.findOne({ username: data.user });
        const msg = new Message({
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            user: data.user, message: data.caption || '', room: data.room,
            avatar: user ? user.avatar : null, isMedia: true, mediaUrl: data.url, mediaType: data.type, reactions: {}, replyTo: data.replyTo || null
        });
        await msg.save();
        io.to(data.room).emit('chat message', msg);
    });

    socket.on('delete message', async (data) => {
        await Message.deleteOne({ id: data.messageId, user: data.user });
        io.to(data.room || 'general').emit('message deleted', data.messageId);
    });

    socket.on('add reaction', async (data) => {
        const msg = await Message.findOne({ id: data.messageId });
        if (msg) {
            let reactions = msg.reactions || {};
            if (!reactions[data.emoji]) reactions[data.emoji] = [];
            const idx = reactions[data.emoji].indexOf(data.user);
            if (idx === -1) reactions[data.emoji].push(data.user);
            else { reactions[data.emoji].splice(idx, 1); if (reactions[data.emoji].length === 0) delete reactions[data.emoji]; }
            msg.reactions = reactions;
            await msg.save();
            io.to(msg.room).emit('update reaction', { messageId: msg.id, reactions: reactions });
        }
    });

    socket.on('typing', (data) => socket.to(data.room).emit('user typing', data.user));
    socket.on('stop typing', (data) => socket.to(data.room).emit('user stop typing', data.user));

    // --- ЗВОНКИ ---
    socket.on('call user', (data) => {
        const target = activeCalls[data.to];
        if (target) io.to(target).emit('incoming call', { from: data.from, offer: data.offer });
        else socket.emit('call error', 'Пользователь не в сети');
    });
    socket.on('answer call', (data) => {
        const target = activeCalls[data.to];
        if (target) io.to(target).emit('call answered', { answer: data.answer });
    });
    socket.on('end call', (data) => {
        const target = activeCalls[data.to];
        if (target) io.to(target).emit('call ended');
    });
    socket.on('ice candidate', (data) => {
        const target = activeCalls[data.to];
        if (target) io.to(target).emit('ice candidate', { candidate: data.candidate });
    });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});