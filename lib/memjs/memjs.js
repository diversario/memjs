// # MemJS Memcache Client

var errors = require('./protocol').errors;
var Server = require('./server').Server;
var makeRequestBuffer = require('./utils').makeRequestBuffer;
var hashCode = require('./utils').hashCode;
var merge = require('./utils').merge;
var makeExpiration = require('./utils').makeExpiration;
var makeAmountInitialAndExpiration = require('./utils').makeAmountInitialAndExpiration;

// Client initializer takes a list of `Server`s and an `options` dictionary.
// See `Client.create` for details.
var Client = function(servers, options) {
  this.servers = servers;
  this.seq = 0;
  this.options = merge(
      options || {},
      {
        failoverTime: 60,
        retries: 2,
        expires: 0,
        logger: console,
        keyspace: null
      }
  );
}

// Creates a new client given an optional config string and optional hash of
// options. The config string should be of the form:
//
//     "[user:pass@]server1[:11211],[user:pass@]server2[:11211],..."
//
// If the argument is not given, fallback on the `MEMCACHIER_SERVERS` environment
// variable, `MEMCACHE_SERVERS` environment variable or `"localhost:11211"`.
//
// The options hash may contain the options:
//
// * `retries` - the number of times to retry an operation in lieu of failures
// (default 2)
// * `expires` - the default expiration in seconds to use (default 0 - never
// expire). If `expires` is greater than 30 days (60 x 60 x 24 x 30), it is
// treated as a UNIX time (number of seconds since January 1, 1970).
// * `logger` - a logger object that responds to
// * `failover` - whether to failover to next server. Defaults to false.
// * `failoverTime` - how much to wait until retring a failed server. Default
//                    is 60 seconds.
//   
//   ~~~~
//     log(msg1[, msg2[, msg3[...]]])
//   ~~~~
//
//   Defaults to `console`.
//
// Or options for the servers including:
// * `username` and `password` for fallback SASL authentication credentials.
// * `timeout` in seconds to determine failure for operations
Client.create = function(serversStr, options) {
  serversStr = serversStr || process.env.MEMCACHIER_SERVERS
                          || process.env.MEMCACHE_SERVERS || "localhost:11211";
  var serverUris = serversStr.split(",");
  var servers = serverUris.map(function(uri) {
    var uriParts = uri.split("@");
    var hostPort = uriParts[uriParts.length - 1].split(":");
    var userPass = (uriParts[uriParts.length - 2] || "").split(":");
    return new Server(hostPort[0], parseInt(hostPort[1] || 11211), userPass[0], userPass[1], options);
  });
  return new Client(servers, options);
}

Client.prototype._getFullKeyName = function (key) {
  if (this.options.keyspace) return this.options.keyspace + key
  return key
}

// Chooses the server to talk to by hashing the given key.
// TODO(alevy): should use consistent hashing and/or allow swapping hashing
// mechanisms
Client.prototype.server = function(key) {
  var origIdx = hashCode(key) % this.servers.length;
  var idx = origIdx;
  var serv = this.servers[idx];
  while (serv.wakeupAt && serv.wakeupAt > Date.now()) {
    idx = (idx + 1) % this.servers.length;
    if (idx == origIdx) {
      return null;
    }
    serv = this.servers[idx];
  }
  return serv;
}

// ## Memcache Commands
//
// All commands return their results through a callback passed as the last
// required argument (some commands, like `Client#set`, take optional arguments
// after the callback).
//
// The callback signature always follows:
//
//     callback(err, [arg1[, arg2[, arg3[...]]]])
//
// In case of an error the _err_ argument will be non-null and contain the
// `Error`. A notable exception includes a `Client#get` on a key that doesn't
// exist. In this case, _err_ will be null, as will the _value and _extras_
// arguments.

// GET
//
// Fetches the value at the given key with callback signature:
//
//     callback(err, value, flags)
//
// _value_ and _flags_ are both `Buffer`s.
// If the key is not found, the callback is invoked
// with null for both arguments and no error.
Client.prototype.get = function(key, callback) {
  this.seq++;

  var logger = this.options.logger;

  key = this._getFullKeyName(key)

  logger.trace({
    key: key,
    op: 'GET'
  }, 'Preparing GET request')

  var request = makeRequestBuffer(0, key, '', '', this.seq);

  this.perform(key, request, function(err, response) {
    if (err) {
      logger.error(err, 'Failed to GET key %s', key)
      callback && callback(err, null, null);
      return;
    }

    logger.trace({key: key, response: response, op: 'GET'}, 'GET response')

    switch (response.header.status) {
    case  0:
      callback && callback(null, response.val, response.extras)
      break;
    case 1:
      callback && callback(null, null, null);
      break;
    default:
      var errorMessage = 'Failed to GET a key "' + key + '". Error: ' + errors[response.header.status];
      logger.error({op: 'GET', key: key, status: errors[response.header.status]}, errorMessage);
      callback && callback(new Error(errorMessage), null, null);
    }
  });
}

