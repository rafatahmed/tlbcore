'use strict';
/*
  It's reasonable to use this behind nginx. See http://nginx.org/en/docs/
*/
const _ = require('underscore');
const util = require('util');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const url = require('url');
const path = require('path');
const websocket = require('websocket');

const logio = require('../common/logio');
const vjs_dbs = require('./vjs_dbs');
const vjs_auth = require('./vjs_auth');
const vjs_provider = require('./vjs_provider');
const vjs_topology = require('./vjs_topology');
const vjs_safety = require('./vjs_safety');
const vjs_image = require('./vjs_image');
const web_socket_server = require('./web_socket_server');

exports.WebServer = WebServer;
exports.setVerbose = function(v) { verbose = v; };

// ======================================================================

let verbose = 1;

function WebServer() {
  let webServer = this;
  webServer.urlProviders = {};
  webServer.dirProviders = {};
  webServer.hostPrefixes = {};
  webServer.wsHandlers = {};
  webServer.serverAccessCounts = {};
  webServer.wwwRoot = null;
  webServer.allConsoleHandlers = [];
  webServer.servers = [];
}

WebServer.prototype.setUrl = function(url, p) {
  let webServer = this;
  if (_.isString(p)) {
    let st = fs.statSync(p);
    if (st.isDirectory()) {
      url = path.join(url, '/'); // ensure trailing slash, but doesn't yield more than one
      p = new vjs_provider.RawDirProvider(p);
    } else {
      p = new vjs_provider.RawFileProvider(p);
    }
  }

  if (p.isDir()) {
    webServer.dirProviders['GET ' + url] = p;
  } else {
    webServer.urlProviders['GET ' + url] = p;

    p.reloadKey = url;
    p.on('changed', function() {
      if (p.reloadKey) {
        webServer.reloadAllBrowsers(p.reloadKey);
      }
    });
  }
};

WebServer.prototype.setPrefixHosts = function(prefix, hosts) {
  let webServer = this;
  prefix = path.join('/', prefix, '/');

  _.each(hosts, function(host) {
    webServer.hostPrefixes[host] = prefix;
    console.log('Set hostPrefix['+host+']='+prefix);

    let alphaHost = host.replace(/^(\w+)\./, '$1-alpha.');
    if (alphaHost !== host) {
      webServer.hostPrefixes[alphaHost] = prefix;
    }
  });
};

WebServer.prototype.setSocketProtocol = function(url, f) {
  let webServer = this;

  webServer.wsHandlers[url] = f;
};


WebServer.prototype.setupBaseProvider = function() {
  let webServer = this;

  if (webServer.baseProvider) return;
  let p = new vjs_provider.ProviderSet();
  if (1) p.addCss(require.resolve('./common.css'));
  if (1) p.addCss(require.resolve('./spinner-lib/spinner.css'));
  // Add more CSS files here

  if (1) p.addScript(require.resolve('./vjs_preamble.js'));
  if (1) p.addScript(require.resolve('underscore'), 'underscore');
  if (1) p.addScript(require.resolve('../common/MoreUnderscore.js'));
  if (1) p.addScript(require.resolve('eventemitter'), 'events');
  if (1) p.addScript(require.resolve('jquery/dist/jquery.js'));
  if (1) p.addScript(require.resolve('./ajaxupload-lib/ajaxUpload.js'));       // http://valums.com/ajax-upload/
  if (1) p.addScript(require.resolve('./mixpanel-lib/mixpanel.js'));
  if (1) p.addScript(require.resolve('./web_socket_helper.js'), 'web_socket_helper');
  if (1) p.addScript(require.resolve('./web_socket_browser.js'), 'web_socket_browser');
  if (1) p.addScript(require.resolve('./box_layout.js'), 'box_layout');
  if (1) p.addScript(require.resolve('./vjs_browser.js'));
  if (1) p.addScript(require.resolve('./vjs_animation.js'), 'vjs_animation');
  if (1) p.addScript(require.resolve('./vjs_error.js'), 'vjs_error');
  if (1) p.addScript(require.resolve('./vjs_hit_detector.js'), 'vjs_hit_detector');
  if (1) p.addScript(require.resolve('./canvasutils.js'), 'canvasutils');

  webServer.baseProvider = p;
};

