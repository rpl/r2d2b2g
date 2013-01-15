/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

// # app-manager module

// AppManager is responsible of:
//
// * manage registered applications and permission
// * generate packaged application assets
// * start/stop mini-market HTTP server

'use strict';

const { Cc, Ci, Cr, Cu } = require("chrome");

const { Class } = require("sdk/core/heritage");
const { EventTarget } = require("sdk/event/target");
const { emit } = require("sdk/event/core");
const UUID = require("sdk/util/uuid");

const SStorage = require("simple-storage");

const URL = require("url");
const File = require("file");

const { rootURI } = require('@loader/options');
const profileURL = rootURI + "profile/";

const MINIMARKET_PATH = URL.toFilename(rootURI + "miniMarket");

// ## AppManager class
const AppManager = Class({
  // AppManager extends EventTarget and inherits its 'on', and 'once' methods
  extends: EventTarget,
  // ### initialize
  // During initialization EventTarget tries to register handlers fom options:
  //
  // <pre><code>
  //     AppManager({
  //       onInfo: function(data) { let {msg} = data; ... },
  //       onError: function(data) { let {msg} = data; ... },
  //       ...
  //     })
  // </code></pre>
  //
  initialize: function initialize(options) {
    EventTarget.prototype.initialize.call(this, options);
    this.on("appRegistered", (function(app) {
      if (app.type == "hosted")
        this.registerPermissions(app.id);
    }).bind(this));
  },

  _generateAppId: function(app) {
    return UUID.uuid();
  },

  // ### updateAppStatus
  // update installed status on an app and emit appStatusUpdate and appListUpdated events
  updateAppStatus: function(appId, installed) {
    let app = this.apps[appId];
    if (app && app.installed !== installed) {
      this.apps[appId].installed = installed;
      emit(this, "appStatusUpdated", app);
      emit(this, "appListUpdated", this.apps);
    }
  },

  // ### registerApp
  // register an application to the application manager:
  registerApp: function (app) {
    if (!app) return null;

    // * get type
    let { type } = app;
    let apps = this.apps;
    let appId = app.id = this._generateAppId(app);

    app.installed = false;

    switch (type) {
    // on type == "hosted_generated"
    case "hosted_generated":
      app.name = app.manifest.name || "Name unknown"
      app.revealUrl = app.manifest.origin + app.manifest.launch_path;
      break;
    // on type == "hosted"
    case "hosted":
      app.name = app.manifest.name || "Name unknown"
      app.revealUrl = app.origin + app.manifest.launch_path;
      break;
    // on type == "packaged"
    case "packaged":
      app.name = app.manifest.name || "Name unknown"
      app.revealUrl = app.manifestPath
      break;
    // on type == "package_ generated"
    case "packaged_generated":
      // a packaged app withoud a manifest:
      // generate a manifest and change to packaged type
      // TODO: to be completed in a next iteration
      break;
    // on type == "packaged_certified"
    case "packaged_certified":
      // TODO: to be completed in a next iteration
      break;

    }

    apps[appId] = app;

    emit(this, "appRegistered", app);
    emit(this, "appListUpdated", apps);

    // returns registered app id
    return appId;
  },

  // ### apps
  // apps getter returns current registered apps
  get apps() {
    return SStorage.storage.apps || (SStorage.storage.apps = {});
  },

  // ### permissions
  // permissions getter returns current registered permissions
  get permissions() {
    return SStorage.storage.permissions || (SStorage.storage.permissions = {});
  },

  get randomFreeTCPPort() {
    var serv = Cc['@mozilla.org/network/server-socket;1']
      .createInstance(Ci.nsIServerSocket);
    serv.init(-1, true, -1);
    var found = serv.port;
    console.log("rsc.remoteDebuggerPort: found free port ", found);
    serv.close();
    return found;
  },

  // ### startHTTPServer
  // starts http server used to serve generated application assets (e.g. manifest, zip)
  startHTTPServer: function () {
    if (!!this._httpServer && !this._httpServer.isStopped())
      return this._httpServer.stop();

    let port = this.randomFreeTCPPort;

    this._httpServer = require("httpd").startServerAsync(port, this.miniMarketPath);
    this._httpServer.registerContentType("webapp", "application/x-web-app-manifest+json");

    this._miniMarketURL = "http://localhost:"+port+"/";
  },

  // ### stopHTTPServer
  // stop http server
  stopHTTPServer: function (cb) {
    if (this._httpServer) {
      // NOTE: raise an exception without a defined callback
      this._httpServer.stop(cb || function () {});
      this._httpServer = null;
      this._miniMarketURL = "";
    }
  },

  get isHTTPServerRunning() {
    return (this._httpServer && !(this._httpServer.isStopped()));
  },

  // ### defaultApp
  // DEPRECATED: to be removed
  get defaultApp() {
    return SStorage.storage.defaultApp || null;
  },

  // ### defaultApp = id
  // DEPRECATED: to be removed
  set defaultApp(id) {
    SStorage.storage.defaultApp = id;
  },

  get miniMarketPath() {
    if (!File.exists(MINIMARKET_PATH)) {
      File.mkpath(MINIMARKET_PATH);
    }
    return MINIMARKET_PATH;
  },

  get miniMarketURL() {
    console.debug("miniMarketURL", this._miniMarketURL);
    return this._miniMarketURL;
  },

  // ### generatePacagedAppAssets
  generatePackagedAppAssets: function(appId) {
    let apps = this.apps;
    let app = apps[appId];

    console.debug("generatePackagedAppAssets",appId, JSON.stringify(app));
    if (!app || app.type !== "packaged") return false;

    let miniMarketPath = this.miniMarketPath;
    let miniMarketURL = this.miniMarketURL;
    let manifestPath = app.manifestPath;

    let manifestFile = Cc['@mozilla.org/file/local;1'].
      createInstance(Ci.nsIFile);
    manifestFile.initWithPath(manifestPath);
    let sourceDir = manifestPath.replace(/[\/\\][^\/\\]*$/, "");

    let archiveFile = File.join(miniMarketPath, appId+".zip");

    let miniManifestFile = File.join(miniMarketPath, appId+".webapp");

    console.log("Zipping " + sourceDir + " to " + archiveFile);
    // * create package.zip
    archiveDir(archiveFile, sourceDir);

    console.log("Creating mini manifest file " + miniManifestFile);
    // * create package.manifest
    let name = app.name;
    let version = app.manifest && app.manifest.version ? app.manifest.version : Date.now();
    let packageURL = miniMarketURL+appId+".zip";
    app.manifestURL = miniMarketURL+appId+".webapp";
    createMiniManifest(name, version, packageURL, miniManifestFile,
                       (function (error) {
                         if (error)
                           emit(this, "error", error);

                         emit(this, "appPackaged", app.manifestURL);
                       }).bind(this));

    return true;
  },

  registerPermissions: function (appId) {
    console.debug("AppManager.registerPermissions", appId);
    let app = this.apps[appId];

    let PermissionsInstaller;
    try {
      PermissionsInstaller =
        Cu.import("resource://gre/modules/PermissionsInstaller.jsm").
        PermissionsInstaller;
    } catch(e) {
      // PermissionsInstaller doesn't exist on Firefox 17 (and 18/19?),
      // so catch and ignore an exception importing it.
    }

    if (PermissionsInstaller) {
      PermissionsInstaller.installPermissions(
        {
          manifest: app.manifest,
          manifestURL: app.manifestURL,
          origin: app.origin
        },
        false, // isReinstall, installation failed for true
        function(e) {
          console.error("PermissionInstaller FAILED for " + config.origin);
        }
      );
    }
  },

  injectApp: function(id, manual) {
    console.log("AppManager.updateApp " + id);

    let webappsDir = URL.toFilename(profileURL + "webapps");
    let webappsFile = File.join(webappsDir, "webapps.json");
    let webapps = JSON.parse(File.read(webappsFile));

    let apps = this.apps;
    let config = apps[id];

    console.debug("CONFIG",JSON.stringify(config, null, 2));

    if (!config) {
      return;
    }

    if (!config.xid) {
      config.xid = ++[id for each ({ localId: id } in webapps)].sort(function(a, b) b - a)[0];
      config.xkey = "myapp" + config.xid + ".gaiamobile.org";

      config.origin = config.manifest.origin;
    }

    config.lastUpdate = Date.now();

    let webappEntry = {
      origin: config.origin,
      manifestURL: config.origin + "/manifest.webapp",
      installOrigin: "chrome://browser",
      receipt: null,
      installTime: Date.now(),
      appStatus: 1, // 1 = INSTALLED
      localId: config.xid,
    };

    console.log("Creating webapp entry: " + JSON.stringify(webappEntry, null, 2));

    // Create the webapp record and write it to the registry.
    webapps[config.xkey] = webappEntry;
    File.open(webappsFile, "w").writeAsync(
      JSON.stringify(webapps, null, 2) + "\n",
      (function(error) {
        if (error) {
          console.error("error writing webapp record to registry: " + error);
          return
        }

        // Create target folder
        let webappDir = File.join(webappsDir, config.xkey);
        // if (File.exists(webappDir)) {
        //   File.rmdir(webappDir);
        // }
        File.mkpath(webappDir);
        console.log("Created " + webappDir);

        let webappFile = File.join(webappDir, "manifest.webapp");
        File.open(webappFile, "w").writeAsync(JSON.stringify(config.manifest, null, 2), (function(err) {
          if (err) {
            console.error("Error while writing manifest.webapp " + err);
          }

          console.log("Written manifest.webapp");
          emit(this, "info", {
            message: config.name + " (hosted app) installed in Firefox OS"
          });

          if (manual) {
            this.defaultApp = id;
            emit(this, "appUpdated", id);
          }
        }).bind(this));

        console.debug("appListUpdated SENDING...");
        emit(this, "appListUpdated", apps);
        console.debug("appListUpdated SENT");
      }).bind(this));
  },

  removeApp: function(id) {
    let apps = this.apps;
    let config = apps[id];

    if (!config) {
      return;
    }

    let needsDeletion = !config.removed;
    config.removed = true;
    apps[id] = config;

    emit(this, "appListUpdated", apps);
  },

  undoRemoveApp: function(id) {
    let apps = this.apps;
    let config = apps[id];

    if (!config || !config.removed) {
      return;
    }

    config.removed = false;
    apps[id] = config;

    emit(this, "appListUpdated", apps);
  },

  removeAppFinal: function(id) {
    console.debug("AppManager.removeAppFinal", id);
    let self = this;
    let apps = this.apps;
    let config = apps[id];

    if (!config.removed) {
      return;
    }

    delete apps[id];

    console.debug("AppManager.removeAppFinal: unregister permissions");
    let permissions = this.permissions;
    if (permissions[config.origin]) {
      let host = config.host;
      permissions[config.origin].forEach(function(type) {
        permissionManager.remove(host, type);
      });
      delete permissions[config.origin];
    }

    // NOTE: other app types will be removed using mozApps API
    if (config.type !== "hosted_generated") {
      return;
    }

    // Remove injected hosted generated app
    let webappsDir = URL.toFilename(profileURL + "webapps");
    let webappsFile = File.join(webappsDir, "webapps.json");
    let webapps = JSON.parse(File.read(webappsFile));

    // Delete the webapp record from the registry.
    delete webapps[config.xkey];
    File.open(webappsFile, "w").writeAsync(
      JSON.stringify(webapps, null, 2) + "\n",
      function(error) {
        if (error) {
          console.error("Error writing webapp record to registry: " + error);
          return;
        }

        // Delete target folder if it exists
        let webappDir = File.join(webappsDir, config.xkey);
        let webappDir_nsIFile = Cc['@mozilla.org/file/local;1'].
                                 createInstance(Ci.nsIFile);
        webappDir_nsIFile.initWithPath(webappDir);
        if (webappDir_nsIFile.exists() && webappDir_nsIFile.isDirectory()) {
          webappDir_nsIFile.remove(true);
        }
      }
    );
  },

  flushRemovedApps: function() {
    console.debug("AppManager.flushRemovedApps");
    let apps = this.apps;
    let needsRestart = false;
    try {
      for (var id in apps) {
        let app = apps[id];
        if (app.removed) {
          if (app.type === "hosted_generated")
            needsRestart = true;
          this.removeAppFinal(id);
        }
      }
    } catch(e) {
      console.error(e,e.fileName,e.lineNumber);
    }
    emit(this, "appFlushRemovedApps", needsRestart);
  }
});