// SET
//
// Sets the given _key_ and _value_ in memcache. The _expires_ argument (passed
// in last, after the callback) overrides the default expiration (see
// `Client.create`). The callback signature is:
//
//     callback(err, success)
Client.prototype.set = function(key, value, callback, expires) {
  this.seq++;

  var logger = this.options.logger;

  var expiration = expires || this.options.expires

  var extras = Buffer.concat([new Buffer('00000000', 'hex'),
                              makeExpiration(expiration)]);

  key = this._getFullKeyName(key)

  logger.trace({
    key: key,
    value: value,
    requested_expiration: expires,
    effective_expiration: expiration,
    op: 'SET'
  }, 'Preparing SET request')

  var request = makeRequestBuffer(1, key, extras, value, this.seq);

  this.perform(key, request, function(err, response) {
    if (err) {
      logger.error(err, 'Failed to SET key %s', key)
      callback && callback(err, null);
      return;
    }

    logger.trace({key: key, response: response, op: 'SET'}, 'SET response')

    switch (response.header.status) {
    case 0:
      callback && callback(null, true)
      break;
    default:
      var errorMessage = 'Failed to SET a key "' + key + '". Error: ' + errors[response.header.status];
      logger.error({op: 'SET', key: key, status: errors[response.header.status]}, errorMessage);
      callback && callback(new Error(errorMessage), null, null);
    }
  });
}

// ADD
//
// Adds the given _key_ and _value_ to memcache. The operation only succeeds
// if the key is not already set. The _expires_ argument (passed
// in last, after the callback) overrides the default expiration (see
// `Client.create`). The callback signature is:
//
//     callback(err, success)
Client.prototype.add = function(key, value, callback, expires) {
  this.seq++;
  var logger = this.options.logger;
  var expiration = expires || this.options.expires;
  var extras = Buffer.concat([new Buffer('00000000', 'hex'), makeExpiration(expiration)]);

  key = this._getFullKeyName(key)

  logger.trace({
    key: key,
    value: value,
    requested_expiration: expires,
    effective_expiration: expiration,
    op: 'ADD'
  }, 'Preparing ADD request')

  var request = makeRequestBuffer(2, key, extras, value, this.seq);

  this.perform(key, request, function(err, response) {
    if (err) {
      logger.error(err, 'Failed to ADD key %s', key)
      callback && callback(err, null, null);
      return;
    }

    logger.trace({key: key, response: response, op: 'ADD'}, 'ADD response')

    switch (response.header.status) {
    case 0:
      callback && callback(null, true)
      break;
    case 2:
      callback && callback(null, false);
      break;
    default:
      var errorMessage = 'Failed to ADD a key "' + key + '". Error: ' + errors[response.header.status];
      logger.error({op: 'ADD', key: key, status: errors[response.header.status]}, errorMessage);
      callback && callback(new Error(errorMessage), null, null);
    }
  });
}

// REPLACE
//
// Replaces the given _key_ and _value_ to memcache. The operation only succeeds
// if the key is already present. The _expires_ argument (passed
// in last, after the callback) overrides the default expiration (see
// `Client.create`). The callback signature is:
//
//     callback(err, success)
Client.prototype.replace = function(key, value, callback, expires) {
  this.seq++;
  var logger = this.options.logger;
  var expiration = expires || this.options.expires;
  var extras = Buffer.concat([new Buffer('00000000', 'hex'), makeExpiration(expiration)]);

  key = this._getFullKeyName(key)

  logger.trace({
    key: key,
    value: value,
    requested_expiration: expires,
    effective_expiration: expiration,
    op: 'REPLACE'
  }, 'Preparing REPLACE request')

  var request = makeRequestBuffer(3, key, extras, value, this.seq);

  this.perform(key, request, function(err, response) {
    if (err) {
      logger.error(err, 'Failed to REPLACE key %s', key)
      callback && callback(err, null, null);
      return;
    }

    logger.trace({key: key, response: response, op: 'REPLACE'}, 'REPLACE response')

    switch (response.header.status) {
    case 0:
      callback && callback(null, true)
      break;
    case 1:
      callback && callback(null, false);
      break;
    default:
      var errorMessage = 'Failed to REPLACE a key "' + key + '". Error: ' + errors[response.header.status];
      logger.error({op: 'REPLACE', key: key, status: errors[response.header.status]}, errorMessage);
      callback && callback(new Error(errorMessage), null, null);
    }
  });
}