WebServer.prototype.setupStdContent = function(prefix) {
  let webServer = this;

  // WRITEME: ditch this, figure out how to upload over a websocket
  /*
    webServer.urlProviders['POST /uploadImage'] = {
      start: function() {},
      mirrorTo: function(dst) {},
      handleRequest: function(req, res, suffix) {
        RpcEngines.UploadHandler(req, res, function(docFn, doneCb) {
          let userName = RpcEngines.cookieUserName(req);
          Image.mkImageVersions(docFn, {fullName: userName}, function(ii) {
            doneCb(ii);
          });
        });
      }
    };
  */

  webServer.setSocketProtocol(prefix+'console', webServer.mkConsoleHandler.bind(webServer));

  // Files available from root of file server
  webServer.setUrl(prefix+'favicon.ico', require.resolve('./images/umbrella.ico'));
  webServer.setUrl(prefix+'spinner-lib/spinner24.gif', require.resolve('./spinner-lib/spinner24.gif'));
  webServer.setUrl(prefix+'spinner-lib/spinner32t.gif', require.resolve('./spinner-lib/spinner32t.gif'));
  webServer.setUrl(prefix+'images/icons.png', require.resolve('./images/ui-icons_888888_256x240.png'));

  webServer.setUrl(prefix+'healthcheck', {
    on: function() {},
    isDir: function() { return false; },
    getStats: function() { return {}; },
    handleRequest: function(req, res, suffix) {
      webServer.getContentStats(function(err, cs) {
        if (err) {
          res.writeHead(500, {'Content-Type': 'text/json'});
          res.write(JSON.stringify({
            status: 'fail',
            timestamp: Date.now()*0.001,
            hostname: os.hostname(),
            results: [],
          }));
          res.end();
          return;
        }

        res.writeHead(200, {'Content-Type': 'text/json'});
        res.write(JSON.stringify({
          status: 'success',
          timestamp: Date.now()*0.001,
          hostname: os.hostname(),
          results: [],
          // Don't leak this
          // stats: cs,
        }));
        res.end();
      });
    }
  });
};

WebServer.prototype.setupContent = function(dirs) {
  let webServer = this;

  webServer.setupBaseProvider();
  webServer.setupStdContent('/');

  _.each(dirs, function(dir) {
    // Start with process.cwd, since these directory names are specified on the command line
    let fn = fs.realpathSync(path.join(dir, 'load.js'));
    console.log('Load ' + fn);
    require(fn).load(webServer);
  });

  webServer.startAllContent();
  webServer.mirrorAll();
};



WebServer.prototype.startAllContent = function() {
  let webServer = this;
  _.each(webServer.urlProviders, function(p, name) {
    if (p.start) p.start();
  });
};

WebServer.prototype.mirrorAll = function() {
  let webServer = this;

  if (webServer.wwwRoot) {
    _.each(webServer.urlProviders, function(p, name) {
      let m = /^GET (.*)$/.exec(name);
      if (m) {
        let dst = path.join(webServer.wwwRoot, m[1]);
        p.mirrorTo(dst);
      }
    });
  }
};

function delPort(hn) {
  if (!hn) return hn;
  let parts = hn.split(':');
  return parts[0];
}

