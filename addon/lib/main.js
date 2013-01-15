/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. 
 */

const { Cc, Ci, Cr, Cu } = require("chrome");

const Widget = require("widget").Widget;
const Self = require("self");
const URL = require("url");
const Runtime = require("runtime");
const Tabs = require("tabs");
const PageMod = require("page-mod").PageMod;
const UUID = require("sdk/util/uuid");
const File = require("file");
const Menuitems = require("menuitems");
const Prefs = require("preferences-service");
const Subprocess = require("subprocess");
const ContextMenu = require("context-menu");
const Request = require('request').Request;
const Notifications = require("notifications");
const SStorage = require("simple-storage");
const WindowUtils = require("window/utils");
const Gcli = require('gcli');

const xulapp = require("sdk/system/xul-app");
// NOTE: detect is developer toolbox feature can be enabled
const HAS_DEVELOPER_TOOLBOX = xulapp.is("Firefox") &&
  xulapp.versionInRange(xulapp.platformVersion, "20.0a1", "*");

console.debug("XULAPP: ",xulapp.name,xulapp.version,xulapp.platformVersion);
console.debug("HAS_DEVELOPER_TOOLBOX: ",HAS_DEVELOPER_TOOLBOX);

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");

require("addon-page");

const RemoteSimulatorClient = require("remote-simulator-client");

const AppManager = require("app-manager");

const { defer } = require('api-utils/promise');


