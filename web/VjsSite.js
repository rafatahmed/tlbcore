/*
  It's reasonable to use this behind nginx. See http://nginx.org/en/docs/
*/
var _                   = require('underscore');
var util                = require('util');
var http                = require('http');
var https               = require('https');
var fs                  = require('fs');
var url                 = require('url');
var path                = require('path');
var websocket           = require('websocket');

var logio               = require('./logio');
var VjsDbs              = require('./VjsDbs');
var Auth                = require('./Auth');
var Provider            = require('./Provider');
var Topology            = require('./Topology');
var Safety              = require('./Safety');
var Image               = require('./Image');
var WebSocketServer     = require('./WebSocketServer');

exports.WebServer = WebServer;
exports.setVerbose = function(v) { verbose = v; };

// ======================================================================

var verbose = 1;

function WebServer() {
  var webServer = this;
  webServer.urlProviders = {};
  webServer.dirProviders = {};
  webServer.hostPrefixes = {};
  webServer.wsHandlers = {};
  webServer.serverAccessCounts = {};
  webServer.wwwRoot = null;
  webServer.allConsoleHandlers = [];
}

WebServer.prototype.setUrl = function(url, p) {
  var webServer = this;
  if (_.isString(p)) {
    var st = fs.statSync(p);
    if (st.isDirectory()) {
      url = path.join(url, '/'); // ensure trailing slash, but doesn't yield more than one
      p = new Provider.RawDirProvider(p);
    } else {
      p = new Provider.RawFileProvider(p);
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
  var webServer = this;
  prefix = path.join('/', prefix, '/');
  
  _.each(hosts, function(host) {
    webServer.hostPrefixes[host] = prefix;
    console.log('Set hostPrefix['+host+']='+prefix);
  });
};

WebServer.prototype.setSocketProtocol = function(url, f) {
  var webServer = this;
  
  webServer.wsHandlers[url] = f;
};


WebServer.prototype.setupBaseProvider = function() {
  var webServer = this;

  if (webServer.baseProvider) return;
  var p = new Provider.ProviderSet();
  if (1) p.addCss(require.resolve('./common.css'));
  if (1) p.addCss(require.resolve('./spinner-lib/spinner.css'));
  // Add more CSS files here

  if (1) p.addScript(require.resolve('./VjsPreamble.js'));
  if (1) p.addScript(require.resolve('underscore'), 'underscore');
  if (1) p.addScript(require.resolve('../common/MoreUnderscore.js'));
  if (1) p.addScript(require.resolve('eventemitter'));
  if (1) p.addScript(require.resolve('jquery/dist/jquery.js'));
  if (1) p.addScript(require.resolve('./ajaxupload-lib/ajaxUpload.js'));       // http://valums.com/ajax-upload/
  if (0) p.addScript(require.resolve('./swf-lib/swfobject.js'));               // http://blog.deconcept.com/swfobject/
  if (1) p.addScript(require.resolve('./mixpanel-lib/mixpanel.js'));
  if (1) p.addScript(require.resolve('./WebSocketHelper.js'), 'WebSocketHelper');
  if (1) p.addScript(require.resolve('./WebSocketBrowser.js'), 'WebSocketBrowser');
  if (1) p.addScript(require.resolve('./VjsBrowser.js'));
  if (1) p.addScript(require.resolve('./HitDetector.js'));
  if (1) p.addScript(require.resolve('./canvasutils.js'));

  webServer.baseProvider = p;
};

WebServer.prototype.setupStdContent = function(prefix) {
  var webServer = this;

  // WRITEME: ditch this, figure out how to upload over a websocket
  /*
    webServer.urlProviders['POST /uploadImage'] = {
      start: function() {},
      mirrorTo: function(dst) {},
      handleRequest: function(req, res, suffix) {
        RpcEngines.UploadHandler(req, res, function(docFn, doneCb) {
          var userName = RpcEngines.cookieUserName(req);
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
  webServer.setUrl(prefix+'spinner-lib/spinner.gif', require.resolve('./spinner-lib/spinner.gif'));
  webServer.setUrl(prefix+'images/icons.png', require.resolve('./images/ui-icons_888888_256x240.png'));
};

WebServer.prototype.setupContent = function(dirs) {
  var webServer = this;
  
  webServer.setupBaseProvider();
  webServer.setupStdContent('/');

  _.each(dirs, function(dir) {
    // Start with process.cwd, since these directory names are specified on the command line
    var fn = fs.realpathSync(path.join(dir, 'load.js'));
    util.print('Load ' + fn + '\n');
    require(fn).load(webServer);
  });

  webServer.startAllContent();
  webServer.mirrorAll();
};



WebServer.prototype.startAllContent = function() {
  var webServer = this;
  _.each(webServer.urlProviders, function(p, name) {
    if (p.start) p.start();
  });
};

WebServer.prototype.mirrorAll = function() {
  var webServer = this;

  if (webServer.wwwRoot) {
    _.each(webServer.urlProviders, function(p, name) {
      var m = /^GET (.*)$/.exec(name);
      if (m) {
        var dst = path.join(webServer.wwwRoot, m[1]);
        p.mirrorTo(dst);
      }
    });
  }
};

WebServer.prototype.startHttpServer = function(bindPort, bindHost) {
  var webServer = this;
  if (!bindPort) bindPort = 8000;
  if (!bindHost) bindHost = '127.0.0.1';
  
  webServer.httpServer = http.createServer(httpHandler);
  util.puts('Listening on ' + bindHost + ':' + bindPort);
  webServer.httpServer.listen(bindPort, bindHost);

  webServer.ws = new websocket.server({httpServer: webServer.httpServer});
  webServer.ws.on('request', wsRequestHandler);

  function httpHandler(req, res) {

    var remote = req.connection.remoteAddress + '!http';
    
    var up;
    try {
      up = url.parse(req.url, true);
    } catch (ex) {
      logio.E(remote, 'Error parsing', req.url, ex);
      return Provider.emit404(res, 'Invalid url');
    }

    function delPort(hn) {
      if (!hn) return hn;
      var parts = hn.split(':');
      return parts[0];
    }
    
    var origHost = delPort(up.host);
    if (!up.host) up.host = delPort(req.headers.host);
    if (!up.host) up.host = 'localhost';
    if (up.host.match(/[^-\w\.]/)) {
      logio.E(remote, 'Invalid host header', up.host);
      return Provider.emit404(res, 'Invalid host header');
    }

    if (0) logio.I(remote, req.url, up, req.headers);

    var hostPrefix = webServer.hostPrefixes[up.host];
    if (!hostPrefix) hostPrefix = '/';

    var fullPath = hostPrefix + up.pathname.substr(1);
    var callid = req.method + ' ' + fullPath;
    var desc = req.method + ' http://' + up.host + up.pathname;
    webServer.serverAccessCounts[callid] = (webServer.serverAccessCounts[callid] || 0) + 1;
    var p = webServer.urlProviders[callid];
    if (p) {
      logio.I(remote, desc, fullPath, p.toString());
      p.handleRequest(req, res, '');
      return;
    }

    var pathc = fullPath.substr(1).split('/');
    for (var pathcPrefix = pathc.length-1; pathcPrefix >= 1; pathcPrefix--) {
      var prefix = req.method + ' /' + pathc.slice(0, pathcPrefix).join('/') + '/';
      p = webServer.dirProviders[prefix];
      if (p) { 
        var suffix = pathc.slice(pathcPrefix, pathc.length).join('/');
        logio.I(remote, desc, prefix, suffix, p.toString());
        p.handleRequest(req, res, suffix);
        return;
      }
    }

    logio.E(remote, desc, '404', 'referer:', req.headers.referer);
    Provider.emit404(res, callid);
    return;
  }

  function wsRequestHandler(wsr) {
    var callid = wsr.resource;
    
    var handlersFunc = webServer.wsHandlers[callid];
    if (!handlersFunc) {
      logio.E('ws', 'Unknown api', callid, webServer.wsHandlers);
      wsr.reject();
      return;
    }

    if (0) {     // WRITEME: check origin
      wsr.reject();
      return;
    }

    var wsc = wsr.accept(null, wsr.origin);
    if (!wsc) {
      logio.E('wsr.accept failed');
      return;
    }

    var handlers = handlersFunc();
    WebSocketServer.mkWebSocketRpc(wsr, wsc, handlers);
  }
};

WebServer.prototype.getSiteHits = function(cb) {
  var webServer = this;
  cb(_.map(_.sortBy(_.keys(webServer.serverAccessCounts), _.identity), function(k) {
    return {desc: 'http.' + k, hits: webServer.serverAccessCounts[k]};
  }));
};

WebServer.prototype.getContentStats = function(cb) {
  var webServer = this;
  cb(_.map(_.sortBy(_.keys(webServer.urlProviders), _.identity), function(k) { 
    return _.extend({}, webServer.urlProviders[k].getStats(), {desc: k});
  }));
};

WebServer.prototype.reloadAllBrowsers = function(reloadKey) {
  var webServer = this;
  _.each(webServer.allConsoleHandlers, function(ch) {
    if (ch.reloadKey === reloadKey) {
      ch.cmd('reload', {});
    }
  });
};

WebServer.prototype.mkConsoleHandler = function() {
  var webServer = this;
  return {
    start: function() {
      logio.I(this.label, 'Console started');
      webServer.allConsoleHandlers.push(this);
    },
    close: function() {
      var self = this;
      webServer.allConsoleHandlers = _.filter(webServer.allConsoleHandlers, function(other) { return other !== self; });
    },
    cmd_errlog: function(msg) {
      logio.E(this.label, 'Errors in ' + msg.ua);
      var err = msg.err;
      if (err) {
        if (_.isObject(err)) {
          err = util.inspect(err);
        }
        util.puts(err.replace(/^/mg, '    '));
      }
    },
    cmd_reloadOn: function(msg) {
      this.reloadKey = msg.reloadKey;
    }
  };
};

