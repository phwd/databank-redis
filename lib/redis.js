// redis.js
//
// implementation of Databank interface using redis
//
// Copyright 2011-2013 E14N https://e14n.com/
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var databank = require('databank'),
    redis = require('redis'),
    Databank = databank.Databank,
    DatabankError = databank.DatabankError,
    AlreadyExistsError = databank.AlreadyExistsError,
    NoSuchThingError = databank.NoSuchThingError,
    NotConnectedError = databank.NotConnectedError,
    AlreadyConnectedError = databank.AlreadyConnectedError;

// Main databank class for redis

var RedisDatabank = function(params) {

    // Private members and methods

    var bank = this,
        client,
        host     = params.host || '127.0.0.1',
        port     = params.port || 6379,
        database = params.database || 0,
        toKey = function(type, id) {
            return type + ':' + id;
        },
        indexKey = function(type, prop, val) {
            return 'databank:index:' + type + ':' + prop + ':' + val;
        },
        index = function(type, id, obj, callback) {
            if (!bank.schema ||
                !bank.schema[type] ||
                !bank.schema[type].indices ||
                bank.schema[type].indices.length === 0) {
                callback(null);
                return;
            }

            var indices = bank.schema[type].indices,
                key = toKey(type, id),
                updated = 0,
                i = 0,
                hadErr = false,
                addToIndex = function(prop, callback) {
                    var val = Databank.deepProperty(obj, prop),
                        ikey = indexKey(type, prop, val);
                    
                    client.sadd(ikey, key, function(err, result) {
                        if (err) {
                            callback(err);
                        } else {
                            // Shouldn't have been there before, but we kind of don't care
                            callback(null);
                        }
                    });
                };

            for (i = 0; i < indices.length; i++) {
                addToIndex(indices[i], function(err) {
                    if (err) {
                        hadErr = true;
                        callback(err);
                    } else if (!hadErr) {
                        updated++;
                        if (updated === indices.length) {
                            callback(null);
                        }
                    }
                });
            }
        },
        deindex = function(type, id, callback) {

            if (!bank.schema ||
                !bank.schema[type] ||
                !bank.schema[type].indices ||
                bank.schema[type].indices.length === 0) {
                callback(null);
                return;
            }

            // We have to do an extra read here. :(
            // FIXME: have a path to pass down the "old object" if we've already read it
            bank.read(type, id, function(err, obj) {
                var indices = bank.schema[type].indices,
                    key = toKey(type, id),
                    updated = 0,
                    i = 0,
                    hadErr = false,
                    delFromIndex = function(prop, callback) {
                        var val = Databank.deepProperty(obj, prop),
                            ikey = indexKey(type, prop, val);
                        
                        client.srem(ikey, key, function(err, result) {
                            if (err) {
                                callback(err);
                            } else {
                                // Shouldn't have been there before, but we kind of don't care
                                callback(null);
                            }
                        });
                    };

                if (err) {
                    callback(err);
                } else {
                    for (i = 0; i < indices.length; i++) {
                        delFromIndex(indices[i], function(err) {
                            if (err) {
                                hadErr = true;
                                callback(err);
                            } else if (!hadErr) {
                                updated++;
                                if (updated === indices.length) {
                                    callback(null);
                                }
                            }
                        });
                    }
                }
            });
        };

    // Public members

    bank.schema = params.schema || {},
    
    // Privileged members

    bank.connect = function(params, callback) {

        var onConnectionError = function(err) {
            if (callback) {
                callback(new DatabankError(err));
            }
        };

        if (client) {
            callback(new AlreadyConnectedError());
            return;
        }

        client = redis.createClient(port, host);

        client.on('error', onConnectionError);

        // Whenever we re-connect, make sure to select the right DB

        client.on('connect', function() {
            client.select(database, function(err) {});
        });

        client.once('connect', function() {
            // Only want this once
            client.removeListener('error', onConnectionError);
            if (callback) {
                callback(null);
            }
        });
    };

    bank.disconnect = function(callback) {

        if (!client) {
            callback(new NotConnectedError());
            return;
        }

        client.quit(function(err) {
            if (err) {
                callback(err);
            } else {
                client = null;
                callback(null);
            }
        });
    };

    bank.create = function(type, id, value, callback) {

        if (!client) {
            callback(new NotConnectedError(), null);
            return;
        }

        client.setnx(toKey(type, id), JSON.stringify(value), function(err, result) {
            if (err) {
                callback(new DatabankError(err));
            } else if (result === 0) {
                callback(new AlreadyExistsError(type, id));
            } else {
                index(type, id, value, function(err) {
                    if (err) {
                        callback(err, null);
                    } else {
                        callback(null, value);
                    }
                });
            }
        });
    };

    bank.read = function(type, id, callback) {

        if (!client) {
            callback(new NotConnectedError(), null);
            return;
        }

        client.get(toKey(type, id), function(err, value) {
            if (err) {
                callback(new DatabankError(err), null);
            } else if (value === null) {
                callback(new NoSuchThingError(type, id), null);
            } else {
                callback(null, JSON.parse(value));
            }
        });
    };

    bank.update = function(type, id, value, callback) {

        if (!client) {
            callback(new NotConnectedError(), null);
            return;
        }

        deindex(type, id, function(err) {
            if (err) {
                callback(err, null);
            } else {
                client.set(toKey(type, id), JSON.stringify(value), function(err) {
                    if (err) {
                        callback(new DatabankError(err), null);
                    } else {
                        index(type, id, value, function(err) {
                            if (err) {
                                callback(err, null);
                            } else {
                                callback(null, value);
                            }
                        });
                    }
                });
            }
        });
    };

    bank.del = function(type, id, callback) {

        if (!client) {
            callback(new NotConnectedError());
            return;
        }

        deindex(type, id, function(err) {
            if (err) {
                callback(err, null);
            } else {
                client.del(toKey(type, id), function(err, count) {
                    if (err) {
                        callback(err);
                    } else if (count === 0) {
                        callback(new NoSuchThingError(type, id));
                    } else {
                        callback(null);
                    }
                });
            }
        });
    };

    bank.readAll = function(type, ids, callback) {

        var keys = [];

        if (!client) {
            callback(new NotConnectedError(), null);
            return;
        }

        keys = ids.map(function(id) { return toKey(type, id); } );

        if (keys.length === 0) {
            callback(null, {});
        } else {
            client.mget(keys, function(err, values) {
                var results = {}, i = 0, key, id, value;
                
                if (err) {
                    callback(new DatabankError(err), null);
                } else {
                    for (i = 0; i < values.length; i++) {
                        key = keys[i];
                        id = ids[i];
                        value = JSON.parse(values[i]);
                        results[id] = value;
                    }
                    callback(null, results);
                }
            });
        }
    };

    bank.search = function(type, criteria, onResult, callback) {
        var indices = [],
            property,
            indexed = {},
            unindexed = {},
            haveIndexed = false,
            indexKeys = [],
            scanKeys = function(keys) {
                var i, cnt = 0, hadErr;
                if (keys.length === 0) {
                    // not an error, just no results
                    callback(null);
                } else {
                    for (i in keys) {
                        client.get(keys[i], function(err, value) {
                            if (err) {
                                hadErr = true;
                                callback(err);
                            } else if (!hadErr) {
                                value = JSON.parse(value);
                                if (bank.matchesCriteria(value, unindexed)) {
                                    onResult(value);
                                }
                                cnt++;
                                if (cnt == keys.length) {
                                    // last one out turn off the lights
                                    callback(null);
                                }
                            }
                        });
                    }
                }
            };

        if (!client) {
            callback(new NotConnectedError(), null);
            return;
        }

        // Determine which criteria, if any, are on an indexed property

        if (bank.schema && bank.schema[type] && bank.schema[type].indices) {
            indices = bank.schema[type].indices;
            for (property in criteria) {
                if (indices.indexOf(property) == -1) {
                    unindexed[property] = criteria[property];
                } else {
                    haveIndexed = true;
                    indexed[property] = criteria[property];
                }
            }
        } else {
            unindexed = criteria;
        }

        // If there are any indexed properties, use set intersection to get candidate keys
        if (haveIndexed) {
            for (property in indexed) {
                indexKeys.push(indexKey(type, property, indexed[property]));
            }
            // intersection of all keys. note: with just one arg, sinter returns all
            // values under that key
            client.sinter(indexKeys, function(err, keys) {
                if (err) {
                    callback(err);
                } else {
                    scanKeys(keys);
                }
            });
        } else {
            // Get every record of a given type
            client.keys(type + ':*', function(err, keys) {
                if (err) {
                    callback(err);
                } else {
                    scanKeys(keys);
                }
            });
        }
    };

    bank.scan = function(type, onResult, callback) {

        var scanKeys = function(keys) {
            var i, cnt = 0, hadErr;
            if (keys.length === 0) {
                // not an error, just no results
                callback(null);
            } else {
                for (i in keys) {
                    client.get(keys[i], function(err, value) {
                        if (err) {
                            hadErr = true;
                            callback(err);
                        } else if (!hadErr) {
                            value = JSON.parse(value);
                            onResult(value);
                            cnt++;
                            if (cnt == keys.length) {
                                // last one out turn off the lights
                                callback(null);
                            }
                        }
                    });
                }
            }
        };

        if (!client) {
            callback(new NotConnectedError(), null);
            return;
        }

        // Get every record of a given type
        client.keys(type + ':*', function(err, keys) {
            if (err) {
                callback(err);
            } else {
                scanKeys(keys);
            }
        });
    };

    bank.incr = function(type, id, callback) {
        if (!client) {
            callback(new NotConnectedError(), null);
            return;
        }
        client.incr(toKey(type, id), callback);
    };

    bank.decr = function(type, id, callback) {
        if (!client) {
            callback(new NotConnectedError(), null);
            return;
        }
        client.decr(toKey(type, id), callback);
    };
};

RedisDatabank.prototype = new Databank();

module.exports = RedisDatabank;