// DELETE
//
// Deletes the given _key_ from memcache. The operation only succeeds
// if the key is already present. The callback signature is:
//
//     callback(err, success)
Client.prototype.delete = function(key, callback) {
  this.seq++;
  var logger = this.options.logger;
  key = this._getFullKeyName(key)

  logger.trace({
    key: key,
    op: 'DELETE'
  }, 'Preparing DELETE request')

  var request = makeRequestBuffer(4, key, '', '', this.seq);

  this.perform(key, request, function(err, response) {
    if (err) {
      logger.error(err, 'Failed to DELETE key %s', key)
      callback && callback(err, null, null);
      return;
    }
    switch (response.header.status) {
    case  0:
      callback && callback(null, true)
      break;
    case 1:
      callback && callback(null, false);
      break;
    default:
      var errorMessage = 'Failed to DELETE a key "' + key + '". Error: ' + errors[response.header.status];
      logger.error({op: 'DELETE', key: key, status: errors[response.header.status]}, errorMessage);
      callback && callback(new Error(errorMessage), null);
    }
  });
}

// INCREMENT
//
// Increments the given _key_ in memcache. Defaults to `0` if the key is not
// present. The _expires_ argument (passed
// in last, after the callback) overrides the default expiration (see
// `Client.create`). The callback signature is:
//
//     callback(err, success, value)
Client.prototype.increment = function(key, amount, callback, expires) {
  this.seq++;

  var logger = this.options.logger;

  var expiration = expires || this.options.expires;
  var extras = makeAmountInitialAndExpiration(amount, 0, expiration);

  key = this._getFullKeyName(key)

  logger.trace({
    key: key,
    amount: amount,
    requested_expiration: expires,
    effective_expiration: expiration,
    op: 'INCREMENT'
  }, 'Preparing INCREMENT request');

  var request = makeRequestBuffer(5, key, extras, '', this.seq);

  this.perform(key, request, function(err, response) {
    if (err) {
      logger.error(err, 'Failed to INCREMENT key %s', key)
      callback && callback(err, null);
      return;
    }
    switch (response.header.status) {
    case 0:
      var bufInt = (response.val.readUInt32BE(0) << 8) + response.val.readUInt32BE(4);
      callback && callback(null, true, bufInt)
      break;
    default:
      var errorMessage = 'Failed to INCREMENT a key "' + key + '". Error: ' + errors[response.header.status];
      logger.error({op: 'INCREMENT', key: key, status: errors[response.header.status]}, errorMessage);
      callback && callback(new Error(errorMessage), null);
    }
  });
}

// DECREMENT
//
// Decrements the given _key_ in memcache. Defaults to `0` if the key is not
// present. The _expires_ argument (passed
// in last, after the callback) overrides the default expiration (see
// `Client.create`). The callback signature is:
//
//     callback(err, success)
Client.prototype.decrement = function(key, amount, callback, expires) {
  this.seq++;

  var expiration = expires || this.options.expires;
  var extras = makeAmountInitialAndExpiration(amount, 0, expiration);
  var logger = this.options.logger;

  key = this._getFullKeyName(key)

  logger.trace({
    key: key,
    amount: amount,
    requested_expiration: expires,
    effective_expiration: expiration,
    op: 'DECREMENT'
  }, 'Preparing DECREMENT request');

  var request = makeRequestBuffer(6, key, extras, '', this.seq);

  this.perform(key, request, function(err, response) {
    if (err) {
      logger.error(err, 'Failed to DECREMENT key %s', key)
      callback && callback(err, null);
      return;
    }
    switch (response.header.status) {
    case 0:
      callback && callback(null, true)
      break;
    default:
      var errorMessage = 'Failed to DECREMENT a key "' + key + '". Error: ' + errors[response.header.status];
      logger.error({op: 'DECREMENT', key: key, status: errors[response.header.status]}, errorMessage);
      callback && callback(new Error(errorMessage), null);
    }
  });
}

