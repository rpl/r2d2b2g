/* This Source Code Form is subject to the terms of the Mozilla Public
  * License, v. 2.0. If a copy of the MPL was not distributed with this
  * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

this.EXPORTED_SYMBOLS = ["SimulatorActor"];

function log(msg) {
  var DEBUG_LOG = true;
  
  if (DEBUG_LOG)
    dump("prosthesis:"+msg+"\n");
}

log("loading simulator actor definition");

/**
  * Creates a SimulatorActor. SimulatorActor provides remote access to the
  * FirefoxOS Simulator module.
  */
function SimulatorActor(aConnection)
{
  log("simulator actor created for a new connection");  
  this._connection = aConnection;
  this._listeners = {};
}

SimulatorActor.prototype = {
  actorPrefix: "simulator",

  disconnect: function() {
    log("simulator actor connection closed");
    this._unsubscribeWindowManagerEvents();
  },

  onPing: function(aRequest) {
    log("simulator actor received a 'ping' command");
    return { "msg": "pong" };
  },
  
  onGetBuildID: function(aRequest) {
    log("simulator actor received a 'getBuildID'");
    var buildID = this.simulatorWindow.navigator.buildID;

    return {
      buildID: buildID
    };
  },

  onLogStdout: function(aRequest) {
    log("simulator actor received a 'logStdout' command");
    // HACK: window.dump should dump on stdout
    // https://developer.mozilla.org/en/docs/DOM/window.dump#Notes
    let dumpStdout = this.simulatorWindow.dump;
    dumpStdout(aRequest.message);

    return {
      success: true
    };
  },

  onRunApp: function(aRequest) {
    log("simulator actor received a 'runApp' command");
    let window = this.simulatorWindow;
    let appName = aRequest.appname;

    window.runAppObj = new window.AppRunner(appName);

    window.runAppObj.doRunApp();

    return {
      message: "runApp request received"
    };
  },

  onLockScreen: function(aRequest) {
    log("simulator actor received a 'lockScreen' command");
    let _notify = this._notify.bind(this);
    let enabled = aRequest.enabled;
    let window = this.simulatorWindow;

    let setReq = window.navigator.mozSettings
      .createLock().set({'lockscreen.enabled': enabled});
    setReq.onsuccess = function() {
      log("LOCK SUCCESS");
      _notify('lockScreenEvent', { enabled: enabled, success: true });
    }
    setReq.onerror = function() {
      log("LOCK ERROR");
      _notify('lockScreenEvent', { enabled: enabled, success: false });
    }

    return { message: "lockScreen command received" }
  },

  onGetInstalledApps: function(aRequest) {
    log("simulator actor received a 'getInstalledApps' command: "+JSON.stringify(aRequest));

    let _notify = this._notify.bind(this);
    let window = this.simulatorWindow;
    let mozApps = this.simulatorWindow.navigator.mozApps;

    let req = mozApps.getInstalled();
    req.onsuccess = function() {
      let result = req.result.map(function(app) {
        return {
          origin: app.origin,
          installOrigin: app.installOrigin,
          installTime: app.installTime,
          updateTime: app.updateTime,
          lastUpdateCheck: app.lastUpdateCheck,
          manifestURL: app.manifestURL,
          downloadSize: app.downloadSize,
          removable: app.removable,
          manifest: app.manifest,
          receipts: app.receipts,
        }
      });
      log("GET INSTALLED APPS SUCCESS:",JSON.stringify(result));
      _notify('getInstalledAppsEvent', { installedApps: result, success: true });
    }
    req.onerror = function() {
      log("GET INSTALLED APPS ERROR");
      // TODO: send error
      _notify('getInstalledAppsEvent', { message: "error "+req.error.name, error: error,
                                         success: false });
    }

    return { message: "getInstalledApps command received" }
  },

  onInstallApp: function(aRequest) {
    log("simulator actor received a 'installApp' command: "+JSON.stringify(aRequest));

    let _notify = this._notify.bind(this);
    let window = this.simulatorWindow;
    let mozApps = this.simulatorWindow.navigator.mozApps;
    let install = function (manifestURL) {
      if(aRequest.packaged) {
        return mozApps.installPackage(manifestURL);
      } else {
        return mozApps.install(manifestURL);
      }
    }

    let req = install(aRequest.manifestURL);
    req.onsuccess = function() {
      log("INSTALL APP SUCCESS:",JSON.stringify(req.result));
      _notify('installAppEvent', { origin: req.result.origin, success: true });
    }
    req.onerror = function() {
      log("INSTALL APP ERROR");
      // TODO: send error
      _notify('installAppEvent', { message: "error installing", success: false });
    }

    return { message: "installApp command received" }
  },

  onSubscribeWindowManagerEvents: function (aRequest) {
    log("simulator actor received a 'subscribeWindowManagerEvents' command");
    let ok = this._subscribeWindowManagerEvents();

    if (ok) {
      return {
        success: true,
        message: "WindowManager events subscribed"
      }
    } 

    return {
      success: false,
      message: "WindowManager events already subscribed"
    }
  },

  onUnsubscribeWindowManagerEvents: function (aRequest) {
    log("simulator actor received a 'unsubscribeWindowManagerEvents' command");
    this._unsubscribeWindowManagerEvents();
    
    return {
      success: true,
      message: "WindowManager events unsubscribed"
    }
  },

  _unsubscribeWindowManagerEvents: function() {
    let homescreenWindow = this.homescreenWindow.wrappedJSObject;

    homescreenWindow.removeEventListener("appopen", this._listeners["appopen"]);
    homescreenWindow.removeEventListener("appterminated", this._listeners["appterminated"]);
  },

  _subscribeWindowManagerEvents: function() {
    let homescreenWindow = this.homescreenWindow.wrappedJSObject;
    let WindowManager = homescreenWindow.WindowManager;
    let _notify = this._notify.bind(this);

    if (!!this._listeners["appopen"] || 
        !!this._listeners["appterminated"]) {
      // NOTE: already subscribed
      return false;
    }

    homescreenWindow.addEventListener("appopen", onAppOpen);
    this._listeners["appopen"] = onAppOpen;

    homescreenWindow.addEventListener("appterminated", onAppTerminated);
    this._listeners["appterminated"] = onAppTerminated;

    return true;

    function onAppOpen(e) {
      let origin = e.detail.origin;
      let app = WindowManager.getRunningApps()[origin];

      _notify("windowManagerEvent",{
        event: "appopen",
        origin: origin,
        name: app.name,
        manifest: app.manifest
      });
    }

    // NOTE: exception into this closures seems to be silently ignored :-(
    function onAppTerminated(e) {
      let origin = e.detail.origin;
      _notify("windowManagerEvent",{
        event: "appterminated",
        origin: origin
      });
    }
  },

  _notify: function(type,data) {
    data.type = type;
    data.from = this.actorID;
    log("SENDING: "+JSON.stringify(data));
    this.conn.send(data);
  },

  get homescreenWindow() {
    var shellw = this.simulatorWindow.document.getElementById("homescreen").contentWindow;
    return shellw;
  },

  get simulatorWindow() {
    var window = Cc['@mozilla.org/appshell/window-mediator;1']
      .getService(Ci.nsIWindowMediator)
      .getMostRecentWindow("navigator:browser");
    return window;
  },
};

/**
 * The request types this actor can handle.
 */
SimulatorActor.prototype.requestTypes = {
  "ping": SimulatorActor.prototype.onPing,
  "getBuildID": SimulatorActor.prototype.onGetBuildID,
  "logStdout": SimulatorActor.prototype.onLogStdout,
  "runApp": SimulatorActor.prototype.onRunApp,
  "lockScreen": SimulatorActor.prototype.onLockScreen,
  "subscribeWindowManagerEvents": SimulatorActor.prototype.onSubscribeWindowManagerEvents,
  "unsubscribeWindowManagerEvents": SimulatorActor.prototype.onUnsubscribeWindowManagerEvents,
  "getInstalledApps": SimulatorActor.prototype.onGetInstalledApps,
  "installApp": SimulatorActor.prototype.onInstallApp,
};

DebuggerServer.removeGlobalActor(SimulatorActor);
DebuggerServer.addGlobalActor(SimulatorActor,"simulatorActor");