WebServer.prototype.startHttpServer = function(serverInfo) {
  let webServer = this;

  let httpServer = null;
  if (serverInfo.proto === 'https') {
    httpServer = https.createServer({
      key: serverInfo.key,
      cert: serverInfo.cert,
      honorCipherOrder: true,
    }, httpHandler);
  }
  else if (serverInfo.proto === 'http') {
    httpServer = http.createServer(httpHandler);
  }
  else {
    throw new Error('Unknown proto ' + serverInfo.proto);
  }
  httpServer.keepAliveTimeout = 120000; // workaround for https://github.com/nodejs/node/issues/15082
  console.log('Listening on ' + serverInfo.proto + '://'+ serverInfo.host + ':' + serverInfo.port);
  httpServer.listen(serverInfo.port, serverInfo.host);

  webServer.servers.push(httpServer);

  let ws = new websocket.server({
    httpServer: httpServer,
    maxReceivedFrameSize: 1024*1024,
  });
  ws.on('request', wsRequestHandler);
  webServer.servers.push(ws);

  function httpHandler(req, res) {

    req.remoteLabel = req.connection.remoteAddress + '!http';

    try {
      annotateReq(req);
    } catch(ex) {
      logio.E(req.remoteLabel, ex);
      vjs_provider.emit500(res);
    }
    if (verbose >= 3) logio.I(req.remoteLabel, req.url, req.urlParsed, req.headers);

    // Host includes port number, hostname doesn't
    let hostPrefix = webServer.hostPrefixes[req.urlParsed.host];
    if (!hostPrefix) {
      hostPrefix = webServer.hostPrefixes[req.urlParsed.hostname];
    }
    if (!hostPrefix) {
      hostPrefix = '/';
    }

    let fullPath = hostPrefix + decodeURIComponent(req.urlParsed.pathname.substr(1));
    let callid = req.method + ' ' + fullPath;
    let desc = callid;
    webServer.serverAccessCounts[callid] = (webServer.serverAccessCounts[callid] || 0) + 1;
    let p = webServer.urlProviders[callid];
    if (p) {
      if (!p.silent) logio.I(req.remoteLabel, desc, p.toString());
      p.handleRequest(req, res, '');
      return;
    }

    let pathc = fullPath.substr(1).split('/');
    for (let pathcPrefix = pathc.length-1; pathcPrefix >= 1; pathcPrefix--) {
      let prefix = req.method + ' /' + pathc.slice(0, pathcPrefix).join('/') + '/';
      p = webServer.dirProviders[prefix];
      if (p) {
        let suffix = pathc.slice(pathcPrefix, pathc.length).join('/');
        if (!p.silent) logio.I(req.remoteLabel, desc, p.toString());
        p.handleRequest(req, res, suffix);
        return;
      }
    }

    logio.E(req.remoteLabel, desc, '404', 'referer:', req.headers.referer);
    vjs_provider.emit404(res, callid);
    return;
  }

  function wsRequestHandler(wsr) {
    let callid = wsr.resource;

    wsr.remoteLabel = wsr.httpRequest.connection.remoteAddress + '!ws' + wsr.resource;
    try {
      annotateReq(wsr.httpRequest);
    } catch(ex) {
      logio.E(wsr.remoteLabel, ex);
      wsr.reject();
      return;
    }

    let handlersFunc = webServer.wsHandlers[callid];
    if (!handlersFunc) {
      logio.E(wsr.remoteLabel, 'Unknown api', callid, webServer.wsHandlers);
      wsr.reject();
      return;
    }

    logio.I(wsr.remoteLabel, 'Origin', wsr.origin);
    if (0) {     // WRITEME: check origin
      wsr.reject();
      return;
    }

    let handlers = handlersFunc();
    if (handlers.capacityCheck) {
      if (!handlers.capacityCheck()) {
        logio.O(wsr.remoteLabel, 'Reject due to capacityCheck');
        wsr.reject();
        return;
      }
    }
    let wsc = wsr.accept(null, wsr.origin);
    if (!wsc) {
      logio.E('ws', 'wsr.accept failed');
      return;
    }

    web_socket_server.mkWebSocketRpc(wsr, wsc, handlers);
  }

  function annotateReq(req) {
    let up;
    try {
      up = url.parse(decodeURIComponent(req.url), true);
    } catch (ex) {
      logio.E(req.remoteLabel, 'Error parsing', req.url, ex);
      throw ex;
    }

    if (!up.hostname) up.hostname = delPort(req.headers.host);
    if (!up.hostname) up.hostname = 'localhost';
    if (up.hostname.match(/[^-\w\.]/)) {
      logio.E(req.remoteLabel, 'Invalid host header', up.hostname);
      throw new Error('Invalid host header');
    }
    if (!up.port) up.port = serverInfo.port;
    if (!up.host) up.host = up.hostname + (up.port === 80 ? '' : ':' + up.port);
    up.protocol = 'http:';

    req.urlParsed = up;
    req.urlFull = url.format(up);
  }

};

WebServer.prototype.getSiteHits = function(cb) {
  let webServer = this;
  cb(null, _.map(_.sortBy(_.keys(webServer.serverAccessCounts), _.identity), function(k) {
    return {desc: 'http.' + k, hits: webServer.serverAccessCounts[k]};
  }));
};

WebServer.prototype.getContentStats = function(cb) {
  let webServer = this;
  cb(null, _.map(_.sortBy(_.keys(webServer.urlProviders), _.identity), function(k) {
    return _.extend({}, webServer.urlProviders[k].getStats(), {desc: k});
  }));
};

WebServer.prototype.reloadAllBrowsers = function(reloadKey) {
  let webServer = this;
  _.each(webServer.allConsoleHandlers, function(ch) {
    if (ch.reloadKey === reloadKey) {
      if (ch.reloadCb) {
        ch.reloadCb('reload');
      }
    }
  });
};

WebServer.prototype.findByContentMac = function(contentMac) {
  let webServer = this;
  let ret = [];
  _.each(webServer.urlProviders, function(provider, url) {
    if (provider && provider.contentMac == contentMac) {
      ret.push(provider);
    }
  });
  return ret;
};


WebServer.prototype.mkConsoleHandler = function() {
  let webServer = this;
  return {
    start: function() {
      let self = this;
      logio.I(self.label, 'Console started');
      webServer.allConsoleHandlers.push(self);
    },
    close: function() {
      let self = this;
      webServer.allConsoleHandlers = _.filter(webServer.allConsoleHandlers, function(other) { return other !== self; });
    },
    rpc_errlog: function(msg, cb) {
      let self = this;
      logio.E(self.label, 'Errors in ' + msg.ua);
      let err = msg.err;
      if (err) {
        if (_.isObject(err)) {
          err = util.inspect(err);
        }
        console.log(err.replace(/^/mg, '    '));
      }
      cb(null);
    },
    rpc_reloadOn: function(msg, cb) {
      let self = this;
      self.reloadKey = msg.reloadKey;
      self.contentMac = msg.contentMac;
      if (self.contentMac) {
        let sameContent = webServer.findByContentMac(self.contentMac);
        if (!sameContent.length) {
          logio.I(self.label, 'Obsolete contentMac (suggesting reload)', self.contentMac);
          cb('reload');
        } else {
          logio.I(self.label, 'Valid contentMac', self.contentMac);
          self.reloadCb = cb;
        }
      }
    }
  };
};