let simulator = {
  _worker: null,
  _appmanager: null,

  get definedJobSteps() {
    return require("simulator-steps");
  },

  get jobScheduler() {
    if (this._jobScheduler)
      return this._jobScheduler;

    this._jobScheduler = require("job-scheduler").JobScheduler({
      state: { simulator: simulator },
      onProgress: function (data) {
        console.debug("PROGRESS", data.job.toString(), JSON.stringify(data.progress));

        if (data.progress.success == false) {
          console.error("PROGRESS ERROR", data.progress.error,
                        data.progress.error.fileName,
                        data.progress.error.lineNumber);
        }
      },
      onPushed: function() {
        this.processQueue();
      },
      onCompleted: function() {
        this.processQueue();
      }
    });

    let processQueue = this._jobScheduler.processQueue;

    return this._jobScheduler;
  },

  runApp: function (appName) {
    let js = this.jobScheduler;
    let ds = this.definedJobSteps;

    js.enqueueJob({
      steps: [
        ds.Ready(),
        ds.Lockscreen({enabled: true}),
        ds.RunApp({appName: appName}),
      ]
    });
  },

  installApp: function(app) {
    let js = this.jobScheduler;
    let ds = this.definedJobSteps;
    let job = null;

    console.log("main.js: installApp", app.id, app.type);

    switch (app.type) {
    case "hosted":
      job = js.enqueueJob({
        steps: [
          ds.Ready(),
          ds.Lockscreen({enabled: false}),
          ds.InstallApp({manifestURL: app.manifestURL}),
          ds.UpdateRegisteredAppStatus({appId: app.id, installed: true}),
        ]
      });
      break;
    case "hosted_generated":
      job = js.enqueueJob({
        steps: [
          ds.NotRunning(),
          ds.InjectHostedGeneratedApp({appId: app.id, manual: true}),
          ds.UpdateRegisteredAppStatus({appId: app.id, installed: true}),
        ]
      });
      break;
    case "packaged":
      try {
      job = js.enqueueJob({
        completed: function (job) {
          if (job.success) {
            console.log("JOB COMPLETED");
          } else {
            console.error("JOB ERROR",job.error, job.error.lineNumber, job.error.fileName);
            simulator.error(job.error);
          }
        },
        steps: [
          ds.MiniMarketServer({enabled: true}),
          ds.Ready(),
          ds.Lockscreen({enabled: false}),
          ds.GeneratePackagedApp({appId: app.id}),
          ds.InstallPackagedApp(),
          ds.UpdateRegisteredAppStatus({appId: app.id, installed: true}),
        ]
      });
      }catch(e) {
        console.error("JOB QUEUE ERROR", e, e.fileName, e.lineNumber);
      }
      break;
    }

    if (job) {

    } else {
      // TODO
    }
  },

  get appmanager() {
    if (this._appmanager)
      return this._appmanager;

    this._appmanager = new AppManager({
      onError: (function (e) { this.error(e.message); }).bind(this),
      onInfo:  (function (e) { this.info(e.message); }).bind(this)
    });

    this._appmanager.on("appListUpdated", (function () {
      console.log("RECEIVED appListUpdated");
      this.sendListApps();
    }).bind(this));

    this._appmanager.on("appUpdated", (function (id) {
      console.log("RECEIVED appUpdated",id);
      let appName = simulator.appmanager.apps[id].name;
      simulator.runApp(appName);
    }).bind(this));

    this._appmanager.on("appRegistered", (function (app) {
      console.log("RECEIVED appRegistered",app.id);
      this.installApp(app);
    }).bind(this));

    return this._appmanager;
  },

  get jsConsoleEnabled() {
    return Prefs.get("extensions.r2d2b2g.jsconsole", false);
  },

  get worker() this._worker,

  set worker(newVal) {
    this._worker = newVal;

    if (this._worker) {
      this._worker.on("message", this.onMessage.bind(this));
      this._worker.on("detach",
                     (function(message) this._worker = null).bind(this));
    }
  },

  get contentPage() Self.data.url("content/index.html"),

  get contentScript() Self.data.url("content-script.js"),

  /**
   * Installs the web page in the active tab as if it was an app.
   */
  addActiveTab: function() {
    console.log("Simulator.addActiveTab");
    this.addAppByTabUrl(Tabs.activeTab.url);
  },

  addAppByDirectory: function() {
    console.log("AppManager.addAppByDirectory");

    Cu.import("resource://gre/modules/Services.jsm");
    let win = Services.wm.getMostRecentWindow("navigator:browser");

    let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    fp.init(win, "Select a Web Application Manifest", Ci.nsIFilePicker.modeOpen);
    fp.appendFilter("Webapp Manifest", "*.webapp");
    fp.appendFilters(Ci.nsIFilePicker.filterAll);

    let ret = fp.show();
    if (ret == Ci.nsIFilePicker.returnOK || ret == Ci.nsIFilePicker.returnReplace) {
      let webappFile = fp.file.path;
      console.log("Selected " + webappFile);
      let webapp;
      try {
        webapp = JSON.parse(File.read(webappFile));
      } catch (e) {
        console.error("Error loading " + webappFile, e);
        emit(this, "error", {
          message: "Could not load " + webappFile + " (" + e.name + ")"
        });
        return;
      }

      console.log("Loaded " + webapp.name);

      let icon = null;
      let size = Object.keys(webapp.icons).sort(function(a, b) b - a)[0] || null;
      if (size) {
        icon = webapp.icons[size];
      }

      //let apps = this.appmanager.apps;
      //apps[webappFile] = {
      let app = {
        type: "local",
        xid: null,
        xkey: null,
        name: webapp.name,
        icon: icon,
        manifest: webapp,
      }
      console.log("will be Stored " + JSON.stringify(app));

      this.appmanager.registerApp({
        type: "packaged",
        manifestPath: webappFile,
        icon: icon,
        manifest: webapp
      });
      //this.installManifestPackage(webapp.name, webapp.version, webappFile);
      //this.appmanager.updateApp(webappFile, true);
    }
  },

  /**
   * Installs the web page in the active tab as if it was an app.
   */
  addAppByTabUrl: function(tabUrl, force) {
    console.log("Simulator.addAppByTabUrl " + tabUrl);
    let url = URL.URL(tabUrl);
    let found = false;
    let tab = null;
    let title = null;
    for each (tab in Tabs) {
      if (tab.url == tabUrl) {
        found = true;
        break;
      }
    }
    if (!found) {
      console.error("Could not find tab");
      title = url.host;
      if (!force) {
        this.validateUrl(tabUrl, function(err) {
          if (err) {
            simulator.addAppByTabUrl(tabUrl, true);
          } else {
            simulator.addManifestURL(tabUrl);
          }
        });
        return;
      }
    } else {
      title = tab.title || url.host;
    }
    let origin = url.toString().substring(0, url.lastIndexOf(url.path));

    let manifestURL = URL.URL(origin + "/" + "manifest.webapp");
    let webapp = {
      name: title.substring(0, 18),
      description: title,
      default_locale: "en",
      launch_path: url.path || '/',
      origin: origin
    };
    console.log("Generated manifest " + JSON.stringify(webapp, null, 2));
    // Possible icon? 'http://www.google.com/s2/favicons?domain=' + url.host
    this.appmanager.registerApp({
      type: "hosted_generated",
      manifestURL: manifestURL,
      manifest: webapp,
    });
    //this.appmanager.addManifest(manifestURL, webapp, origin, true);
  },

  addManifestURL: function(manifestURL) {
    console.log("Simulator.addManifestURL " + manifestURL);

    //this.installManifestURL(manifestURL);

    //return;

    Request({
      url: manifestURL.toString(),
      onComplete: function (response) {
        if (response.status != 200) {
          simulator.error("Unexpected status code " + response.status);
          return
        }
        if (!response.json) {
          simulator.error("Expected JSON response.");
          return;
        }
        if (!response.json.name || !response.json.description) {
          simulator.error("Missing mandatory property (name or description)");
          return;
        }

        let contentType = response.headers["Content-Type"];
        if (contentType !== "application/x-web-app-manifest+json") {
          console.warn("Unexpected Content-Type: " + contentType + ".");
        }

        console.log("Fetched manifest " + JSON.stringify(response.json, null, 2));

        console.debug("URL: ",JSON.stringify(URL.URL(manifestURL)));

        let url = URL.URL(manifestURL);

        simulator.appmanager.registerApp({
          type: "hosted",
          manifestURL: manifestURL,
          manifest: response.json,
          origin: url.scheme+"://"+url.host+( url.port ? ":"+url.port : "")
        });
        //simulator.appmanager.addManifest(manifestURL, response.json);
      }
    }).get();
  },

  validateUrl: function(url, cb) {
    console.log("Simulator.validateUrl " + url);

    Request({
      url: url,
      onComplete: function (response) {
        var err = null;
        if (response.status != 200) {
          err = "Unexpected status code " + response.status;
        } else if (!response.json) {
          err = "Expected JSON response";
        } else {
          let contentType = response.headers["Content-Type"];
          if (contentType !== "application/x-web-app-manifest+json") {
            console.warn("Unexpected Content-Type " + contentType);
          }
        }

        if (err) {
          console.error(err);
        }
        if (cb) {
          cb(err);
        } else {
          simulator.worker.postMessage({
            name: "validateUrl",
            err: err,
          });
        }
      }
    }).get();
  },

  sendListApps: function() {
    console.log("Simulator.sendListApps");
    this.worker.postMessage({
      name: "listApps",
      list: simulator.appmanager.apps,
      defaultApp: simulator.appmanager.defaultApp
    });
  },

  sendListTabs: function() {
    var tabs = {};
    for each (var tab in Tabs) {
      if (!tab.url || !(/^https?:/).test(tab.url)) {
        continue;
      }
      tabs[tab.url] = tab.title;
    }
    this.worker.postMessage({
      name: "listTabs",
      list: tabs
    });
  },

  openTab: function(url, lax) {
    for each (var tab in Tabs) {
      if (tab.url === url || (lax && tab.url.indexOf(url) === 0)) {
        tab.activate();
        return;
      }
    }

    Tabs.open({
      url: url
    });
  },

  openHelperTab: function() {
    this.openTab(simulator.contentPage, true);
  },

  revealApp: function(id) {
    let config = this.appmanager.apps[id];
    if (!config) {
      return;
    }
    switch (config.type) {
      case "packaged":
        let manifestFile = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        manifestFile.initWithPath(config.revealUrl);
        try {
          manifestFile.reveal();
        } catch (e) {
          this.error("Could not open " + id);
        }
        break;
      case "hosted_generated":
        this.openTab(config.revealUrl);
        break;
      case "hosted":
        this.openTab(config.revealUrl);
        break;
    }
  },

  getPreference: function() {
    this.worker.postMessage({
      name: "setPreference",
      key: "jsconsole",
      value: simulator.jsConsoleEnabled
    });
  },

  run: function () {
    let { promise, resolve, reject } = defer();

    if (this.isRunning) {
      resolve();
    } else {
      let appName = null;
      if (this.appmanager.defaultApp) {
        appName = this.appmanager.apps[this.appmanager.defaultApp].name
        this.appmanager.defaultApp = null;
      }

      this.remoteSimulator.once("ready", resolve);
      this.remoteSimulator.once("timeout", reject);
      this.remoteSimulator.run({
        defaultApp: appName
      });
    }

    return promise;
  },

  kill: function() {
    let { promise, resolve, reject } = defer();

    if (this.remoteSimulator.isRunning) {
      this.remoteSimulator.once("exit", resolve);
      this.remoteSimulator.kill();
    } else {
      resolve();
    }

    return promise;
  },

  get isRunning() {
    return this.remoteSimulator.isRunning;
  },
  
  get remoteSimulator() {
    if (this._remoteSimulator)
      return this._remoteSimulator;

    let simulator = this;
    let remoteSimulator = new RemoteSimulatorClient({
      onStdout: function (data) dump(data),
      onStderr: function (data) dump(data),
      onReady: function () {
        if (simulator.worker) {
          simulator.worker.postMessage({
            name: "isRunning",
            isRunning: true
          });

          // refresh installed apps status
          remoteSimulator.getInstalledApps(function (packet) {
            console.log("GET INSTALLED APPS CMD:", JSON.stringify(packet));
          });
        }
      },
      onExit: function () {
        if (simulator.worker) {
          simulator.worker.postMessage({
            name: "isRunning",
            isRunning: false
          });
        }
      }
    });
    
    remoteSimulator.on("getInstalledAppsEvent", function (packet) {
      console.log("INSTALLED APPS:",JSON.stringify(packet));
    });

    this._remoteSimulator = remoteSimulator;
    return remoteSimulator;
  },

  connectRemoteDeveloperToolbox: function() {
    console.debug("Simulator.connectRemoteDeveloperToolbox");
    this.remoteSimulator.connectDeveloperTools();
  },

  onMessage: function onMessage(message) {
    console.log("Simulator.onMessage " + message.name);
    switch (message.name) {
      case "getHasDeveloperToolbox":
        if (HAS_DEVELOPER_TOOLBOX) {
          simulator.worker.postMessage({
            name: "getHasDeveloperToolbox",
            enabled: true
          });
        } else {
          simulator.worker.postMessage({
            name: "getHasDeveloperToolbox",
            enabled: false
          });
        }
        break;
      case "connectRemoteDeveloperToolbox":
        this.connectRemoteDeveloperToolbox()
        break;
      case "getIsRunning":
        this.worker.postMessage({ name: "isRunning",
                                  isRunning: this.isRunning });
        break;
      case "addAppByDirectory":
        simulator.addAppByDirectory();
        /*this.kill().then(function() {
          simulator.addAppByDirectory();
        });*/
        break;
      case "addAppByTab":
        simulator.addAppByTabUrl(message.url);
        /*this.kill().then(function() {
          simulator.addAppByTabUrl(message.url);
        });*/
        break;
      case "listApps":
        if (message.flush) {
          this.appmanager.flushRemovedApps();
        }
        this.sendListApps();
        break;
      case "updateApp":
        this.kill().then(function() {
          simulator.appmanager.updateApp(message.id, true);
        });
        break;
      case "runApp":
        let appName = simulator.appmanager.apps[message.id].name;
        simulator.runApp(appName);
        break;
      case "installApp":
        let app = simulator.appmanager.apps[message.id];
        simulator.installApp(app);
        break;
      case "removeApp":
        this.appmanager.removeApp(message.id);
        break;
      case "revealApp":
        this.revealApp(message.id);
        break;
      case "undoRemoveApp":
        this.appmanager.undoRemoveApp(message.id);
        break;
      case "setDefaultApp":
        if (!message.id || message.id in this.appmanager.apps) {
          this.appmanager.defaultApp = message.id;
          this.sendListApps();
        }
        break;
      case "setPreference":
        console.log(message.key + ": " + message.value);
        Prefs.set("extensions.r2d2b2g." + message.key, message.value);
      case "getPreference":
        simulator.getPreference();
        break;
      case "toggle":
        if (this.isRunning) {
          this.kill();
        } else {
          this.run();
        }
        break;
      case "listTabs":
        simulator.sendListTabs();
        break;
      case "validateUrl":
        simulator.validateUrl(message.url);
        break;
      /*
      case "create":
        create();
        break;
      */
    }
  },

  info: function(msg) {
    // let window = WindowUtils.getMostRecentBrowserWindow();
    // let nb = window.gBrowser.getNotificationBox();
    // nb.appendNotification(
    //   msg,
    //   "simulator-info",
    //   null,
    //   nb.PRIORITY_INFO_MEDIUM,
    //   null
    // );
  },

  error: function(msg) {
    let window = WindowUtils.getMostRecentBrowserWindow();
    let nb = window.gBrowser.getNotificationBox();
    nb.appendNotification(
      msg,
      "simulator-error",
      null,
      nb.PRIORITY_WARNING_MEDIUM,
      null
    );
  }

};