module.exports = AppManager;

// ## PRIVATE HELPERS

const PR_RDWR = 0x04;
const PR_CREATE_FILE = 0x08;
const PR_TRUNCATE = 0x20;
const PR_USEC_PER_MSEC = 1000;

function addDirToArchive(writer, dir, basePath) {
  let files = dir.directoryEntries;

  while (files.hasMoreElements()) {
    let file = files.getNext().QueryInterface(Ci.nsIFile);

    if (file.isHidden() ||
        file.isSymlink() ||
        file.isSpecial() ||
        file.equals(writer.file))
    {
      continue;
    }

    if (file.isDirectory()) {
      writer.addEntryDirectory(basePath + file.leafName + "/",
                               file.lastModifiedTime * PR_USEC_PER_MSEC,
                               false);
      addDirToArchive(writer, file, basePath + file.leafName + "/");
    } else {
      writer.addEntryFile(basePath + file.leafName,
                          Ci.nsIZipWriter.COMPRESSION_DEFAULT,
                          file,
                          false);
    }
  }
};

function createMiniManifest(name, version, packagePath, miniManifestFile, next) {
  File.open(miniManifestFile, "w").writeAsync(
    JSON.stringify({
      name: name,
      package_path: packagePath,
      version: version
    }, null, 2) + "\n", // prettyprint
    next);
}

