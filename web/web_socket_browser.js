/* globals WebSocket */
/*
  This and WebSocketServer.js provide nearly identical functionality, but because the browser and
  node environments are slightly different there are two versions. See there for doc
*/
'use strict';
const _ = require('underscore');
const web_socket_helper = require('web_socket_helper');

let verbose = 1;

exports.mkWebSocketClientRpc = mkWebSocketClientRpc;


function mkWebSocketClientRpc(wscUrl, handlers) {
  let txQueue = [];
  let pending = new web_socket_helper.RpcPendingQueue();
  let callbacks = {};
  let rxBinaries = [];
  let shutdownRequested = false;
  let interactivePending = null;
  let reopenBackoff = 1000; // milliseconds

  let wsc = null;

  setupWsc();
  setupHandlers();
  return handlers;

  function setupWsc() {
    wsc = new WebSocket(wscUrl);
    wsc.binaryType = 'arraybuffer';

    wsc.onmessage = function(event) {
      if (event.data.constructor === ArrayBuffer) {
        if (verbose >= 3) console.log(wsc.url + ' > binary length=', event.data.byteLength);
        rxBinaries.push(event.data);
      } else {
        let msg = web_socket_helper.parse(event.data, rxBinaries);
        rxBinaries = [];
        if (verbose >= 2) console.log(wscUrl + ' >', msg);
        handleMsg(msg);
      }
    };
    wsc.onopen = function(event) {
      if (verbose >= 2) console.log(wscUrl + ' Opened');
      if (txQueue) {
        _.each(txQueue, function(m) {
          emitMsg(m);
        });
        txQueue = null;
      }
      if (handlers.start) handlers.start();
      reopenBackoff = 1000;
    };
    wsc.onclose = function(event) {
      if (handlers.close) {
        handlers.close();
      }

      if (verbose >= 2) console.log(wscUrl + ' Closed');
      txQueue = [];
      if (!shutdownRequested) {
        if (handlers.reopen) {
          handlers.reopen();
        } else {
          setTimeout(function() {
            if (verbose >= 1) console.log('Reopening socket to ' + wscUrl);
            setupWsc();
          }, reopenBackoff);
          reopenBackoff = Math.min(5000, reopenBackoff*2);
        }
      }
    };
  }

  function handleMsg(msg) {
    if (msg.method) {
      let f = handlers['rpc_' + msg.method];
      if (!f) {
        if (verbose >= 1) console.log(wscUrl, 'Unknown method', msg.method);
        return;
      }
      let done = false;
      try {
        f.apply(handlers, msg.params.concat([function(error /* ... */) {
          let result = Array.prototype.slice.call(arguments, 1);
          if (!web_socket_helper.isRpcProgressError(error)) {
            done = true;
          }
          handlers.tx({ id: msg.id, error: error, result: result });
        }]));
      } catch(ex) {
        if (!done) {
          done = true;
          handlers.tx({ id: msg.id, error: ex.toString() });
        }
      }
    }
    else if (msg.id) {
      let result = msg.result || [];
      let cb;
      if (web_socket_helper.isRpcProgressError(msg.error)) {
        cb = pending.getPreserve(msg.id);
      } else {
        cb = pending.get(msg.id);
      }
      if (!cb) {
        if (verbose >= 1) console.log(wscUrl, 'Unknown response', msg.id);
        return;
      }
      if (verbose >= 2) console.log('id=', msg.id, 'result=', result);
      cb.apply(handlers, [msg.error].concat(msg.result));

      if (interactivePending && pending.pendingCount < 3) {
        let tip = interactivePending;
        interactivePending = null;
        handlers.rpc.apply(handlers, [tip.method].concat(tip.params, [tip.cb]));
      }
    }

    else {
      if (verbose >= 1) console.log(wscUrl, 'Unknown message', msg);
    }
  }

  function setupHandlers() {
    handlers.rpc = function(method /* ... */) {
      let id = pending.getNewId();
      let params = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
      let cb = arguments[arguments.length - 1];
      if (verbose >= 2) console.log('method=', method, 'params=', params);

      pending.add(id, cb);
      handlers.tx({method: method, id: id, params: params});
    };
    handlers.interactiveRpc = function(method /* ... */) {
      if (pending.pendingCount < 3) {
        return handlers.rpc.apply(handlers, arguments);
      }
      let cb = arguments[arguments.length - 1];
      let params = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
      // overwrite any previous one
      interactivePending = {method: method, params: params, cb: cb};
    };
    handlers.tx = function(msg) {
      if (txQueue) {
        txQueue.push(msg);
      } else {
        emitMsg(msg);
      }
    };
    handlers.shutdown = function() {
      shutdownRequested = true;
      console.log('Closing websocket to', wscUrl);
      wsc.close();
      wsc = null;
    };
    handlers.pending = pending;
    handlers.getPendingCount = function() {
      return pending.pendingCount;
    };
  }

  function emitMsg(msg) {
    // Consider async.queue to limit concurrency here if it's a problem
    let binaries = [];
    let json = web_socket_helper.stringify(msg, binaries);
    _.each(binaries, function(data) {
      wsc.send(data);
      if (verbose >= 3) console.log(wscUrl + ' < binary length=', data.byteLength);
    });
    if (verbose >= 2) console.log(wscUrl + ' <', json);
    wsc.send(json);
  }

}