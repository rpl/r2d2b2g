/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const { Class } = require("sdk/core/heritage");
const {Job, ComposedJob} = require("job-scheduler");

const { ns } = require("sdk/core/namespace");

const nsSimulatorSteps = ns();

const { emit,off } = require("sdk/event/core");

const { setTimeout, clearTimeout } = require('sdk/timers');

exports.Wait = Class({
  name: "Wait",
  description: "Waiting...",
  extends: Job,
  initialize: function (options) {
    if (!options)
      throw Error(this.name + " initialize options are mandatory");
    this.ms = options.ms;
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state, deferred) {
    this._currentTimeout = setTimeout(function () {
      deferred.resolve();
    },this.ms);
  },
  handleCancel: function (state, deferred) {
    if (this._currentTimeout) {
      clearTimeout(this._currenttimeout);
      delete this._currentTimeout;
    }
  }
});

exports.Ready = Class({
  name: "Ready",
  description: "Start FirefoxOS",
  extends: Job,
  handleRun: function (state,deferred) {
    let remoteSimulator = state.simulator.remoteSimulator;

    // TODO: remoteSimulator connecting or exiting
    if (remoteSimulator.isConnected) {
      deferred.resolve();
    } else {
      remoteSimulator.once("timeout", deferred.reject);
      remoteSimulator.once("exit", deferred.reject);
      remoteSimulator.once("ready", deferred.resolve);
      remoteSimulator.run();
    }
  }
});

exports.NotRunning = Class({
  name: "NotRunning",
  description: "Stop FirefoxOS",
  extends: Job,
  handleRun: function (state,deferred) {
    let remoteSimulator = state.simulator.remoteSimulator;

    // TODO: remoteSimulator connecting or exiting
    if (remoteSimulator.isConnected) {
      remoteSimulator.once("exit", deferred.resolve);
      remoteSimulator.kill();
    } else {
      deferred.resolve();
    }
  }
});

exports.Lockscreen = Class({
  name: "Lockscreen",
  description: "Lock/Unlock FirefoxOS Screen",
  extends: Job,
  initialize: function (options) {
    if (!options)
      throw Error(this.name + " initialize options are mandatory");
    this.enabled = options.enabled;
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state,deferred) {
    let remoteSimulator = state.simulator.remoteSimulator;

    // resolve on success and fail
    remoteSimulator.once("lockScreenEvent", deferred.resolve)
    remoteSimulator.lockScreen(this.enabled, function onResponse(packet) {
      if (packet.success === false)
        deferred.resolve();
    });
  }
});

exports.RunApp = Class({
  name: "RunApp",
  description: "Run an App on FirefoxOS",
  extends: Job,
  initialize: function (options) {
    if (!options)
      throw Error(this.name + " initialize options are mandatory");

    this.appId = options.appId;
    this.appName = options.appName;
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state,deferred) {
    let remoteSimulator = state.simulator.remoteSimulator;
    let appManager = state.simulator.appmanager;
    let appName = this.appName || appManager.apps[this.appId].name;

    state.runAppEventListener = function listener(packet) {
      remoteSimulator.off("windowManagerEvent", listener);
      if (packet.event === "appopen" && packet.name === appName) {
        deferred.resolve();
      }
    };
    remoteSimulator.on("windowManagerEvent", state.runAppEventListener);
    remoteSimulator.runApp(appName, function onResponse(packet) {
      if (packet.success === false)
        deferred.reject("failed runApp cmd: "+packet.message);
    });
  },
  handleCancel: function (state,deferred) {
    let remoteSimulator = state.simulator.remoteSimulator;
    if (state.runAppEventListener) {
      remoteSimulator.off("windowManagerEvent", state.runAppEventListener);
      delete state.runAppEventListener;
    }

    deferred.resolve();
  }
});

