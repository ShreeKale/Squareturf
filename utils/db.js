const dns = require('dns');
const mongoose = require('mongoose');

/* Some networks cannot reach MongoDB over IPv6, so try IPv4 first */
try { dns.setDefaultResultOrder('ipv4first'); } catch (_) { /* older Node */ }

let connecting = null;

/* Turns a MongoDB error into a plain-English fix. Never includes the password. */
function explain(error) {
  const text = `${error.name || ''} ${error.code || ''} ${error.message || ''}`;

  if (/MONGO_URI is not set/i.test(text)) {
    return 'MONGO_URI is missing. Add it in your hosting environment variables (Vercel: Project, Settings, Environment Variables) or in .env on your computer.';
  }
  if (/bad auth|authentication failed|AuthenticationFailed/i.test(text)) {
    return 'The database username or password in MONGO_URI is wrong. If the password has special characters such as @ : / ? # %, replace each with its %-code (for example @ becomes %40).';
  }
  if (/Invalid scheme|Invalid connection string|URI malformed|must be escaped/i.test(text)) {
    return 'MONGO_URI is not a valid connection string. It should look like mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/squareturf?retryWrites=true&w=majority';
  }
  if (/querySrv|ENOTFOUND|EREFUSED|ESERVFAIL/i.test(text)) {
    return 'The database address could not be found. Check the cluster host name in MONGO_URI and your internet connection. If it only fails on your computer, use the "standard connection string" (mongodb://...) from Atlas instead of mongodb+srv://.';
  }
  if (/ReplicaSetNoPrimary|Server selection timed out|MongooseServerSelectionError|ETIMEDOUT|ECONNREFUSED/i.test(text)) {
    return 'The database did not answer. In MongoDB Atlas open Network Access and allow 0.0.0.0/0 (Vercel servers have no fixed IP address), and make sure the cluster is not paused.';
  }
  return 'Could not connect to the database. See the server log for details.';
}

/*
 * One shared MongoDB connection. On Vercel every request may land on a warm or a cold
 * function, so the connection is made once per instance and then reused.
 */
function connectDb() {
  if (mongoose.connection.readyState === 1) return Promise.resolve(mongoose);
  if (connecting) return connecting;

  const uri = process.env.MONGO_URI || (process.env.NODE_ENV === 'production' ? '' : 'mongodb://127.0.0.1:27017/squareturf');

  if (!uri) {
    const error = new Error('MONGO_URI is not set.');
    error.hint = explain(error);
    console.error(`[db] ${error.hint}`);
    return Promise.reject(error);
  }

  connecting = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      maxPoolSize: 5,
      family: 4
    })
    .then(() => {
      console.log('[db] MongoDB connected');
      return mongoose;
    })
    .catch((error) => {
      connecting = null; // try again on the next request
      error.hint = explain(error);
      console.error(`[db] ${error.hint}\n[db] Details: ${error.message}`);
      throw error;
    });

  return connecting;
}

module.exports = { connectDb, explain };