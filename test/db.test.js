const { test } = require('node:test');
const assert = require('node:assert/strict');
const { connectionOptions } = require('../src/config/db');

const env = { MONGO_ROOT_USERNAME: 'comfy', MONGO_ROOT_PASSWORD: 'p@ss:w/rd?#%&!', MONGODB_DB_NAME: 'comfy_notifier' };

test('credentials go to driver options, untouched, when the URI has none', () => {
  const options = connectionOptions('mongodb://mongo:27017/', env);
  assert.deepEqual(options.auth, { username: 'comfy', password: 'p@ss:w/rd?#%&!' });
  assert.equal(options.authSource, 'admin');
  assert.equal(options.dbName, 'comfy_notifier');
  assert.equal(options.autoIndex, false);
});

test('a URI that already has credentials is used as is', () => {
  for (const uri of ['mongodb://comfy:abc123@127.0.0.1:27017/?authSource=admin', 'mongodb+srv://u:p@cluster.example.net/']) {
    const options = connectionOptions(uri, env);
    assert.equal(options.auth, undefined, uri);
    assert.equal(options.authSource, undefined, uri);
  }
});

test('no credentials configured: connect without auth', () => {
  const options = connectionOptions('mongodb://127.0.0.1:27017/', {});
  assert.equal(options.auth, undefined);
  assert.equal(options.dbName, 'comfy_notifier');
});