function archiveDir(zipFile, dirToArchive) {
  let writer = Cc["@mozilla.org/zipwriter;1"].createInstance(Ci.nsIZipWriter);
  let file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
  file.initWithPath(zipFile);
  writer.open(file, PR_RDWR | PR_CREATE_FILE | PR_TRUNCATE);

  let dir = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
  dir.initWithPath(dirToArchive);

  addDirToArchive(writer, dir, "");

  writer.close();

  console.log("archived dir " + dirToArchive);
}

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

let PermissionSettings;
try {
  PermissionSettings =
    Cu.import("resource://gre/modules/PermissionSettings.jsm").
    PermissionSettingsModule;
} catch(e) {
  // PermissionSettings doesn't exist on Firefox 17 (and 18/19?),
  // so catch and ignore an exception importing it.
}

if (PermissionSettings) {
  PermissionSettings.addPermissionOld = PermissionSettings.addPermission;
  PermissionSettings.getPermissionOld = PermissionSettings.getPermission;

  XPCOMUtils.defineLazyServiceGetter(this,
                                     "permissionManager",
                                     "@mozilla.org/permissionmanager;1",
                                     "nsIPermissionManager");
  XPCOMUtils.defineLazyServiceGetter(this,
                                     "secMan",
                                     "@mozilla.org/scriptsecuritymanager;1",
                                     "nsIScriptSecurityManager");
  XPCOMUtils.defineLazyServiceGetter(this,
                                     "appsService",
                                     "@mozilla.org/AppsService;1",
                                     "nsIAppsService");

  PermissionSettings.addPermission = function CustomAddPermission(aData, aCallbacks) {
    console.log("PermissionSettings.addPermission " + aData.origin);

    let uri = Services.io.newURI(aData.origin, null, null);

    let action;
    switch (aData.value)
    {
      case "unknown":
        action = Ci.nsIPermissionManager.UNKNOWN_ACTION;
        break;
      case "allow":
        action = Ci.nsIPermissionManager.ALLOW_ACTION;
        break;
      case "deny":
        action = Ci.nsIPermissionManager.DENY_ACTION;
        break;
      case "prompt":
        action = Ci.nsIPermissionManager.PROMPT_ACTION;
        break;
      default:
        dump("Unsupported PermisionSettings Action: " + aData.value +"\n");
        action = Ci.nsIPermissionManager.UNKNOWN_ACTION;
    }
    console.log("PermissionSettings.addPermission add: " + aData.origin + " " + action);

    permissionManager.add(uri, aData.type, action);

    let permissions = this.permissions;
    if (!permissions[aData.origin]) {
      permissions[aData.origin] = [];
    }
    permissions[aData.origin].push(aData.type);
    this.permissions = permissions;
  };

  PermissionSettings.getPermission = function CustomGetPermission(aPermission, aManifestURL, aOrigin, aBrowserFlag) {
    console.log("getPermission: " + aPermName + ", " + aManifestURL + ", " + aOrigin);

    let uri = Services.io.newURI(aOrigin, null, null);
    let result = permissionManager.testExactPermission(uri, aPermName);

    switch (result) {
      case Ci.nsIPermissionManager.UNKNOWN_ACTION:
        return "unknown";
      case Ci.nsIPermissionManager.ALLOW_ACTION:
        return "allow";
      case Ci.nsIPermissionManager.DENY_ACTION:
        return "deny";
      case Ci.nsIPermissionManager.PROMPT_ACTION:
        return "prompt";
      default:
        dump("Unsupported PermissionSettings Action!\n");
        return "unknown";
    }
  };
}
