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
    username: { type: String, unique: true, required: true }, // Логин (уникальный)
    displayName: { type: String, required: true }, // Отображаемое имя (любое)
    password: String,
    status: { type: String, default: "Пользователь чата" },
    bio: { type: String, default: "" },
    avatar: { type: String, default: null },
    profileStyle: { type: String, default: "classic" },
    lastSeen: { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const MessageSchema = new mongoose.Schema({
    id: String, user: String, userDisplayName: String, message: String, room: String, avatar: String,
    isMedia: Boolean, mediaUrl: String, mediaType: String, reactions: { type: Object, default: {} }, replyTo: String, replyText: String, replyUser: String,
    createdAt: { type: Date, default: Date.now },
    edited: { type: Boolean, default: false }
});
const Message = mongoose.model('Message', MessageSchema);

const GroupSchema = new mongoose.Schema({
    id: { type: String, unique: true }, name: String, members: [String], lastMessage: { type: String, default: "" }
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
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data);
        });
    } else if (req.url === '/manifest.json') {
        fs.readFile('manifest.json', (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'application/manifest+json' }); res.end(data);
        });
    } else if (req.url === '/sw.js') {
        fs.readFile('sw.js', (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(data);
        });
    } else if (req.url === '/cadelylogo.jpg') {
        fs.readFile('cadelylogo.jpg', (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(data);
        });
    } else if (req.url === '/upload-media' && req.method === 'POST') {
        upload(req, res, (err) => {
            if (err) { res.writeHead(500); res.end(JSON.stringify({ error: err.message })); return; }
            if (!req.file) { res.writeHead(400); res.end('Файл не получен'); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ path: '/uploads/' + req.file.filename, type: req.file.mimetype }));
        });
    } else if (req.url === '/upload-avatar' && req.method === 'POST') {
        const avatarUpload = multer({ storage: storage }).single('avatar');
        avatarUpload(req, res, (err) => {
            if (err) { res.writeHead(500); res.end('Ошибка загрузки'); return; }
            if (!req.file) { res.writeHead(400); res.end('Файл не получен'); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ path: '/uploads/' + req.file.filename }));
        });
    } else if (req.url.startsWith('/uploads/')) {
        const filePath = path.join(__dirname, req.url);
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.webm': 'audio/webm', '.mp3': 'audio/mp3' };
            res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' }); res.end(data);
        });
    } else { res.writeHead(404); res.end('Страница не найдена'); }
});

const io = new Server(server);
let onlineUsers = new Set();
const activeCalls = {}; 

