/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const { Class } = require("sdk/core/heritage");
const {Job, JobStep, ComposedJobStep, JobScheduler, nsSched} = require("job-scheduler");

const { ns } = require("sdk/core/namespace");

const nsSimulatorSteps = ns();

const { emit,off } = require("sdk/event/core");

exports.Ready = Class({
  name: "Ready",
  extends: JobStep,
  run: function (state,deferred) {
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
  },
  cleanup: function (state,deferred) {
    // do nothing
    deferred.resolve();
  }
});

exports.NotRunning = Class({
  name: "NotRunning",
  extends: JobStep,
  run: function (state,deferred) {
    let remoteSimulator = state.simulator.remoteSimulator;

    // TODO: remoteSimulator connecting or exiting
    if (remoteSimulator.isConnected) {
      remoteSimulator.once("exit", deferred.resolve);
      remoteSimulator.kill();
    } else {
      deferred.resolve();
    }
  },
  cleanup: function (state,deferred) {
    // do nothing
    deferred.resolve();
  }
});


exports.Lockscreen = Class({
  name: "Lockscreen",
  extends: JobStep,
  initialize: function (options) {
    this.enabled = options.enabled;
    JobStep.prototype.initialize.call(this, options);
  },
  run: function (state,deferred) {
    let remoteSimulator = state.simulator.remoteSimulator;

    // resolve on success and fail
    remoteSimulator.once("lockScreenEvent", deferred.resolve)
      remoteSimulator.lockScreen(false, function onResponse(packet) {
        if (packet.success === false)
          deferred.resolve();
      });
  },
  cleanup: function (state,deferred) {
    // do nothing
    deferred.resolve();
  }
});

exports.RunApp = Class({
  name: "RunApp",
  extends: JobStep,
  initialize: function (options) {
    this.appId = options.appId;
    this.appName = options.appName;
    JobStep.prototype.initialize.call(this, options);
  },
  run: function (state,deferred) {
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
  cleanup: function (state,deferred) {
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
  extends: JobStep,
  initialize: function (options) {
    this.appId = options.appId;
    this.manual = options.manual;
    JobStep.prototype.initialize.call(this, options);
  },
  run: function (state,deferred) {
    let appmanager = state.simulator.appmanager;
    appmanager.once("appUpdated", deferred.resolve);
    appmanager.once("error", deferred.reject);
    appmanager.injectApp(this.appId, this.manual);
  },
  cleanup: function (state,deferred) {
    // do nothing
    deferred.resolve();
  }
});

exports.UpdateRegisteredAppStatus = Class({
  name: "UpdateRegisteredAppStatus",
  extends: JobStep,
  initialize: function (options) {
    this.appId = options.appId;
    this.installed = options.installed;
    JobStep.prototype.initialize.call(this, options);
  },
  run: function (state,deferred) {
    let appmanager = state.simulator.appmanager;
    appmanager.updateAppStatus(this.appId, this.installed);
    deferred.resolve();
  },
  cleanup: function (state,deferred) {
    // do nothing
    deferred.resolve();
  }
});

let InstallApp = exports.InstallApp = Class({
  name: "InstallApp",
  extends: JobStep,
  initialize: function (options) {
    this.manifestURL = options.manifestURL;
    this.packaged = options.packaged;
    JobStep.prototype.initialize.call(this, options);
  },
  run: function (state,deferred) {
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
  },
  cleanup: function (state,deferred) {
    // do nothing
    deferred.resolve();
  }
});

exports.InstallPackagedApp = Class({
  name: "InstallPackagedApp",
  extends: JobStep,
  initialize: function (options) {
    JobStep.prototype.initialize.call(this, options);
  },
  run: function (state,deferred) {
    console.debug(this.name+": install manifestURL ", state.generatedManifestURL);
    let substep = InstallApp({manifestURL: state.generatedManifestURL, packaged: true});
    let privateJobStepAPI = nsSched(JobStep);
    try {
      privateJobStepAPI.run(substep,state).
        then(deferred.resolve,deferred.reject);
    } catch(e) {
      deferred.reject(e);
    }
  },
  cleanup: function (state,deferred) {
    deferred.resolve();
  }
});

exports.GeneratePackagedApp = Class({
  name: "GeneratedPackagedApp",
  extends: JobStep,
  initialize: function (options) {
    this.appId = options.appId;
    JobStep.prototype.initialize.call(this, options);
  },
  run: function (state, deferred) {
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
  },
  cleanup: function (state, deferred) {
    deferred.resolve();
  }
});

exports.MiniMarketServer = Class({
  name: "MiniMarketServer",
  extends: JobStep,
  initialize: function (options) {
    this.enabled = true;
  },
  run: function (state, deferred) {
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
  },
  cleanup: function (state, deferred) {
    deferred.resolve();
  }
});