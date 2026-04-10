const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true }
});

const userSchema = new mongoose.Schema({
  userId: { type: Number, sparse: true, unique: true },
  username: { type: String, unique: true },
  role: { type: String, default: null }
});

const notificationSchema = new mongoose.Schema({
  id: { type: Number, required: true, unique: true },
  cronTime: { type: String, required: true },
  originalTime: { type: String, required: true },
  message: { type: String, required: true },
  chatId: { type: Number, required: true },
  topicId: { type: Number, default: null }
});

const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});

const Role = mongoose.model('Role', roleSchema);
const User = mongoose.model('User', userSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const Config = mongoose.model('Config', configSchema);

module.exports = { Role, User, Notification, Config };