PageMod({
  include: simulator.contentPage,
  contentScriptFile: simulator.contentScript,
  contentScriptWhen: 'start',
  onAttach: function(worker) {
    // TODO: Only allow 1 manager page
    simulator.worker = worker;
  },
});

//Widget({
//  id: "r2d2b2g",
//  label: "r2d2b2g",
//  content: "r2d2b2g",
//  width: 50,
//  onClick: function() {
//    Tabs.open({
//      url: Self.data.url("content/index.html"),
//      onReady: function(tab) {
//        let worker = tab.attach({
//          contentScriptFile: Self.data.url("content-script.js")
//        });
//        worker.on("message", function(data) {
//          switch(data) {
//            case "run":
//              simulator.run();
//              worker.postMessage("B2G was started!");
//              break;
//          }
//        });
//      }
//    });
//    return;
//
//  }
//});

switch (Self.loadReason) {
  case "install":
    simulator.openHelperTab();
    break;
  case "downgrade":
  case "upgrade":
    simulator.updateAll();
    break;
}

exports.onUnload = function(reason) {
  simulator.kill();
};

Tabs.on('ready', function() {
  if (simulator.worker) {
    simulator.sendListTabs();
  }
});
Tabs.on('close', function() {
  // Kill process when the last tab is gone
  if (!Tabs.length) {
    simulator.kill();
  }
  if (simulator.worker) {
    simulator.sendListTabs();
  }
});