exports.InjectHostedGeneratedApp = Class({
  name: "InjectHostedGeneratedApp",
  description: "Inject a Generate Hosted App",
  extends: Job,
  initialize: function (options) {
    if (!options)
      throw Error(this.name + " initialize options are mandatory");

    this.appId = options.appId;
    this.manual = options.manual;
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state,deferred) {
    let appmanager = state.simulator.appmanager;
    appmanager.once("appUpdated", deferred.resolve);
    appmanager.once("error", deferred.reject);
    appmanager.injectApp(this.appId, this.manual);
  }
});

exports.UpdateRegisteredAppStatus = Class({
  name: "UpdateRegisteredAppStatus",
  description: "Update Registered App Status",
  extends: Job,
  initialize: function (options) {
    if (!options)
      throw Error(this.name + " initialize options are mandatory");

    this.appId = options.appId;
    this.installed = options.installed;
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state,deferred) {
    let appmanager = state.simulator.appmanager;
    appmanager.updateAppStatus(this.appId, this.installed);
    deferred.resolve();
  }
});

let InstallApp = exports.InstallApp = Class({
  name: "InstallApp",
  extends: Job,
  description: "Install an App on  FirefoxOS",
  initialize: function (options) {
    if (!options)
      throw Error(this.name + " initialize options are mandatory");

    this.manifestURL = options.manifestURL;
    this.packaged = options.packaged;
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state,deferred) {
    let remoteSimulator = state.simulator.remoteSimulator;

    remoteSimulator.once("installAppEvent", function (packet) {
      if (packet.success) {
        deferred.resolve();
      } else {
        // TODO: add error
        deferred.reject("failed installApp cmd");
      }
    });
    remoteSimulator.installApp(this.manifestURL,
                               this.packaged,
                               function onResponse(packet) {
                                 if (packet.success === false)
                                   deferred.reject("failed installApp cmd: "+
                                                   packet.message);
                               });
  }
});

exports.InstallPackagedApp = Class({
  name: "InstallPackagedApp",
  description: "Install a Packaged App on FirefoxOS",
  extends: Job,
  initialize: function (options) {
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state,deferred) {
    console.debug(this.name+": install manifestURL ", state.generatedManifestURL);
    let substep = InstallApp({manifestURL: state.generatedManifestURL, packaged: true});
    try {
      substep.run(state).
        then(function () {
          if (substep.success) {
            deferred.resolve()
          } else {
            deferred.reject(substep.error);
          }
        });
    } catch(e) {
      deferred.reject(e);
    }
  }
});

exports.GeneratePackagedApp = Class({
  name: "GeneratedPackagedApp",
  description: "Generate Assets for a Packaged App",
  extends: Job,
  initialize: function (options) {
    if (!options)
      throw Error(this.name + " initialize options are mandatory");

    this.appId = options.appId;
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state, deferred) {
    let appmanager = state.simulator.appmanager;
    let {appId} = this;

    appmanager.once("appPackaged", function (manifestURL) {
      state.generatedManifestURL = manifestURL;
      deferred.resolve();
    });
    appmanager.once("error", deferred.reject);
    try {
      let running = appmanager.generatePackagedAppAssets(appId);
      if (!running) deferred.reject("generatePackagedAppAssets returned false");
    } catch(e) {
      deferred.reject(e);
    }
  }
});

exports.MiniMarketServer = Class({
  name: "MiniMarketServer",
  description: "Start/Stop a MiniMarketServer",
  extends: Job,
  initialize: function (options) {
    this.enabled = true;
    Job.prototype.initialize.call(this, options);
  },
  handleRun: function (state, deferred) {
    let appmanager = state.simulator.appmanager;

    if (this.enabled) {
      if (!appmanager.isHTTPServerRunning) {
        appmanager.startHTTPServer();
        deferred.resolve();
      } else {
        deferred.resolve();
      }
    } else {
      if (appmanager.isHTTPServerRunning) {
        appmanager.stopHTTPServer();
        deferred.resolve();
      } else {
        deferred.resolve();
      }
    }
  }
});