io.on('connection', (socket) => {
    let currentUser = null; // Здесь хранится username
    let lastMessageTime = 0;

    socket.on('register', async (data) => {
        try {
            const { username, password, displayName } = data;
            if (await User.findOne({ username })) return socket.emit('auth error', 'Этот юзернейм уже занят!');
            const newUser = new User({ 
                username, 
                displayName: displayName || username, 
                password: bcrypt.hashSync(password, 10), 
                lastSeen: new Date() 
            });
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
                user.lastSeen = new Date(); await user.save();
                io.emit('online status', Array.from(onlineUsers));
                socket.emit('auth success', username);
                const rooms = new Set(['general']);
                const groups = await Group.find({ members: username });
                groups.forEach(g => rooms.add(g.id));
                socket.emit('room list', Array.from(rooms));
            } else socket.emit('auth error', 'Неверный пароль!');
        } catch (e) { socket.emit('auth error', 'Ошибка входа'); }
    });

    socket.on('disconnect', async () => {
        if (currentUser) {
            onlineUsers.delete(currentUser);
            delete activeCalls[currentUser];
            await User.updateOne({ username: currentUser }, { lastSeen: new Date() });
            io.emit('online status', Array.from(onlineUsers));
        }
    });

    socket.on('get rooms', async (username) => {
        const rooms = new Set(['general']);
        const groups = await Group.find({ members: username });
        groups.forEach(g => rooms.add(g.id));
        socket.emit('room list', Array.from(rooms));
    });

    socket.on('get all users', async () => {
        const users = await User.find({}, 'username displayName avatar');
        socket.emit('all users list', users);
    });

    socket.on('get profile', async (username) => {
        const user = await User.findOne({ username });
        if (!user) return socket.emit('profile error', 'Пользователь не найден');
        socket.emit('profile data', { 
            username: user.username, displayName: user.displayName, status: user.status, bio: user.bio, avatar: user.avatar, 
            profileStyle: user.profileStyle, lastSeen: user.lastSeen, isOnline: onlineUsers.has(username)
        });
    });

    socket.on('update profile', async (data) => {
        const { oldUsername, newUsername, displayName, status, bio, avatar, profileStyle } = data;
        // newUsername - это логин, он должен быть уникальным. Если юзер меняет логин, проверяем.
        if (newUsername !== oldUsername && await User.findOne({ username: newUsername })) return socket.emit('profile error', 'Юзернейм занят!');
        
        await User.updateOne({ username: oldUsername }, { username: newUsername, displayName, status, bio, avatar, profileStyle });
        
        if (newUsername !== oldUsername) {
            await Message.updateMany({ user: oldUsername }, { user: newUsername });
            await Message.updateMany({ replyUser: oldUsername }, { replyUser: newUsername });
            const allMsgs = await Message.find({});
            for (let m of allMsgs) {
                let changed = false;
                if (m.reactions) { for (let emoji in m.reactions) { const idx = m.reactions[emoji].indexOf(oldUsername); if (idx !== -1) { m.reactions[emoji][idx] = newUsername; changed = true; } } }
                if (changed) await m.save();
            }
            await Group.updateMany({ members: oldUsername }, { $set: { "members.$": newUsername } });
            if (onlineUsers.has(oldUsername)) { onlineUsers.delete(oldUsername); onlineUsers.add(newUsername); io.emit('online status', Array.from(onlineUsers)); }
            if (activeCalls[oldUsername]) { activeCalls[newUsername] = activeCalls[oldUsername]; delete activeCalls[oldUsername]; }
            currentUser = newUsername;
        }
        socket.emit('profile updated', newUsername);
    });

    // Поиск теперь строго по username
    socket.on('check user', async (username) => {
        const user = await User.findOne({ username });
        if (!user) socket.emit('user not found', username); else socket.emit('user found', username);
    });

    socket.on('create private chat', async (data) => {
        const roomId = [data.user, data.friend].sort().join('_');
        if (!await Group.findOne({ id: roomId })) {
            await new Group({ id: roomId, name: 'ЛС', members: [data.user, data.friend] }).save();
            io.emit('update room list');
        }
        socket.emit('private chat created', roomId);
    });

    socket.on('create group', async (data) => {
        const roomId = 'group_' + Date.now();
        await new Group({ id: roomId, name: data.groupName, members: data.members }).save();
        io.emit('update room list'); 
    });

    socket.on('leave group', async (roomId) => {
        await Group.updateOne({ id: roomId }, { $pull: { members: currentUser } });
        io.emit('update room list');
    });

    socket.on('join room', async (roomName) => {
        socket.join(roomName);
        const msgs = await Message.find({ room: roomName }).sort({ createdAt: 1 });
        socket.emit('room history', msgs);
    });

    socket.on('get room name', async (roomId) => {
        const group = await Group.findOne({ id: roomId });
        if (group) {
            let name = group.name;
            if (name === 'ЛС') { 
                const targetUser = roomId.split('_').find(p => p !== currentUser);
                const user = await User.findOne({ username: targetUser });
                name = user ? user.displayName : targetUser;
            }
            socket.emit('room name', { roomId, name });
        }
    });

    socket.on('chat message', async (data) => {
        const now = Date.now();
        if (now - lastMessageTime < 1500) return socket.emit('call error', 'Анти-спам 1.5 сек.');
        lastMessageTime = now;

        const user = await User.findOne({ username: data.user });
        let replyText = null, replyUser = null;
        if (data.replyTo) {
            const orig = await Message.findOne({ id: data.replyTo });
            if (orig) { replyUser = orig.user; replyText = orig.message || (orig.isMedia ? 'Медиафайл' : ''); }
        }
        const msg = new Message({ 
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9), 
            user: data.user, 
            userDisplayName: user ? user.displayName : data.user,
            message: data.message, 
            room: data.room, 
            avatar: user ? user.avatar : null, 
            isMedia: false, 
            replyTo: data.replyTo || null, 
            replyText, 
            replyUser 
        });
        await msg.save();
        
        if (data.room.startsWith('group_')) {
            await Group.updateOne({ id: data.room }, { lastMessage: data.message });
        }
        io.to(data.room).emit('chat message', msg);
    });

    socket.on('send media', async (data) => {
        const user = await User.findOne({ username: data.user });
        let replyText = null, replyUser = null;
        if (data.replyTo) {
            const orig = await Message.findOne({ id: data.replyTo });
            if (orig) { replyUser = orig.user; replyText = orig.message || (orig.isMedia ? 'Медиафайл' : ''); }
        }
        const msg = new Message({ 
            id: Date.now() + '-' + Math.random().toString(36).substr(2, 9), 
            user: data.user, 
            userDisplayName: user ? user.displayName : data.user,
            message: data.caption || '', 
            room: data.room, 
            avatar: user ? user.avatar : null, 
            isMedia: true, 
            mediaUrl: data.url, 
            mediaType: data.type, 
            replyTo: data.replyTo || null, 
            replyText, 
            replyUser 
        });
        await msg.save();
        io.to(data.room).emit('chat message', msg);
    });

    socket.on('delete message', async (data) => {
        const msg = await Message.findOne({ id: data.messageId });
        if (msg) { await Message.deleteOne({ id: data.messageId }); io.to(msg.room).emit('message deleted', { messageId: data.messageId, room: msg.room }); }
    });

    socket.on('edit message', async (data) => {
        const msg = await Message.findOne({ id: data.messageId });
        if (msg && msg.user === currentUser) {
            msg.message = data.newText; msg.edited = true; await msg.save();
            io.to(msg.room).emit('message edited', { messageId: msg.id, newText: data.newText });
        }
    });

    socket.on('add reaction', async (data) => {
        const msg = await Message.findOne({ id: data.messageId });
        if (msg) {
            let reactions = msg.reactions || {};
            if (!reactions[data.emoji]) reactions[data.emoji] = [];
            const idx = reactions[data.emoji].indexOf(currentUser);
            if (idx === -1) reactions[data.emoji].push(currentUser);
            else { reactions[data.emoji].splice(idx, 1); if (reactions[data.emoji].length === 0) delete reactions[data.emoji]; }
            msg.reactions = reactions; await msg.save();
            io.to(msg.room).emit('update reaction', { messageId: msg.id, reactions: reactions });
        }
    });

    socket.on('typing', (data) => socket.to(data.room).emit('user typing', data.user));
    socket.on('stop typing', (data) => socket.to(data.room).emit('user stop typing', data.user));

    // --- ЗВОНКИ ---
    socket.on('call user', (data) => { const t = activeCalls[data.to]; if (t) io.to(t).emit('incoming call', { from: data.from, offer: data.offer }); else socket.emit('call error', 'Пользователь не в сети'); });
    socket.on('answer call', (data) => { const t = activeCalls[data.to]; if (t) io.to(t).emit('call answered', { answer: data.answer }); });
    socket.on('end call', (data) => { const t = activeCalls[data.to]; if (t) io.to(t).emit('call ended'); });
    socket.on('ice candidate', (data) => { const t = activeCalls[data.to]; if (t) io.to(t).emit('ice candidate', { candidate: data.candidate }); });
});

const PORT = process.env.PORT || 8000;
server.listen(PORT, '0.0.0.0', () => { console.log(`Сервер запущен на порту ${PORT}`); });