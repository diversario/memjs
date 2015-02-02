'use strict'

var header = require('./header');

var TYPE_JSON = exports.TYPE_JSON = 3
  , TYPE_BINARY = exports.TYPE_BINARY = 1
  , TYPE_NUMBER = exports.TYPE_NUMBER = 2

var bufferify = function(val) {
  return Buffer.isBuffer(val) ? val : new Buffer(val);
}

function getValueType(value) {
  if (typeof value == 'number') {
    return TYPE_NUMBER
  }

  if (typeof value == 'string' || Buffer.isBuffer(value)) {
    return TYPE_BINARY
  }

  return TYPE_JSON
}

function getSerializedValue(val) {
  switch (getValueType(val)) {
    case TYPE_NUMBER:
      return val.toString()
    case TYPE_JSON:
      return JSON.stringify(val)
    default:
      return val
  }
}

function getParsedValue(_val, type) {
  switch (type) {
    case TYPE_BINARY:
      return _val.toString()
    case TYPE_NUMBER:
      return parseFloat(_val)
    case TYPE_JSON:
      return JSON.parse(_val)
    default:
      return _val
  }
}

exports.makeRequestBuffer = function(opcode, key, extras, _value, seq) {
  var value = bufferify(getSerializedValue(_value));

  key = bufferify(key);
  extras = bufferify(extras);

  // only set flags for SET, ADD, REPLACE, INCREMENT
  if (opcode >= 1 && opcode <= 3 || opcode == 5) {
    var value_type = getValueType(_value)
    extras.writeUInt32BE(value_type, 0)
  }

  var buf = new Buffer(24 + key.length + extras.length + value.length);

  buf.fill();

  var requestHeader = {
    magic: 0x80,
    opcode: opcode,
    keyLength: key.length,
    extrasLength: extras.length,
    totalBodyLength: key.length + value.length + extras.length,
    opaque: seq
  };

  header.toBuffer(requestHeader).copy(buf);
  extras.copy(buf, 24)
  key.copy(buf, 24 + extras.length);
  value.copy(buf, 24 + extras.length + key.length);

  return buf;
}

exports.makeAmountInitialAndExpiration = function(amount, amountIfEmpty, expiration) {
  var buf = new Buffer(20);
  buf.writeUInt32BE(0, 0);
  buf.writeUInt32BE(amount, 4);
  buf.writeUInt32BE(0, 8);
  buf.writeUInt32BE(amountIfEmpty, 12);
  buf.writeUInt32BE(expiration, 16);
  return buf
}

exports.makeExpiration = function(expiration) {
  var buf = new Buffer(4);
  buf.writeUInt32BE(expiration, 0);
  return buf
}

exports.hashCode = function(str) {
  for(var ret = 0, i = 0, len = str.length; i < len; i++) {
    ret = (31 * ret + str.charCodeAt(i)) << 0;
  }
  return Math.abs(ret);
};

exports.parseMessage = function(dataBuf) {
  if (dataBuf.length < 24) {
    return false;
  }
  var responseHeader = header.fromBuffer(dataBuf);
  if (dataBuf.length < responseHeader.totalBodyLength + 24 || responseHeader.totalBodyLength < responseHeader.keyLength + responseHeader.extrasLength) {
    return false;
  }

  var pointer = 24;
  var extras = dataBuf.slice(pointer, (pointer += responseHeader.extrasLength));
  var key = dataBuf.slice(pointer, (pointer += responseHeader.keyLength));
  var val = dataBuf.slice(pointer, 24 + responseHeader.totalBodyLength);

  var data_type = extras.length && extras.readUInt32BE(0)

  return {
    header: responseHeader,
    key: key,
    extras: extras,
    val: getParsedValue(val, data_type)
  };
}

exports.merge = function(original, deflt) {
  var originalValue

  for (var attr in deflt) {
    originalValue = original[attr]

    if (typeof(originalValue) == 'undefined' || originalValue == null)
      original[attr] = deflt[attr];
  }
  return original;
}

if(!Buffer.concat) {
  Buffer.concat = function(list, length) {
    if (!Array.isArray(list)) {
      throw new Error('Usage: Buffer.concat(list, [length])');
    }

    if (list.length === 0) {
      return new Buffer(0);
    } else if (list.length === 1) {
      return list[0];
    }

    if (typeof length !== 'number') {
      length = 0;
      for (var i = 0; i < list.length; i++) {
        var buf = list[i];
        length += buf.length;
      }
    }

    var buffer = new Buffer(length);
    var pos = 0;
    for (var i = 0; i < list.length; i++) {
      var buf = list[i];
      buf.copy(buffer, pos);
      pos += buf.length;
    }
    return buffer;
  };
}
