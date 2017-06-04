var _ = require('underscore');
var async = require('async');
var child_process = require('child_process');
var logio = require('../web/logio');
var WebSocketHelper = require('../web/WebSocketHelper');

exports.ChildJsonPipe = ChildJsonPipe;

var verbose = 1;

function ChildJsonPipe(execName, execArgs, execOptions, commOptions) {
  var m = this;

  if (commOptions.shareMem) {
    // WRITEME: create a SHM or shared mmapped file with the child, for passing large
    // numerical arrays around.
  }
  if (commOptions.sshHost) {
    // WRITEME: rewrite execArgs to ssh to the host
  }
  m.baseName = commOptions.baseName || execName;
  m.verbose = commOptions.verbose || 0;
  var nChildren = commOptions.nChildren || 1;

  m.children = _.map(_.range(nChildren), function(childi) {
    return child_process.spawn(execName, execArgs, _.extend({stdio: ['pipe', 'pipe', 'inherit']}, execOptions));
  });
  m.queues = _.map(_.range(m.children.length), function(childi) {
    return [];
  });
  m.rpcIdCtr = Math.floor(Math.random()*1000000000);
  _.each(_.range(m.children.length), function(childi) {
    var datas=[];
    m.children[childi].stdout.on('data', function(buf) {
      while (buf.length) {
        var eol = buf.indexOf(10); // newline
        if (eol < 0) {
          datas.push(buf);
          return;
        } else {
          datas.push(buf.slice(0, eol));
          var rep = JSON.parse(datas.join(''));
          datas = [];
          m.handleRx(childi, rep);
          buf = buf.slice(eol+1);
        }
      }
    });
    m.children[childi].on('close', function(code, signal) {
      logio.I(m.baseName + childi.toString(), 'close, code=', code, 'signal=', signal);
      m.handleClose(childi);
    });
    m.children[childi].on('error', function(err) {
      logio.E(m.baseName + childi.toString(), 'Failed to start child process', err);
    });
  });

};

ChildJsonPipe.prototype.close = function() {
  var m = this;
  for (var childi=0; childi<m.children.length; childi++) {
    m.children[childi].stdin.end();
  }
};

// Return index of child with shortest outstanding queue length
ChildJsonPipe.prototype.chooseAvailChild = function() {
  var m = this;
  var bestLen = m.queues[0].length
  var besti = 0;
  for (var childi=1; childi<m.children.length; childi++) {
    if (m.queues[childi].length < bestLen) {
      bestLen = m.queues[childi].length;
      besti = childi;
    }
  }
  return besti;
};

ChildJsonPipe.prototype.tx = function(childi, req) {
  var m = this;
  m.children[childi].stdin.write(JSON.stringify(req));
  m.children[childi].stdin.write('\n');
};

ChildJsonPipe.prototype.handleRx = function(childi, rx) {
  var m = this;
  var repInfo = m.queues[childi].shift();
  if (repInfo.id === rx.id) {
    if (rx.error) {
      if (m.verbose>=1) logio.E(m.baseName + childi.toString(), 'rx', repInfo.method, rx.error, Date.now()-repInfo.t0)
      repInfo.cb(new Error(rx.error), rx.result);
    } else {
      if (m.verbose>=1) logio.I(m.baseName + childi.toString(), repInfo.method, Date.now()-repInfo.t0)
      repInfo.cb(null, rx.result);
    }
  } else {
    logio.E(m.baseName + childi.toString(), 'Unknown id', rx, 'Expected', repInfo.id);
  }
}

// run result = method(params...) in child, call cb(exception, result)
ChildJsonPipe.prototype.rpc = function(method, params, cb) {
  var m = this;
  var id = m.rpcIdCtr++;
  var childi = m.chooseAvailChild();
  m.queues[childi].push({id: id, cb: cb, method: method, t0: Date.now()});
  m.tx(childi, {method: method, params: params, id: id});
};

// Do initial interaction with all the children
ChildJsonPipe.prototype.handshake = function(cb) {
  var m = this;
  async.each(_.range(m.children.length), function(childi, childDone) {
    var method = 'handshake';
    var params = [];
    var id = m.rpcIdCtr++;
    m.queues[childi].push({id: id, cb: childDone, method: method, t0: Date.now()});
    m.tx(childi, {method: method, params: params, id: id});
  }, cb);
};

ChildJsonPipe.prototype.handleClose = function(childi) {
  var m = this;
  m.children[childi] = null;
  while (m.queues[childi].length > 0) {
    var repInfo = m.queues[childi].shift();
    repInfo.cb('Connection closed', null);
  }
};