ContextMenu.Item({
  label: "Install Manifest as Firefox OS App",
  context: ContextMenu.SelectorContext("a"),
  contentScript: 'self.on("context", function (node) {' +
                 '  return /\\.webapp$/.test(node.href);' +
                 '});' +
                'self.on("click", function (node, data) {' +
                 '  self.postMessage(node.href)' +
                 '});',
  onMessage: function (manifestURL) {
    simulator.addManifestURL(URL.URL(manifestURL));
  },
});

Menuitems.Menuitem({
  id: "webdevFxOSSimulatorHelper",
  menuid: "menuWebDeveloperPopup",
  insertbefore: "devToolsEndSeparator",
  label: "Firefox OS Simulator",
  onCommand: function() {
    simulator.openHelperTab();
  },
});

Menuitems.Menuitem({
  id: "appmenu_fxossimulator",
  menuid: "appmenu_webDeveloper_popup",
  insertbefore: "appmenu_devToolsEndSeparator",
  label: "Firefox OS Simulator",
  onCommand: function() {
    simulator.openHelperTab();
  },
});

Gcli.addCommand({
  name: 'firefoxos',
  description: 'Commands to control Firefox OS Simulator',
});

Gcli.addCommand({
  name: "firefoxos manager",
  description: "Open the Firefox OS Simulator Manager",
  params: [],
  exec: function(args, context) {
    simulator.openHelperTab();
  },
});

Gcli.addCommand({
  name: "firefoxos start",
  description: "Start Firefox OS Simulator (restarts if running)",
  params: [],
  exec: function(args, context) {
    simulator.run();
  },
});

Gcli.addCommand({
  name: "firefoxos stop",
  description: "Stop Firefox OS Simulator",
  params: [],
  exec: function(args, context) {
    if (simulator.isRunning) {
      simulator.kill();
    }
  },
});

Gcli.addCommand({
  name: "firefoxos devtools",
  description: "Connect DevTools to Simulator",
  params: [],
  exec: function(args, context) {
    simulator.connectRemoteDeveloperToolbox()
  },
});


// Menuitems.Menuitem({
//   id: "launchB2G",
//   menuid: "menu_ToolsPopup",
//   insertbefore: "sanitizeSeparator",
//   label: "Launch B2G Desktop",
//   onCommand: function() {
//     simulator.run();
//   },
// });

// Menuitems.Menuitem({
//   id: "appifyPage",
//   menuid: "menu_ToolsPopup",
//   insertbefore: "sanitizeSeparator",
//   label: "Install Page in FxOS Simulator",
//   onCommand: function() {
//     simulator.addActiveTab();
//   },
// });