// FLUSH
//
// Flushes the cache on each connected server. The callback signature is:
//
//     callback(lastErr, results)
//
// where _lastErr_ is the last error encountered (or null, in the common case
// of no errors). _results_ is a dictionary mapping `"hostname:port"` to either
// `true` (if the operation was successful), or an error.
Client.prototype.flush = function(callback) {
  this.seq++;
  var request = makeRequestBuffer(0x08, '', '', '', this.seq);
  var count   = this.servers.length;
  var result  = {};
  var lastErr = null;

  var handleFlush = function(seq, serv) {
    serv.onResponse(seq, function(response) {
      count -= 1;
      result[serv.host + ":" + serv.port] = true;
      if (callback && count == 0) {
        callback(lastErr, result);
      }
    });
    serv.onError(seq, function(err) {
      count -= 1;
      lastErr = err;
      result[serv.host + ":" + serv.port] = err;
      if (callback && count == 0) {
        callback(lastErr, result);
      }
    });
    serv.write(request);
  }

  for (var i in this.servers) {
    handleFlush(this.seq, this.servers[i]);
  }
}

// STATS
//
// Fetches memcache stats from each connected server. The callback is invoked 
// **ONCE PER SERVER** and has the signature:
//
//     callback(err, server, stats)
//
// _server_ is the `"hostname:port"` of the server, and _stats_ is a
// dictionary mapping the stat name to the value of the statistic as a string.
Client.prototype.stats = function(callback) {
  this.seq++;
  var request = makeRequestBuffer(0x10, '', '', '', this.seq);
  var logger = this.options.logger;

  var handleStats = function(seq, serv) {
    var result = {};
    var handle = function(response) {
      // end of stat responses
      if (response.header.totalBodyLength == 0) {
        callback && callback(null, serv.host + ":" + serv.port, result);
        return;
      }
      // process single stat line response
      switch (response.header.status) {
      case  0:
        result[response.key.toString()] = response.val.toString();
        break;
      default:
        var errorMessage = 'Failed STATS. Error: ' + errors[response.header.status];
        logger.error(errorMessage);
        callback && callback(new Error(errorMessage), serv.host + ":" + serv.port, null);
      }
    };
    handle.quiet = true;

    serv.onResponse(seq, handle);
    serv.onError(seq, function(err) {
      callback && callback(err, serv.host + ":" + serv.port, null);
    });
    serv.write(request);
  }

  for (var i in this.servers) {
    handleStats(this.seq, this.servers[i]);
  }
}

// QUIT
//
// Closes the connection to each server, notifying them of this intention.
Client.prototype.quit = function() {
  this.seq++;
  // TODO: Nicer perhaps to do QUITQ (0x17) but need a new callback for when
  // write is done.
  var request = makeRequestBuffer(0x07, '', '', '', this.seq); // QUIT

  var handleQuit = function(seq, serv) {
    serv.onResponse(seq, function(response) {
      serv.close();
    });
    serv.onError(seq, function(err) {
      serv.close();
    });
    serv.write(request);
  }

  for (var i in this.servers) {
    var serv = this.servers[i];
    handleQuit(this.seq, serv);
  }
}

// CLOSE
//
// Closes (abruptly) connections to all the servers.
Client.prototype.close = function() {
  for (var i in this.servers) {
    this.servers[i].close();
  }
}

// Perform a generic single response operation (get, set etc) on a server
// serv: the server to perform the operation on
// request: a buffer containing the request
// callback
Client.prototype.perform = function(key, request, callback, retries) {
  var self = this;
  var seq = this.seq;
  var serv = this.server(key);
  if (!serv) {
    callback && callback(new Error("No servers available"), null);
    return;
  }

  retries = retries || this.options.retries;
  var failover = this.options.failover;
  var failoverTime = this.options.failoverTime;
  var origRetries = retries;
  var logger = this.options.logger;

  var responseHandler = function(response) {
    callback && callback(null, response);
  };

  var errorHandler = function(error) {
    if (--retries > 0) {
      serv.onResponse(seq, responseHandler);
      serv.onError(seq, errorHandler);
      serv.write(request);
    } else {
      logger.error({
        error: error,
        key: key,
        host: serv.host,
        port: serv.port,
        retries: origRetries
      }, 'Request to memcached server failed')

      if (failover) {
        serv.wakeupAt = Date.now() + failoverTime * 1000;
        logger.info({key: key, retry_at: serv.wakeupAt}, 'Operation will retry')
        self.perform(key, request, callback, origRetries);
      } else {
        callback && callback(error, null);
      }
    }
  };

  serv.onResponse(seq, responseHandler);
  serv.onError(seq, errorHandler);
  serv.write(request);
}

exports.Client = Client;
exports.Server = Server;
exports.Utils = require('./utils');
exports.Header = require('./header');

